// Copyright 2026 YourLocalGoober
//
// This file is part of GooberCord.
//
// GooberCord is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>

// The live chat lane — the message column, the composer well, the riders,
// and the voice control plane (the brief's W-R1 named chat + composer).
// Routes: "channel" (/s/:sid/:cid), "conversation" (/dm/:id re-registered),
// "channel-pins", "server-search". The contract laws ride every row:
//   G-7  the compose riders are the ONLY icon buttons in the chat surface;
//        row actions are hover-revealed quiet controls.
//   G-9  socket drop → store "connection": "reconnecting"; the composer
//        keeps its drafts (sessionStorage per channel); failures keep their
//        error state with an explicit retry — never an auto-resend.
//   G-12 optimistic sends reconcile by message id; clientMessageId rides
//        only the way in; POST-then-WS and WS-then-POST dedupe by id (and
//        an early WS frame dedupes by author+body+10s when no id matches).
//   B1b  every upload lands status "pending": the composer previews the
//        LOCAL file; message renders fail soft on a 404 attachment (a quiet
//        "under review" placeholder, never a broken image).
//   A6   the mention highlighter reproduces the backend parser (position
//        walk pinned by behavior tests against api/mentions.mjs itself);
//        expression tokens resolve against the history payload's
//        expressions; unresolvable tokens render as literal text.
// Voice: control plane only (join/leave/mute, roster, the coin tick) — the
// binary opus plane rides the DO voice relay wave (documented in ws.js).
import { h } from "../core/dom.js";
import { t } from "../i18n.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { openDialog } from "../vendor/frontload/dom.mjs";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { guardRulesGate } from "./rules-gate.js";
import { loadConversations, manageGroupControls } from "./social.js";
import { startVoiceTicks } from "./economy.js";
import { getChannelSocket, closeChannelSocket, makeClientMessageId } from "../core/ws.js";

// --- mirrored constants (G-4: equality pins against constants.mjs) -----------

export const UI_FREE_MESSAGE_MAX = 2000;
export const UI_PLUS_MESSAGE_MAX = 4000;
export const UI_METER_REVEAL_AT = 1800; // Rethink 8: the meter appears past 1800 chars
export const UI_GIF_QUERY_MAX = 64;
export const UI_GIF_PAGE_DEFAULT = 12;
export const UI_GIF_PAGE_MAX = 24;
export const UI_ATTACHMENT_FREE_MAX = 20971520; // MAX_ATTACHMENT_BYTES
export const UI_ATTACHMENT_MINI_MAX = 52428800; // GC_MINI_ATTACHMENT_BYTES
export const UI_ATTACHMENT_PLUS_MAX = 1073741824; // GC_PLUS_ATTACHMENT_BYTES
export const UI_REACTIONS_COMMON = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥"];
export const UI_REACTIONS_SUPER = ["✨", "💫", "🌟", "🎆", "🎇", "🌈", "🪄", "🩷"]; // GC_PLUS_REACTIONS
export const UI_VOICE_MAX_PARTICIPANTS = 6; // GC_VOICE_MAX_PARTICIPANTS (the join button says "Full")

// --- the store lanes -----------------------------------------------------------

const messagesKey = (channelId) => `messages:${channelId}`;
const expressionsKey = (serverId) => `chat-inventories:${serverId}`;
const voiceKey = (channelId) => `voice:${channelId}`;
// The WS presence frame's lane (an ARRAY). NEVER `roster:` — that namespace
// is members.js's /roster ENVELOPE alone, and channel ids and server ids
// come from independent counters, so the ids collide on the same number.

export function messagesOf(channelId) {
  return store.get(messagesKey(channelId)) || null;
}

// loadHistory(channelId, after?) — tail read (no `after`) auto-ACKs the
// member's own read marker server-side; catch-up rides `after`.
export async function loadHistory(channelId, after = null, limit = 50) {
  const path = after
    ? `/api/channels/${channelId}/messages?limit=${limit}&after=${after}`
    : `/api/channels/${channelId}/messages?limit=${limit}`;
  const payload = await api(path);
  const prior = store.get(messagesKey(channelId)) || { list: [], oldestAfter: null };
  const seen = new Set(prior.list.map((message) => message.id));
  const fresh = payload.messages.filter((message) => !seen.has(message.id));
  // History reads id DESC; the column renders ASC after the merge.
  const list = after
    ? [...fresh, ...prior.list] // an older page PREPENDS
    : [...fresh].sort((a, b) => a.id - b.id); // a tail read replaces the seat
  store.set({
    [messagesKey(channelId)]: {
      list,
      oldestAfter: payload.nextAfter ?? null,
      complete: payload.nextAfter == null,
    },
  });
  if (payload.expressions) store.set({ [expressionsKey(channelIdOf(channelId))]: payload.expressions });
  return payload;
}

// The server id rides the route, not the message; the channel's server
// comes from the active route lane.
let currentServerId = null;
function channelIdOf() {
  return currentServerId;
}

// adoptMessage(channelId, message) — the reconcile HALF (G-12): keyed by id
// (a replayed frame or the POST echo inserts nothing), with the early-frame
// fallback (author === me, same body, within 10s) that adopts the real id
// when the POST resolution lands later.
export function adoptMessage(channelId, message, me, pending) {
  const prior = store.get(messagesKey(channelId))
    || { list: [], oldestAfter: null, complete: false };
  if (prior.list.some((entry) => entry.id === message.id)) return null;
  const now = Date.now();
  // The deterministic arm first (G-12): the POST resolves with the
  // clientMessageId it rode — the pending row keyed by it swaps seats.
  const keyed = typeof pending === "string"
    ? prior.list.find((entry) => entry.pending && entry.pendingId === pending)
    : undefined;
  // The early-frame arm: a WS frame for one's OWN message arrived before
  // the POST resolved — same body, author === me, within 10s.
  const early = keyed ?? (!!(me && message.authorId === me.id)
    ? prior.list.find((entry) => entry.pending
      && entry.body === message.body
      && (!entry.pendingAuthor || entry.pendingAuthor === message.authorId)
      && now - entry.pendingAt < 10000)
    : undefined);
  let list;
  if (early) {
    // The WS frame arrived before the POST: swap the pending row's seat.
    list = prior.list.map((entry) => (entry === early ? { ...message } : entry));
  } else {
    list = [...prior.list, { ...message }].sort((a, b) => a.id - b.id);
  }
  store.set({ [messagesKey(channelId)]: { ...prior, list } });
  return message;
}

// --- the send flow (G-12 + the rules-gate WS arm) ------------------------------

// sendToChannel(channelId, body, options {clientMessageId, imageFile}):
// builds the optimistic row keyed by clientMessageId, rides the REST POST,
// and reconciles on the response. Failed sends keep their error state with
// an explicit retry control (G-9).
export async function sendToChannel(channelId, body, { imageFile, clientMessageId } = {}) {
  const me = store.get("user");
  const clientMessageId_ = clientMessageId || makeClientMessageId();
  const prior = store.get(messagesKey(channelId)) || { list: [], oldestAfter: null, complete: false };
  const pending = {
    id: null,
    pending: true,
    pendingId: clientMessageId_,
    pendingAuthor: me?.id,
    pendingAt: Date.now(),
    authorId: me?.id,
    authorName: me?.username,
    body,
    editedAt: null,
    attachmentIds: imageFile ? [] : [],
    localFile: imageFile || null,
    source: "web",
    isPlus: !!me?.isPlus,
  };
  store.set({ [messagesKey(channelId)]: { ...prior, list: [...prior.list, pending].sort((a, b) => (a.id ?? 1e15) - (b.id ?? 1e15)) } });
  try {
    let payload;
    if (imageFile) {
      const data = new FormData();
      data.append("image", imageFile);
      data.append("body", body);
      data.append("clientMessageId", clientMessageId_);
      payload = await api(`/api/channels/${channelId}/messages`, { method: "POST", body: data });
    } else {
      payload = await api(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: { body, clientMessageId: clientMessageId_ },
      });
    }
    adoptMessage(channelId, payload.message, me, clientMessageId_);
    return payload.message;
  } catch (error) {
    // The pending row carries the error inline (G-2) with its own retry.
    const after = store.get(messagesKey(channelId))
      || { list: [], oldestAfter: null, complete: false };
    store.set({
      [messagesKey(channelId)]: {
        ...after,
        list: after.list.map((entry) => (entry.pendingId === clientMessageId_
          ? { ...entry, sendError: error.message, retryAfter: error.retryAfter || null }
          : entry)),
      },
    });
    throw error;
  }
}

// retryFailed(channelId, row) — the explicit retry commit: a fresh
// clientMessageId, the same body/file. Never automatic (G-9).
export async function retryFailed(channelId, row) {
  dropPendingRow(channelId, row.pendingId);
  return sendToChannel(channelId, row.body, { imageFile: row.localFile || undefined });
}

function dropPendingRow(channelId, pendingId) {
  const prior = store.get(messagesKey(channelId))
    || { list: [], oldestAfter: null, complete: false };
  store.set({
    [messagesKey(channelId)]: {
      ...prior,
      list: prior.list.filter((entry) => entry.pendingId !== pendingId),
    },
  });
}

// --- the writes ------------------------------------------------------------------

export async function toggleReaction(messageId, emoji) {
  return api(`/api/messages/${messageId}/reactions`, {
    method: "PUT", body: { emoji },
  });
}

// The default arm removes MY OWN row; the mod arm rides ?user_id=<other> and
// needs the moderation guard server-side (the shared 403s render verbatim).
export async function removeReaction(messageId, emoji, userId = null) {
  const path = userId
    ? `/api/messages/${messageId}/reactions?user_id=${userId}`
    : `/api/messages/${messageId}/reactions`;
  return api(path, { method: "DELETE", body: { emoji } });
}

export async function viewReactions(messageId) {
  return api(`/api/messages/${messageId}/reactions`);
}

export async function setPin(messageId, pinned) {
  return api(`/api/messages/${messageId}/pin`, { method: pinned ? "PUT" : "DELETE" });
}

export async function editMessage(messageId, body) {
  return api(`/api/messages/${messageId}`, { method: "PATCH", body: { body } });
}

export async function deleteMessage(messageId) {
  return api(`/api/messages/${messageId}`, { method: "DELETE" });
}

export async function loadPins(channelId) {
  return api(`/api/channels/${channelId}/pins`);
}

export async function searchServer(serverId, term, channel = null) {
  const params = new URLSearchParams({ q: term });
  if (channel) params.set("channel", String(channel));
  return api(`/api/servers/${serverId}/search?${params.toString()}`);
}

export async function searchGifs(query, { position = null, limit = UI_GIF_PAGE_DEFAULT } = {}) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (position) params.set("position", position);
  return api(`/api/gifs/search?${params.toString()}`);
}

// The GIF display is ALWAYS the same-origin proxy — never a tenor.com URL
// in any <img> (the CSP is default-src 'self'); insertion pins the plain
// proxied URL as the body text (no markdown invented).
export function gifProxyUrl(remoteUrl) {
  return `/api/gifs/image?u=${encodeURIComponent(remoteUrl)}`;
}

// --- read markers --------------------------------------------------------------------

// The explicit read marker for conversation channels: forward-only (the
// newest id the client ACKed rides the module's own seat — a stale or
// repeated marker never goes out, so the server's behind-400 stays theory).
const ackedReads = new Map();
export async function markRead(conversationId, messageId) {
  const previous = ackedReads.get(conversationId) ?? 0;
  if (!(messageId > previous)) return false;
  ackedReads.set(conversationId, messageId);
  try {
    await api(`/api/conversations/${conversationId}/read`, {
      method: "POST", body: { messageId },
    });
  } catch { /* the 400 keeps the marker — forward-only holds */ }
  return true;
}

// --- the mention highlighter (parity by construction: position walk over
// the SAME regexes the backend keeps in api/mentions.mjs; the resolved-id
// behavior is pinned by test against that module) ------------------------------------

const CANDIDATE_RE = /@[A-Za-z0-9_][A-Za-z0-9_ .-]{1,31}/g;
const EVERYONE_RE = /(^|[^A-Za-z0-9_])@everyone(?![A-Za-z0-9_])/i;
const HERE_RE = /(^|[^A-Za-z0-9_])@here(?![A-Za-z0-9_])/i;
const EXPRESSION_RE = /<([es]):([A-Za-z0-9_]+):([1-9][0-9]*)>/g;

function memberMatches(member, lower) {
  const nickname = typeof member?.nickname === "string" ? member.nickname.trim().toLowerCase() : "";
  if (nickname.length > 0 && nickname === lower) return true;
  return String(member?.username || "").toLowerCase() === lower;
}

export function mentionSpans(text, members) {
  const roster = Array.isArray(members) ? members : [];
  const spans = [];
  for (const match of String(text).matchAll(CANDIDATE_RE)) {
    const start = match.index + match[0].indexOf("@");
    const collected = match[0].slice(1).trim();
    const offset = start + match[0].indexOf(collected);
    let userId = null;
    let width = 0;
    for (let end = collected.length; end >= 2; end--) {
      const lower = collected.slice(0, end).toLowerCase();
      const hits = roster.filter((member) => memberMatches(member, lower));
      if (hits.length === 1) {
        userId = hits[0].id;
        width = end;
        break;
      }
      if (hits.length > 1) break; // ambiguous at this width: no shortening rescue
    }
    if (userId !== null) {
      // The span carries ONLY the resolved width — the dropped seam stays
      // plain text (the resolver's trailing-seam law, rendered).
      spans.push({ start: offset, end: offset + width, userId, text: collected.slice(0, width) });
    }
  }
  return spans;
}

// --- the body renderer -------------------------------------------------------------

export function renderBody(message, { inventory = null, roster = [], me = null } = {}) {
  const text = String(message.body || "");
  // A lone same-origin GIF reference unfurls (the GIF ruling): one img, no
  // link farm.
  if (/^\/api\/gifs\/image\?u=\S+$/.test(text.trim())) {
    return h("span", { class: "chat-gif" },
      h("img", { class: "chat-gif-img", src: text.trim(), alt: "GIF", loading: "lazy",
        onError: (event) => event.currentTarget.remove() }));
  }
  const emojiById = new Map((inventory?.emojis || []).map((row) => [row.id, row]));
  const stickerById = new Map((inventory?.stickers || []).map((row) => [row.id, row]));
  const nodes = [];
  let cursor = 0;
  const events = [];
  for (const match of String(text).matchAll(EXPRESSION_RE)) {
    const row = match[1] === "e"
      ? emojiById.get(Number(match[3]))
      : stickerById.get(Number(match[3]));
    events.push({ start: match.index, end: match.index + match[0].length, kind: row ? match[1] : null, row, raw: match[0] });
  }
  for (const span of mentionSpans(text, roster)) {
    events.push({ start: span.start, end: span.end, kind: "mention", userId: span.userId, raw: text.slice(span.start, span.end) });
  }
  events.sort((a, b) => a.start - b.start || b.end - a.end);
  let last = 0;
  for (const event of events) {
    if (event.start < last) continue; // overlaps lose to the earlier event
    if (event.start > last) nodes.push(text.slice(last, event.start));
    last = event.end;
    if (event.kind === "e") {
      nodes.push(h("img", { class: "token-emoji", src: event.row.url, alt: event.raw,
        onError: (e) => e.currentTarget.replaceWith(document.createTextNode(event.raw)) }));
    } else if (event.kind === "s") {
      nodes.push(h("img", { class: "token-sticker", src: event.row.url, alt: event.raw,
        onError: (e) => e.currentTarget.replaceWith(document.createTextNode(event.raw)) }));
    } else if (event.kind === "mention") {
      const mine = me && String(event.userId) === String(me.id);
      nodes.push(h("span", { class: mine ? "mention mention-me" : "mention",
        text: event.raw }));
    }
  }
  if (last < text.length) nodes.push(text.slice(last, text.length));
  if (nodes.length === 0) nodes.push(text);
  return h("span", { class: "chat-body" }, ...nodes);
}

// --- the channel pane ---------------------------------------------------------------

let voiceTickStop = null;
let rosterUnsub = null;

export function renderChannelPane(route, mount) {
  currentServerId = Number(route.params.serverId);
  const channelId = Number(route.params.channelId);
  const servers = store.get("servers") || [];
  const server = servers.find((entry) => entry.id === currentServerId) || null;
  const channel = (server?.channels || []).find((entry) => entry.id === channelId) || null;
  const pane = h("section", { class: "pane-main chat-main" });
  const column = h("div", { class: "chat-column" });
  const header = h("header", { class: "chat-header" },
    h("span", { class: "channel-name", text: (channel ? "#" + channel.name : t("gc.shell.placeholder.channelTitle")) }),
    h("nav", { class: "chat-header-nav" },
      h("a", { class: "control-quiet", href: `/s/${currentServerId}/search`, text: t("gc.controls.search") }),
      h("a", { class: "control-quiet", href: `/s/${currentServerId}/${channelId}/pins`, text: t("gc.chat.pins.link") })));
  const footer = h("footer", { class: "composer-foot" });
  pane.append(header, column, footer);
  mount.append(renderShell(route, pane));

  if (channel && channel.kind === "voice") {
    wireChannelSocket(channelId, column, header);
    renderVoicePane(column, channelId, channel, footer);
  } else {
    footer.append(buildComposer(channelId, channel, column));
    wireChannelSocket(channelId, column, header);
    refreshColumn(column, channelId);
    loadHistory(channelId).then(() => {
      refreshColumn(column, channelId);
      scrollBottom(column);
    }).catch((error) => {
      column.replaceChildren(h("p", { class: "empty-state", text: error.message }));
    });
  }
}

function wireChannelSocket(channelId, column, header) {
  // The predecessor seat goes first: the old channel's voice tick, rail
  // repaint subscription, and rail-live block drop BEFORE this one wires.
  closeChannelTick();
  const socket = getChannelSocket(channelId, {
    onOpen(sock, resumeAfterId) {
      if (resumeAfterId) {
        loadHistory(channelId, resumeAfterId).then(() => {
          refreshColumn(column, channelId);
          scrollBottom(column);
        }).catch(() => { /* the reconnecting strip stays honest */ });
      }
    },
    onFrame(frame) {
      const me = store.get("user");
      if (frame.type === "msg" && frame.message) {
        adoptMessage(channelId, frame.message, me);
        refreshColumn(column, channelId);
        scrollBottom(column);
        markRead(channelId, frame.message.id); // conversations only ACK (forward-only guard inside)
      } else if (frame.type === "roster" && Array.isArray(frame.members)) {
        store.set({ [`presence:${channelId}`]: frame.members });
      } else if (frame.type === "voice_roster") {
        store.set({ [voiceKey(channelId)]: frame.participants });
        refreshVoiceSeat(column, channelId);
      } else if (frame.type === "broadcast" && frame.kind === "typing") {
        flashTyping(column, frame.userId);
      } else if (frame.type === "presence" && Array.isArray(frame.online)) {
        store.set({ presence: frame.online });
      } else if (frame.type === "care_notice") {
        showCareNotice(column, frame.body);
      } else if (frame.type === "error") {
        onSendErrorFrame(frame);
      }
    },
    onReconnecting() { /* the store strip owns the state; nothing per-pane */ },
  });
  // The live roster repaint: the members rail is the shell's aside; the
  // paint is node-local from this channel's seat (the store's whole purpose,
  // wired) — the live member list swaps in under the header until the next
  // shell paint restores the server's REST roster. Chat reaches the rail
  // only through its own column's shell ancestor — never past the DOM law.
  if (rosterUnsub) rosterUnsub();
  rosterUnsub = store.subscribe(`presence:${channelId}`, () => {
    const rail = column.closest(".shell")?.querySelector(".rail-members");
    if (!rail) return;
    rail.querySelector(".rail-live")?.remove();
    const members = store.get(`presence:${channelId}`) || [];
    rail.append(h("div", { class: "rail-live" },
      h("p", { class: "empty-state", text: t("gc.chat.rail.inHere", { count: members.length }) }),
      ...members.map((member) => h("a", {
        class: "member-row",
        href: `/s/${currentServerId}/member/${member.userId}`,
        title: member.username,
        text: member.username,
      }))));
  });
  socket.setResumeAfter(newestMessageId(channelId));
  activeSocket = socket;
}

function closeChannelTick() {
  if (rosterUnsub) {
    rosterUnsub();
    rosterUnsub = null;
  }
  document.querySelector(".rail-live")?.remove();
  if (voiceTickStop) {
    voiceTickStop();
    voiceTickStop = null;
  }
}

function newestMessageId(channelId) {
  const lane = messagesOf(channelId);
  const list = lane?.list || [];
  let newest = null;
  for (const entry of list) {
    if (entry.pending) continue;
    if (newest === null || entry.id > newest) newest = entry.id;
  }
  return newest;
}

function onSendErrorFrame(frame) {
  // The WS send failure lands where the REST failure does: the last pending
  // row carries the verbatim text; the rules-gate arm rides the shared flow.
  const channelId = socketsChannelIdOfLastPending();
  if (channelId === null) return;
  const lane = messagesOf(channelId);
  const pending = (lane?.list || []).filter((entry) => entry.pending).pop();
  if (!pending) return;
  const prior = store.get(messagesKey(channelId));
  store.set({
    [messagesKey(channelId)]: {
      ...prior,
      list: prior.list.map((entry) => (entry === pending
        ? { ...entry, sendError: frame.message || t("gc.chat.send.failed"),
            rulesGate: frame.rules ? { serverId: frame.serverId, rules: frame.rules } : null }
        : entry)),
    },
  });
  refreshColumn(columnNodeRef, channelId);
}

let columnNodeRef = null;
let currentChannelId = null;
let typingUntil = 0;

function socketsChannelIdOfLastPending() {
  return currentChannelId;
}

// --- the message column ------------------------------------------------------------

function refreshColumn(column, channelId) {
  columnNodeRef = column;
  currentChannelId = channelId;
  laneRefresh(column, channelId);
}

function laneRefresh(column, channelId) {
  const lane = messagesOf(channelId);
  if (!lane) return;
  const me = store.get("user");
  const inventory = store.get(expressionsKey(channelIdOf()));
  const membersRoster = store.get(`presence:${channelId}`) || [];
  column.replaceChildren(); // nodes rebuild from h()
  const list = [...lane.list].sort((a, b) => (a.id ?? 1e15) - (b.id ?? 1e15));
  let previous = null;
  for (const message of list) {
    const row = messageRow(message, previous, { me, inventory, roster: membersRoster, channelId });
    column.append(row);
    previous = message;
  }
  if (lane.list.length === 0 && !lane.complete) {
    column.append(h("p", { class: "empty-state", text: t("gc.chat.history.fetching") }));
  } else if (lane.complete && list.length === 0) {
    column.append(h("p", { class: "empty-state", text: t("gc.chat.empty") }));
  }
  const older = lane.oldestAfter;
  if (older) {
    const more = h("button", { class: "control-quiet load-older", type: "button", text: t("gc.chat.history.older") });
    more.addEventListener("click", async () => {
      try {
        await loadHistory(channelId, older);
        refreshColumn(column, channelId);
      } catch (error) {
        more.textContent = error.message;
      }
    });
    column.prepend(more);
  }
  for (const messageId of activeBursts) {
    const row = column.querySelector(`[data-message-id="${messageId}"] .chat-row`);
    if (!row) {
      activeBursts.delete(messageId); // the row left this column — the one-shot is over
      continue;
    }
    pinBurstOverlay(messageId, row); // the survivor: pinned onto the rebuilt row
  }
}

function dayLabel(iso) {
  return String(iso || "").slice(0, 10);
}

function sameDay(a, b) {
  return dayLabel(a?.createdAt) === dayLabel(b?.createdAt);
}

function messageRow(message, previous, context) {
  const grouped = !!previous
    && !message.pending && !previous.pending
    && sameDay(previous, message)
    && previous.authorId === message.authorId;
  const nodes = [];
  if (!previous || !sameDay(previous, message)) {
    nodes.push(h("p", { class: "day-divider", text: dayLabel(message.createdAt) || "" }));
  }
  const body = message.pending
    ? message.sendError
      ? h("span", { class: "chat-body send-error" }, message.body,
          h("span", { class: "form-error pending-error", text: message.sendError }))
      : h("span", { class: "chat-body sending", text: message.body })
    : renderBody(message, context);
  nodes.push(h("div", {
    class: "chat-row" + (grouped ? " grouped" : "") + (message.pending ? " pending" : ""),
  },
  grouped ? null : h("span", {
    class: "chat-initial", "aria-hidden": "true",
    text: (message.authorName || "?").charAt(0).toUpperCase(),
  }),
  message.isPlus && !grouped ? h("span", { class: "mark-plus", title: "Goober+", text: "+" }) : null,
  h("span", { class: "chat-row-body" },
    !grouped ? h("span", { class: "chat-author" },
      h("span", { class: "chat-author-name",
        style: message.accent ? `--member-color:${message.accent}` : undefined,
        text: message.authorName }),
      h("span", { class: "chat-time muted", text: String(message.createdAt || "").slice(11, 16) })) : null,
    body,
    message.pending && !message.sendError ? h("span", { class: "muted pending-hint", text: t("gc.chat.pending.hint") }) : null,
    message.pending && message.sendError ? retryControl(context.channelId, message) : null),
  message.pending ? null : hoverControls(message, context)));
  const wrap = h("div", { class: "chat-row-wrap", "data-message-id": String(message.id ?? message.pendingId) }, ...nodes);
}

function retryControl(channelId, row) {
  const retry = h("button", { class: "control-quiet row-quiet-inline", type: "button",
    text: t("gc.controls.retry") });
  retry.addEventListener("click", async () => {
    try {
      await retryFailed(channelId, row);
      refreshColumn(columnNodeRef, channelId);
    } catch { /* the row keeps its error (a second refusal renders again) */ }
  });
  return retry;
}

function channelRights(serverId, channelId) {
  const server = (store.get("servers") || []).find((entry) => entry.id === serverId) || null;
  const channel = (server?.channels || []).find((entry) => entry.id === channelId) || null;
  const bits = channel?.effectivePermissions || [];
  return {
    staff: !!(server?.role === "owner" || server?.role === "admin"),
    del: bits.includes("DELETE_MESSAGES"),
  };
}

function canPin(message, me, channelId) {
  const meId = me?.id;
  if (message && message.authorId === meId) return true;
  const rights = channelRights(currentServerId, channelId ?? currentChannelId);
  return rights.staff || rights.del;
}

function canModerateMessages(channelId) {
  const me = store.get("user");
  const rights = channelRights(currentServerId, channelId ?? currentChannelId);
  const staffPlatform = !!(me && (me.role === "owner" || me.role === "admin"));
  return rights.staff || rights.del || staffPlatform;
}

// Hover actions — the quiet controls (G-7): react, view reactions, pin,
// edit (author rows only — never a hidden 403), delete (author or the mod
// arm; the confirm names the author when it is NOT the viewer's own row).
function hoverControls(message, context) {
  const me = store.get("user");
  if (!me) return null;
  const author = message.authorId === me.id;
  const controls = h("span", { class: "row-controls chat-row-controls" },
    h("button", { class: "row-quiet-control", type: "button", text: t("gc.chat.row.react"),
      onClick: () => reactionPicker(message) }));
  if ((message.reactions || []).length > 0) {
    controls.append(h("button", { class: "row-quiet-control", type: "button", text: t("gc.chat.reactions.see"),
      onClick: () => reactionsDialog(message, context) }));
  }
  if (canPin(message, me, context.channelId)) {
    const pinnedFlag = message.pinned === true;
    controls.append(h("button", {
      class: "row-quiet-control", type: "button", text: pinnedFlag ? t("gc.chat.row.unpin") : t("gc.chat.row.pin"),
      onClick: async () => {
        try {
          await setPin(message.id, !pinnedFlag);
          refreshColumn(columnNodeRef, context.channelId);
        } catch (error) {
          controls.title = error.message; // the 250-cap 400 lands on the control
        }
      },
    }));
  }
  if (author) {
    controls.append(h("button", { class: "row-quiet-control", type: "button", text: t("gc.chat.row.edit"),
      onClick: () => editInline(message, context) }));
  }
  if (author || canModerateMessages(context.channelId)) {
    controls.append(h("button", { class: "row-quiet-control", type: "button", text: t("gc.chat.row.delete"),
      onClick: () => {
        openDialog(document, {
          heading: t("gc.chat.confirm.delete"),
          body: h("p", { class: "gate-copy", text: author
            ? t("gc.chat.confirm.deleteBody")
            : t("gc.chat.confirm.deleteMod", { author: message.authorName }) }),
          modalOnly: true,
          actions: [
            { class: "button button-danger", text: t("gc.chat.row.delete"), onPress: async () => {
              try {
                await deleteMessage(message.id);
                const lane = store.get(messagesKey(context.channelId));
                store.set({
                  [messagesKey(context.channelId)]: {
                    ...lane,
                    list: (lane?.list || []).filter((entry) => entry.id !== message.id),
                  },
                });
                refreshColumn(columnNodeRef, context.channelId);
              } catch (error) {
                controls.title = error.message; // "Message not found." etc, verbatim
              }
            } },
            { class: "button button-quiet", text: t("gc.controls.keep") },
          ],
        });
      },
    }));
  }
  return controls;
}

function editInline(message, context) {
  const lane = store.get(messagesKey(context.channelId));
  const box = h("textarea", { class: "edit-box", maxlength: String(message.isPlus
    ? UI_PLUS_MESSAGE_MAX : UI_FREE_MESSAGE_MAX), "aria-label": t("gc.chat.edit.heading") });
  box.value = message.body;
  const seat = h("div", { class: "edit-seat" }, box);
  box.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      seat.remove();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      try {
        const payload = await editMessage(message.id, box.value);
        dropAndAdopt(context.channelId, payload.message);
      } catch (error) {
        const note = h("p", { class: "form-error", text: error.message });
        seat.append(note); // the SAME inline errors a send would render
      }
    }
  });
  columnNodeRef?.querySelector(`[data-message-id="${message.id}"]`)?.append(seat);
  void lane;
}

function dropAndAdopt(channelId, message) {
  const lane = store.get(messagesKey(channelId));
  store.set({
    [messagesKey(channelId)]: {
      ...(lane || { list: [], oldestAfter: null }),
      list: (lane?.list || []).map((entry) => (entry.id === message.id ? { ...message } : entry)),
    },
  });
  refreshColumn(columnNodeRef, channelId);
}

// The fx_burst runtime (the 2026-11-19 cosmetics slate's Phase 3): the server
// answers a burst-spending ADD with reaction.fxBurst, and the flagged payload
// pins the ONE-SHOT CSS animation onto the message row — a decorative overlay
// (aria-hidden, no copy, no i18n key) that removes itself at animationend.
function fireBurst(message) {
  const row = columnNodeRef?.querySelector(`[data-message-id="${message.id}"] .chat-row`);
  if (!row) return; // the row's column is gone — nothing to burst
  pinBurstOverlay(message.id, row);
}

// The live burst ids (GO-HAYWIRE cycle-2): a channel msg frame inside the
// ~1s animation window rebuilds the column and orphans the overlay, so
// laneRefresh re-pins each live id onto its rebuilt row; the id leaves the
// Set at its own animationend (or the stale sweep when its row is gone).
const activeBursts = new Set();

function pinBurstOverlay(messageId, row) {
  const burst = h("span", { class: "fx-burst", "aria-hidden": "true" });
  burst.addEventListener("animationend", () => {
    activeBursts.delete(messageId);
    burst.remove();
  });
  activeBursts.add(messageId);
  row.append(burst);
}

function reactionPicker(message) {
  const grid = h("div", { class: "reaction-grid" },
    ...UI_REACTIONS_COMMON.map((emoji) => h("button", {
      class: "icon-button reaction-choice", type: "button", text: emoji,
      onClick: async () => {
        try {
          const payload = await toggleReaction(message.id, emoji);
          // The refresh FIRST, the burst SECOND: laneRefresh rebuilds the
          // column in the same tick (replaceChildren), and a span appended
          // before the rebuild dies before its first frame paints — the
          // rebuild's freshly laid-out row is the node the overlay pins to.
          refreshColumn(columnNodeRef, currentChannelId);
          if (payload?.reaction?.fxBurst) fireBurst(message);
        } catch (error) {
          grid.append(h("p", { class: "form-error", text: error.message })); // the 403 verbatim
        } finally {
          dialog.close();
        }
      },
    })),
    h("p", { class: "muted", text: t("gc.chat.reactions.plusOnly") }),
    ...UI_REACTIONS_SUPER.map((emoji) => h("button", {
      class: "icon-button reaction-choice reaction-super", type: "button", text: emoji,
      onClick: async () => {
        try {
          const payload = await toggleReaction(message.id, emoji);
          // The SAME order law as the common arm: refresh first, burst second.
          refreshColumn(columnNodeRef, currentChannelId);
          if (payload?.reaction?.fxBurst) fireBurst(message);
        } catch (error) {
          grid.append(h("p", { class: "form-error", text: error.message })); // the 403 verbatim
        }
      },
    })));
  const dialog = openDialog(document, { heading: t("gc.chat.row.react"), body: grid, modalOnly: true,
    actions: [{ class: "button button-quiet", text: t("gc.controls.done") }] });
}

async function reactionsDialog(message, context) {
  const seat = openDialogHold(t("gc.chat.reactions.heading"));
  try {
    const payload = await viewReactions(message.id);
    const me = store.get("user");
    const body = h("div", { class: "reaction-rows" });
    for (const group of payload.reactions || []) {
      body.append(h("p", { class: "reaction-row" },
        h("span", { class: "reaction-emoji", text: group.emoji }),
        ...group.users.map((user) => h("span", { class: "reaction-user" },
          h("span", { text: user.username }),
          user.id !== me?.id && message.groupMod
            ? h("button", { class: "row-quiet-control", type: "button", text: t("gc.controls.remove"),
                onClick: async () => {
                  try {
                    await removeReaction(message.id, group.emoji, user.id);
                    dialog.close();
                    refreshColumn(columnNodeRef, context.channelId);
                  } catch (error) {
                    body.append(h("p", { class: "form-error", text: error.message }));
                  }
                } })
            : null))));
    }
    if ((payload.reactions || []).length === 0) {
      body.append(h("p", { class: "empty-state", text: t("gc.chat.reactions.noneLeft") }));
    }
    seat.fill(body);
  } catch (error) {
    seat.fill(h("p", { class: "form-error", text: error.message }));
  }
}

// A held-open dialog the async body fills (the view-reactions dialog is the
// contract's one non-confirm dialog, G-6).
function openDialogHold(heading) {
  const body = h("div", { class: "dialog-hold" }, h("p", { class: "empty-state", text: "…" }));
  const handle = openDialog(document, { heading, body, modalOnly: true,
    actions: [{ class: "button button-quiet", text: t("gc.controls.done") }] });
  return {
    fill: (node) => {
      body.replaceChildren(node);
      void handle;
    },
    close: () => handle?.close?.(),
  };
}

// --- the composer ---------------------------------------------------------------

function buildComposer(channelId, channel, column) {
  const me = store.get("user");
  const limit = me?.isPlus ? UI_PLUS_MESSAGE_MAX : UI_FREE_MESSAGE_MAX;
  const well = h("textarea", {
    class: "composer-well", rows: "2",
    placeholder: t("gc.chat.compose.placeholder"),
    maxlength: String(limit), "aria-label": t("gc.chat.compose.aria"),
  });
  const draftKey = `draft:gc:${channelId}`;
  try {
    well.value = sessionStorage.getItem(draftKey) || "";
  } catch { /* drafts are a convenience, never a dependency */ }
  well.addEventListener("input", () => {
    try { sessionStorage.setItem(draftKey, well.value); } catch { /* quiet */ }
    syncMeter();
    throttledTyping();
  });
  const meter = h("span", { class: "meter", hidden: true });
  const slowSeat = h("span", { class: "slowmeter", "aria-live": "polite" });
  const send = h("button", { class: "button button-primary", type: "button", text: t("gc.controls.send") });
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  const imageSeat = h("span", { class: "attach-seat" });
  let pendingImage = null;
  let inFlight = false;

  const syncMeter = () => {
    if (well.value.length > UI_METER_REVEAL_AT) {
      meter.hidden = false;
      meter.textContent = `${well.value.length} / ${limit}`;
    } else {
      meter.hidden = true;
    }
  };

  const throttledTyping = () => {
    const now = Date.now();
    if (now - typingUntil > 3000) {
      typingUntil = now;
      activeSocket?.typing();
    }
  };

  const doSend = async () => {
    const body = well.value.trim();
    if (!body || inFlight) return;
    inFlight = true;
    send.disabled = true;
    errorLine.textContent = "";
    const file = pendingImage;
    try {
      await sendToChannel(channelId, body, { imageFile: file || undefined });
      well.value = "";
      try { sessionStorage.removeItem(draftKey); } catch { /* quiet */ }
      pendingImage = null;
      imageSeat.replaceChildren();
      syncMeter();
      refreshColumn(column, channelId);
      scrollBottom(column);
    } catch (error) {
      // The failing row shows its own retry; the composer also renders the
      // verbatim text. A rules gate opens the shared accept flow and the
      // member's own click re-offers the send.
      errorLine.textContent = error.message;
      if (error.retryAfter) armSlowmeter(error.retryAfter);
      if (guardRulesGate(document, error, () =>
        sendToChannel(channelId, body, { imageFile: pendingImage || undefined })
          .then(() => { errorLine.textContent = ""; refreshColumn(column, channelId); }))) {
        errorLine.textContent = "";
      }
    } finally {
      inFlight = false;
      send.disabled = false;
    }
  };
  well.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      doSend();
    }
  });
  send.addEventListener("click", doSend);

  // The riders — the ONLY icon buttons in the chat surface (G-7).
  const attachFile = h("input", { type: "file", accept: "image/*",
    style: "position:absolute;width:1px;height:1px;opacity:0", "aria-hidden": "true" });
  attachFile.addEventListener("change", async () => {
    const file = attachFile.files?.[0];
    if (!file) return;
    attachFile.value = "";
    const tierCap = me?.isPlus && plusFullTerm(me)
      ? UI_ATTACHMENT_PLUS_MAX
      : me?.plusTier === "mini" ? UI_ATTACHMENT_MINI_MAX : UI_ATTACHMENT_FREE_MAX;
    if (file.size > tierCap) {
      errorLine.textContent = t("gc.chat.attach.tooLarge", { mib: Math.round(tierCap / 1048576) });
      return;
    }
    if (pendingImage) {
      errorLine.textContent = t("gc.chat.attach.one"); // the server's own text shape
      return;
    }
    try {
      const data = new FormData();
      data.append("image", file);
      const { attachment } = await api("/api/attachments", { method: "POST", body: data });
      if (attachment?.status !== "pending") throw new Error(t("gc.chat.attach.failed"));
      pendingImage = file;
      const preview = h("img", {
        class: "attach-preview", src: objectUrlFor(file), alt: file.name });
      const remove = h("button", { class: "control-quiet row-quiet-inline", type: "button",
        text: t("gc.controls.remove"), onClick: () => {
          pendingImage = null;
          imageSeat.replaceChildren();
          revokeUrlFor(file);
        } });
      imageSeat.replaceChildren(h("span", { class: "attach-strip" },
        preview, h("span", { class: "muted", text: t("gc.chat.attach.pending") }), remove));
    } catch (error) {
      errorLine.textContent = error.message;
    }
  });

  const riders = h("div", { class: "composer-riders" },
    h("button", { class: "icon-button attach-rider", type: "button", title: t("gc.chat.attach.button"),
      onClick: () => attachFile.click(), text: "🖼" }),
    attachFile,
    h("button", { class: "icon-button gif-rider", type: "button", title: t("gc.chat.gif.short"),
      onClick: () => gifRider(well, errorLine), text: "GIF" }),
    h("button", { class: "icon-button emoji-rider", type: "button", title: t("gc.chat.expressions.emojiTitle"),
      onClick: () => expressionRider(well, "emojis", errorLine), text: "☺" }),
    h("button", { class: "icon-button sticker-rider", type: "button", title: t("gc.chat.expressions.stickerTitle"),
      onClick: () => expressionRider(well, "stickers", errorLine), text: "▣" }),
    h("button", { class: "icon-button soundrider", type: "button", title: t("gc.chat.expressions.soundTitle"),
      onClick: () => soundRider(errorLine), text: "♪" }));
  return h("div", { class: "composer" },
    imageSeat,
    h("div", { class: "composer-well-row" }, riders, well),
    h("div", { class: "composer-foot-row" }, meter, slowSeat, send),
    errorLine);
}

function plusFullTerm() {
  // The snapshot's plus shape counts grace as active for the DISPLAY; the
  // perk surfaces read strict-active. The coins snapshot, when present,
  // carries the caller's own tier.
  const coins = store.get("coins");
  return !!(coins?.plus?.active && coins.plus.tier === "plus");
}

const urlSeats = new Map();
function objectUrlFor(file) {
  const url = URL.createObjectURL(file);
  urlSeats.set(file, url);
  return url;
}
function revokeUrlFor(file) {
  const url = urlSeats.get(file);
  if (url) URL.revokeObjectURL(url);
}

let activeSocket = null;

function armSlowmeter(seconds) {
  const seat = document.querySelector(".slowmeter");
  if (!seat) return;
  let left = Math.max(1, Math.ceil(seconds));
  seat.textContent = t("gc.chat.slowmode.wait", { seconds: left });
  const timer = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(timer);
      seat.textContent = "";
    } else {
      seat.textContent = t("gc.chat.slowmode.wait", { seconds: left });
    }
  }, 1000);
}

// GIF rider: Enter in the search field searches, never sends; display rides
// ONLY the same-origin proxy; 503 keeps the composer usable (B3).
function gifRider(well, errorLine) {
  const seat = h("input", { class: "gif-query", placeholder: t("gc.chat.gif.button"),
    maxlength: String(UI_GIF_QUERY_MAX), "aria-label": t("gc.chat.gif.heading") });
  const grid = h("div", { class: "gif-grid" });
  let position = null;
  const load = async (reset) => {
    try {
      const payload = await searchGifs(seat.value.trim(), { position });
      position = payload.position ?? null;
      if (reset) grid.replaceChildren();
      for (const gif of payload.gifs || []) {
        grid.append(h("button", {
          class: "gif-choice", type: "button", title: gif.description || "GIF",
          onClick: () => {
            // Insertion = the plain proxied URL as body text.
            const token = gifProxyUrl(gif.url);
            insertAtCaret(well, token);
            dialog.close();
          },
        }, h("img", { src: gifProxyUrl(gif.previewUrl || gif.url), alt: gif.description || "GIF",
          loading: "lazy" })));
      }
      if ((payload.gifs || []).length === 0 && reset) {
        grid.append(h("p", { class: "empty-state", text: t("gc.chat.gif.none") }));
      }
      if (position) {
        grid.append(h("button", { class: "control-quiet", type: "button", text: t("gc.controls.more"),
          onClick: () => load(false) }));
      }
      dialog.retitle?.("GIFs");
    } catch (error) {
      grid.append(h("p", { class: "form-error", text: error.message })); // 503 "GIF search is not configured yet."
    }
  };
  const dialog = openDialog(document, {
    heading: t("gc.chat.gif.short"), modalOnly: true,
    body: h("div", { class: "gif-lane" }, seat, grid),
    actions: [{ class: "button button-quiet", text: t("gc.controls.done") }] });
  seat.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { // Enter searches, not sends
      event.preventDefault();
      position = null;
      load(true);
    }
  });
  load(true);
}

// Expression riders: THIS server's inventory; insert the literal token at
// the caret; zero inventory speaks the G-5 sentence (the manage link rides
// MANAGE_EMOJI only); a resolved token in a DM/group shows the perk line.
let dialogRef = null;
function expressionRider(well, lane, errorLine) {
  const serverId = currentServerId;
  if (!serverId) {
    errorLine.textContent = t("gc.chat.expressions.serverOnly");
    return;
  }
  const build = (payload) => {
    const rows = payload?.[lane] || [];
    if (rows.length === 0) {
      return h("p", { class: "empty-state", text: lane === "emojis"
        ? t("gc.chat.expressions.noEmoji")
        : t("gc.chat.expressions.noStickers") });
    }
    return h("div", { class: "expression-grid" }, ...rows.map((row) => h("button", {
      class: "icon-button expression-choice", type: "button", title: row.name,
      onClick: () => {
        const kind = lane === "emojis" ? "e" : "s";
        insertAtCaret(well, `<${kind}:${row.name}:${row.id}>`);
        dialogRef?.close?.();
      },
    }, h("img", { src: row.url, alt: row.name, loading: "lazy" }))));
  };
  const cached = store.get(expressionsKey(serverId));
  const body = h("div", { class: "expression-lane" });
  if (cached) body.append(build(cached));
  else body.append(h("p", { class: "empty-state", text: t("gc.controls.fetching") }));
  dialogRef = openDialog(document, {
    heading: lane === "emojis" ? t("gc.chat.expressions.emojiTitle") : t("gc.chat.expressions.stickerTitle"), modalOnly: true, body,
    actions: [{ class: "button button-quiet", text: t("gc.controls.done") }] });
  api(`/api/servers/${serverId}/${lane === "emojis" ? "emojis" : "stickers"}`).then((payload) => {
    store.set({ [expressionsKey(serverId)]: {
      ...(store.get(expressionsKey(serverId)) || {}),
      [lane]: payload[lane] || [],
    } });
    body.replaceChildren(build(payload));
  }).catch((error) => {
    body.replaceChildren(h("p", { class: "form-error", text: error.message }));
  });
}

// The soundboard rider: browses + a LOCAL preview only; playing into chat or
// voice is a later parity lane, never this rider.
function soundRider(errorLine) {
  const serverId = currentServerId;
  if (!serverId) return;
  const seat = openDialogHold(t("gc.chat.expressions.soundTitle"));
  api(`/api/servers/${serverId}/sounds`).then((payload) => {
    const rows = payload.sounds || [];
    if (rows.length === 0) {
      seat.fill(h("p", { class: "empty-state", text: t("gc.chat.expressions.noSounds") }));
      return;
    }
    const body = h("div", { class: "sound-list" });
    for (const sound of rows) {
      const audio = h("audio", { controls: true, src: sound.url, preload: "none" });
      body.append(h("div", { class: "sound-row" },
        h("span", { class: "expr-name", text: sound.name }), audio));
    }
    seat.fill(body);
  }).catch((error) => {
    seat.fill(h("p", { class: "form-error", text: error.message }));
  });
}

function insertAtCaret(well, token) {
  const start = well.selectionStart ?? well.value.length;
  const end = well.selectionEnd ?? start;
  well.value = well.value.slice(0, start) + token + well.value.slice(end);
  const seat = start + token.length;
  well.setSelectionRange(seat, seat);
  well.focus();
  well.dispatchEvent(new Event("input"));
}

function scrollBottom(column) {
  column.scrollTop = column.scrollHeight;
}

function flashTyping(column, userId) {
  const seat = column.parentElement?.querySelector(".typing-seat");
  if (!seat || userId === store.get("user")?.id) return;
  seat.textContent = t("gc.chat.typing");
  clearTimeout(flashTyping.timer);
  flashTyping.timer = setTimeout(() => { if (seat) seat.textContent = ""; }, 3000);
}

let typingSeatRef = null;

function showCareNotice(column, body) {
  const seat = h("p", { class: "care-notice count-line", text: body }); // inline, additive, one line
  column.append(seat);
}

// --- the voice control plane -------------------------------------------------------

function renderVoicePane(column, channelId, channel, footer) {
  const join = h("button", { class: "button button-primary voice-join", type: "button",
    text: t("gc.voice.join") });
  const roster = h("div", { class: "voice-roster" });
  const errorLine = h("p", { class: "form-error" });
  join.addEventListener("click", async () => {
    if (voiceTickStop) return leaveVoice();
    const ok = activeSocket ? activeSocket.voiceJoin() : false;
    if (!ok) {
      errorLine.textContent = t("gc.voice.notConnected");
      return;
    }
    voiceTickStop = startVoiceTicks(channelId);
    join.textContent = t("gc.voice.leave");
  });
  const leaveVoice = () => {
    activeSocket?.voiceLeave();
    if (voiceTickStop) voiceTickStop();
    voiceTickStop = null;
    join.textContent = t("gc.voice.join");
  };
  const mute = h("button", { class: "control-quiet", type: "button", text: t("gc.voice.mute"),
    onClick: (event) => {
      muted = !muted;
      event.currentTarget.textContent = muted ? t("gc.voice.unmute") : t("gc.voice.mute");
      activeSocket?.voiceMute(muted);
    } });
  let muted = false;
  footer.append(h("div", { class: "composer" }, h("div", { class: "composer-foot-row" },
    join, mute, errorLine), roster, h("p", { class: "muted count-line",
    text: t("gc.voice.ears", { max: UI_VOICE_MAX_PARTICIPANTS }) }))),
  void channel;
}

function refreshVoiceSeat(column, channelId) {
  const participants = store.get(voiceKey(channelId)) || [];
  const seat = document.querySelector(".voice-roster");
  if (!seat) return;
  seat.replaceChildren(...participants.map((member) =>
    h("span", { class: "voice-participant",
      text: `${member.username}${member.muted ? " " + t("gc.voice.mutedSuffix") : ""}` })));
}

// The pins page (G-6: its own route, never a dialog farm).
export function renderChannelPins(route, mount) {
  const serverId = Number(route.params.serverId);
  const channelId = Number(route.params.channelId);
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}/${channelId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.chat.pins.heading") })));
  mount.append(renderShell(null, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body))));
  loadPins(channelId).then((payload) => {
    const me = store.get("user");
    if ((payload.messages || []).length === 0) {
      body.append(h("p", { class: "empty-state", text: t("gc.chat.pins.empty") }));
      return;
    }
    const inventory = store.get(expressionsKey(serverId));
    const membersRoster = store.get(`presence:${channelId}`) || [];
    for (const message of payload.messages) {
      body.append(messageRow(message, null,
        { me, inventory, roster: membersRoster, channelId }));
    }
    body.append(h("p", { class: "muted count-line", text: t("gc.chat.pins.capNote") }));
  }).catch((error) => {
    body.append(h("p", { class: "form-error", text: error.message }));
  });
}

// The server search task page: results jump to the containing channel; %
// and _ in the term are the server's literals — never mangled client-side.
export function renderServerSearch(route, mount) {
  const serverId = Number(route.params.serverId);
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.chat.search.placeholder") })));
  const well = h("input", { class: "search-well", maxlength: String(100),
    placeholder: t("gc.chat.search.wordsHint"), "aria-label": t("gc.chat.search.termLabel") });
  const results = h("div", { class: "search-results" });
  const errorLine = h("p", { class: "form-error" });
  const form = h("form", { class: "search-form" }, well,
    h("button", { class: "button button-primary", type: "submit", text: t("gc.controls.search") }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const term = well.value.trim();
    errorLine.textContent = "";
    try {
      const payload = await searchServer(serverId, term);
      results.replaceChildren();
      for (const hit of payload.results || []) {
        results.append(h("a", { class: "search-hit", href: `/s/${serverId}/${hit.channelId}` },
          h("span", { class: "muted", text: `#${hit.channelName} · ${hit.authorUsername}` }),
          h("span", { class: "search-hit-body", text: hit.body })));
      }
      if ((payload.results || []).length === 0) {
        results.append(h("p", { class: "empty-state", text: t("gc.chat.search.none") }));
      }
    } catch (error) {
      errorLine.textContent = error.message; // "That search term is invalid." / 503 verbatim
    }
  });
  body.append(form, errorLine, results);
  mount.append(renderShell(null, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body))));
}

// The conversation pane (route "conversation", /dm/:id) — the SAME column +
// composer; group headers ride social.js's manage controls; no expression
// inventory (the shape carries none) but the perk line still gates tokens.
export async function renderConversation(route, mount) {
  const id = Number(route.params.id);
  const me = store.get("user");
  let conversations = store.get("conversations");
  if (!conversations) conversations = await loadConversations();
  const thread = (conversations || []).find((entry) => entry.id === id) || null;
  const others = thread
    ? thread.members.filter((member) => member.userId !== me?.id) : [];
  const title = thread
    ? (thread.name || others.map((member) => member.username).join(", ") || t("gc.shell.nav.dm"))
    : t("gc.social.dm.fallback");
  const pane = h("section", { class: "pane-main chat-main" });
  const column = h("div", { class: "chat-column" });
  const header = h("header", { class: "chat-header" },
    h("span", { class: "channel-name", text: title }));
  const footer = h("footer", { class: "composer-foot" });
  pane.append(header, column, footer);
  mount.append(renderShell(route, pane));
  footer.append(buildComposer(id, null, column));
  if (thread?.kind === "group") header.append(manageGroupControls(id, thread));
  wireConversationSocket(id, column, thread);
  refreshColumn(column, id);
  loadHistory(id).then(() => {
    refreshColumn(column, id);
    scrollBottom(column);
  }).catch((error) => {
    column.replaceChildren(h("p", { class: "empty-state", text: error.message }));
  });
}

function wireConversationSocket(conversationId, column) {
  const socket = getChannelSocket(conversationId, {
    onOpen(sock, resumeAfterId) {
      if (resumeAfterId) {
        loadHistory(conversationId, resumeAfterId).then(() => {
          refreshColumn(column, conversationId);
          scrollBottom(column);
        }).catch(() => {});
      }
    },
    onFrame(frame) {
      const me = store.get("user");
      if (frame.type === "msg" && frame.message) {
        adoptMessage(conversationId, frame.message, me);
        refreshColumn(column, conversationId);
        scrollBottom(column);
        markRead(conversationId, frame.message.id);
      } else if (frame.type === "roster" && Array.isArray(frame.members)) {
        store.set({ [`presence:${conversationId}`]: frame.members });
      } else if (frame.type === "care_notice") {
        showCareNotice(column, frame.body);
      } else if (frame.type === "error") {
        onSendErrorFrame(frame);
      }
    },
    onReconnecting() {},
  });
  socket.setResumeAfter(newestMessageId(conversationId));
  activeSocket = socket;
}

// The channel route's socket seat also feeds the composer's typing lane.
export function setActiveSocket(socket) {
  activeSocket = socket;
}
