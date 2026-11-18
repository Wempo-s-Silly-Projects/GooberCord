// Copyright 2026 ItsWempo
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

// The social lane: friends hub (requests, blocks, the gate, the status
// editor), the channel rail's DM section, and the conversation task pane.
// Contract truth: /api/friends(+/requests/accept|decline/…), /api/blocks,
// PATCH /api/me/status, /api/conversations… Every failure renders the
// payload's error string VERBATIM (G-2) with the input kept; list rows offer
// themselves (G-7) and quiet writes live on the hub/card, never as buttons
// inside rows.
import { h } from "../core/dom.js";
import { t } from "../i18n.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createForm, createInput, createSelect } from "../vendor/designer/kit.mjs";
import { openDialog } from "../vendor/frontload/dom.mjs";
import * as router from "../core/router.js";
import * as quiet from "./quiet-hours.js";
import { renderShell } from "./shell.js";

// --- the loads ---------------------------------------------------------------

export async function loadSocial() {
  const payload = await api("/api/friends");
  store.set({ friends: payload });
  return payload;
}

export async function loadConversations() {
  const payload = await api("/api/conversations");
  const fresh = Array.isArray(payload?.conversations) ? payload.conversations : [];
  // The DM ping's hold point (T77): a thread's unread GROWN against the
  // store's previous list is the ping moment — the schedule's "held" answer
  // parks it in the wake digest instead. The first-known list (cold store)
  // is backlog, never a new ping.
  const previous = store.get("conversations");
  if (previous) {
    const before = new Map(previous.map((thread) => [thread.id, thread.unread || 0]));
    const meId = store.get("user")?.id ?? null;
    for (const thread of fresh) {
      if ((thread.unread || 0) > (before.get(thread.id) || 0)) quiet.holdDmPing(thread, meId);
    }
  }
  store.set({ conversations: fresh });
  return fresh;
}

export async function loadBlocks() {
  const payload = await api("/api/blocks");
  store.set({ blocks: Array.isArray(payload?.blocked) ? payload.blocked : [] });
  return store.get("blocks");
}

// --- the writes ----------------------------------------------------------------

// startConversation(userId) — the DM find-or-create: an existing pair answers
// 200, fresh answers 201; either way the member lands on the conversation
// pane. Blocked-pair and gate-off 403s bubble verbatim to the caller.
export async function startConversation(userId) {
  const result = await api("/api/conversations", { method: "POST", body: { userIds: [userId] } });
  await loadConversations();
  router.navigate(`/dm/${result.conversation.id}`);
  return result.conversation;
}

// setStatus(patch) — PATCH /api/me/status with the body grammar verbatim: a
// key left out KEEPS the stored value, null clears.
export async function setStatus(patch) {
  const result = await api("/api/me/status", { method: "PATCH", body: patch });
  store.set({ status: result.status });
  return result;
}

export async function setAcceptRequests(accept) {
  const result = await api("/api/friends/settings", { method: "PUT", body: { acceptRequests: accept } });
  store.set({ friends: { ...store.get("friends"), settings: result.settings } });
  return result;
}

export async function setBlock(userId, kind) {
  const result = await api(`/api/blocks/${userId}`, { method: "PUT", body: { kind } });
  await loadBlocks();
  await loadSocial(); // a hard block dissolves friendship + pendings
  return result;
}

export async function clearBlock(userId) {
  const result = await api(`/api/blocks/${userId}`, { method: "DELETE" });
  await loadBlocks();
  return result;
}

// --- the hub (the /friends route) -------------------------------------------------

// A quiet write control revealed on the row's hover-and-focus; the (hover:
// none) clause keeps it visible for touch (tests/button-language pins it).
function rowWrite(label, fn, { danger = false } = {}) {
  const control = h("button", {
    class: ["row-quiet-control", danger ? "row-quiet-danger" : null],
    type: "button", text: label,
    onclick: async (event) => {
      event.stopPropagation();
      control.disabled = true;
      try {
        await fn();
      } catch (error) {
        control.textContent = error.message; // verbatim, inline, stays
      } finally {
        control.disabled = false;
      }
    },
  });
  return h("span", { class: "row-controls" }, control);
}

function inlineError() {
  return h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
}

// The request form: EXACTLY one of { username } or { userId } (the contract's
// both/neither split), the copies verbatim.
function requestForm() {
  const errorLine = inlineError();
  const nameField = createInput(document, {
    id: "request-username", label: t("gc.social.friends.byUsername"),
    description: t("gc.social.friends.byIdToggle"),
  });
  const idField = createInput(document, {
    id: "request-user-id", label: t("gc.social.friends.byId"), type: "number", value: "",
  });
  const form = createForm(document, "friend-request", [nameField, idField], t("gc.social.friends.sendRequest"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = form.querySelector("#request-username").value.trim();
    const userId = form.querySelector("#request-user-id").value.trim();
    const body = username ? { username } : userId ? { userId: Number(userId) } : {};
    // One of the two, otherwise the contract's both/neither 400 — send it and
    // let the server's exact text speak (G-2, no client oracle).
    try {
      await api("/api/friends/requests", { method: "POST", body });
      await loadSocial();
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message;
    }
  });
  return h("div", { class: "panel" }, h("h3", { text: t("gc.social.friends.addHeading") }), form, errorLine);
}

// The status editor: text + expiry + presence, with the "absent keeps" law
// respected by the checkboxes' states.
function statusEditor() {
  const current = store.get("status") || {};
  const errorLine = inlineError();
  const textField = createInput(document, {
    id: "status-text", label: t("gc.social.status.customLabel"),
    description: t("gc.social.status.customHelp"), value: current.statusText || "",
  });
  const expiryField = createInput(document, {
    id: "status-expiry", label: t("gc.social.status.expiresLabel"), type: "number",
    value: current.statusUntil || "",
  });
  const presence = createSelect(document, {
    id: "status-presence", label: t("gc.social.status.presenceSelect"),
    options: [
      { value: "", label: t("gc.social.presence.keep") },
      { value: "online", label: t("gc.social.presence.online") },
      { value: "idle", label: t("gc.social.presence.idle") },
      { value: "dnd", label: t("gc.social.status.presenceLabel") },
    ],
  });
  const clearBox = h("input", {
    type: "checkbox", id: "status-clear", "aria-label": t("gc.social.status.clear"),
  });
  const clearLabel = h("label", { for: "status-clear", text: t("gc.social.status.clearText") });
  const form = createForm(document, "status", [
    textField, expiryField, presence,
    h("div", { class: "form-field check-inline" }, clearBox, clearLabel),
  ], t("gc.social.status.save"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {};
    if (clearBox.checked) {
      body.statusText = null;
    } else {
      const text = form.querySelector("#status-text").value;
      if (text !== (current.statusText || "")) body.statusText = text === "" ? null : text;
    }
    const expiry = form.querySelector("#status-expiry").value.trim();
    if (expiry !== String(current.statusUntil ?? "")) {
      body.statusUntil = expiry === "" ? null : Number(expiry);
    }
    const presenceChoice = form.querySelector("#status-presence").value;
    if (presenceChoice !== "") body.presenceState = presenceChoice;
    if (Object.keys(body).length === 0) return; // absent keys keep; nothing sent
    try {
      await setStatus(body);
      errorLine.textContent = "";
    } catch (error) {
      errorLine.textContent = error.message;
    }
  });
  return h("div", { class: "panel" }, h("h3", { text: t("gc.social.status.heading") }), form, errorLine);
}

function friendsPanel() {
  const social = store.get("friends") || { friends: [], pendingSent: [], pendingReceived: [] };
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.social.friends.section") }));
  if (social.friends.length === 0) {
    panel.append(h("p", { class: "empty-state", text: t("gc.social.friends.empty") }));
  }
  for (const friend of social.friends) {
    panel.append(h("a", { class: "friend-row", href: "#", title: friend.username, "aria-label": friend.username },
      h("span", { class: "member-name", text: friend.username }),
      friend.isPlus ? h("span", { class: "mark-plus", text: "+" }) : null,
      rowWrite(t("gc.social.row.message"), () => startConversation(friend.userId)),
      rowWrite(t("gc.social.row.unfriend"), async () => {
        await api(`/api/friends/${friend.userId}`, { method: "DELETE" });
        await loadSocial();
      }, { danger: true })));
  }
  return panel;
}

function requestsPanel() {
  const social = store.get("friends") || {};
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.social.requests.section") }));
  for (const request of social.pendingReceived || []) {
    panel.append(h("div", { class: "friend-row", "aria-label": t("gc.social.requests.incoming") + " " + request.username },
      h("span", { class: "member-name", text: request.username }),
      rowWrite(t("gc.social.row.accept"), async () => {
        await api("/api/friends/requests/accept", { method: "POST", body: { userId: request.userId } });
        await loadSocial();
        router.renderCurrent();
      }),
      rowWrite(t("gc.social.row.decline"), async () => {
        await api("/api/friends/requests/decline", { method: "POST", body: { userId: request.userId } });
        await loadSocial();
        router.renderCurrent();
      }, { danger: true })));
  }
  for (const request of social.pendingSent || []) {
    // Only MINE carry the cancel (an incoming request is never cancellable).
    panel.append(h("div", { class: "friend-row", "aria-label": t("gc.social.requests.outgoing") + " " + request.username },
      h("span", { class: "member-name", text: request.username }),
      rowWrite(t("gc.social.row.cancel"), async () => {
        await api(`/api/friends/requests/${request.userId}`, { method: "DELETE" });
        await loadSocial();
        router.renderCurrent();
      }, { danger: true })));
  }
  if (!(social.pendingReceived || []).length && !(social.pendingSent || []).length) {
    panel.append(h("p", { class: "empty-state", text: t("gc.social.requests.empty") }));
  }
  return panel;
}

function blocksPanel() {
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.social.blocks.heading") }));
  const blocks = store.get("blocks") || [];
  if (blocks.length === 0) {
    panel.append(h("p", { class: "empty-state", text: t("gc.social.blocks.empty") }));
  }
  for (const block of blocks) {
    panel.append(h("div", { class: "friend-row" },
      h("span", { class: "member-name", text: block.username || t("gc.social.blocks.member", { id: block.userId }) },
        h("span", { class: "mark-muted", text: " (" + block.kind + ")" })),
      rowWrite(t("gc.social.row.unblock"), async () => {
        await clearBlock(block.userId);
        router.renderCurrent();
      })));
  }
  return panel;
}

// renderSocialHub(route, mount) — the "/friends" task page. Back, heading,
// one panel per quiet lane, gate toggle written through on click.
// quietDigestSeat() — the wake digest (T77): the window no longer holding,
// the member's next friends-hub consult drains the held rows once — one row
// per conversation, title + how many, the click opens the thread. A cold
// conversations store defers the consult (the hydration re-render has the
// titles); a second wake with nothing held renders nothing.
function quietDigestSeat() {
  if (!store.get("conversations")) return null;
  let digest = [];
  try {
    digest = quiet.dueDigest(quiet.wakeQueue, quiet.scheduleOf(), new Date());
  } catch { /* the digest is a courtesy, never a render blocker */ }
  if (digest.length === 0) return null;
  const threads = store.get("conversations") || [];
  const title = (conversationId) => {
    const thread = threads.find((entry) => entry.id === conversationId);
    return thread ? (thread.name || t("gc.shell.nav.dm")) : t("gc.shell.nav.dm");
  };
  return h("div", { class: "panel quiet-digest" },
    h("h3", { text: t("gc.social.quiet.digestHeading") }),
    ...digest.map((row) => h("a", { class: "quiet-digest-row", href: `/dm/${row.conversationId}` },
      h("span", { text: title(row.conversationId) }),
      h("span", { class: "count-pill", text: String(row.count) }))));
}

// quietPanel() — the saved schedule's seat: the explicit save ONLY writes
// (the defaults law: the OFF default never turns itself on; no render, no
// hover, no toggle-flip write). The time wells sit disabled while the
// schedule is off.
function quietPanel() {
  const draft = { ...quiet.scheduleOf() };
  const toggle = h("button", {
    class: "control-quiet gate-toggle", type: "button",
    text: draft.on ? t("gc.social.quiet.on") : t("gc.social.quiet.off"),
  });
  const times = [
    createInput(document, {
      id: "quiet-start", label: t("gc.social.quiet.start"), type: "time", value: draft.start,
    }),
    createInput(document, {
      id: "quiet-end", label: t("gc.social.quiet.end"), type: "time", value: draft.end,
    }),
  ];
  const syncTimes = () => {
    for (const well of times) well.querySelector("input").disabled = !draft.on;
  };
  toggle.addEventListener("click", () => {
    draft.on = !draft.on;
    toggle.textContent = draft.on ? t("gc.social.quiet.on") : t("gc.social.quiet.off");
    syncTimes();
  });
  syncTimes();
  return h("div", { class: "panel quiet-panel" },
    h("h3", { text: t("gc.social.quiet.heading") }),
    h("p", { class: "muted", text: t("gc.social.quiet.note") }),
    toggle, ...times,
    h("button", {
      class: "button button-primary", type: "button", text: t("gc.controls.save"),
      onclick: () => {
        quiet.saveSchedule({
          on: draft.on,
          start: times[0].querySelector("input").value || draft.start,
          end: times[1].querySelector("input").value || draft.end,
        });
        router.renderCurrent();
      },
    }));
}

export function renderSocialHub(route, mount) {
  const social = store.get("friends");
  const pane = h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" },
      h("section", { class: "task-page" },
        h("header", { class: "task-header" },
          h("a", { class: "back-link", href: "/", text: t("gc.controls.back") }),
          h("h2", { class: "page-heading", text: t("gc.social.friends.heading") })),
        quietDigestSeat(),
        h("div", { class: "panel gate-panel-inline" },
          h("h3", { text: t("gc.social.privacy.label") }),
          h("button", {
            class: "control-quiet gate-toggle", type: "button",
            text: social?.settings?.acceptRequests ? t("gc.social.privacy.on") : t("gc.social.privacy.off"),
            onclick: async (event) => {
              try {
                await setAcceptRequests(!social?.settings?.acceptRequests);
                event.currentTarget.textContent = social.settings.acceptRequests
                  ? t("gc.social.privacy.on") : t("gc.social.privacy.off");
              } catch (error) {
                event.currentTarget.textContent = error.message; // verbatim
              }
            },
          })),
        requestForm(), statusEditor(), friendsPanel(), requestsPanel(),
        blocksPanel(), quietPanel())));
  mount.append(renderShell(null, pane));
  if (!social) {
    loadSocial().then(() => loadBlocks()).then(() => router.current() && router.renderCurrent())
      .catch((error) => {
        pane.querySelector(".task-page")?.append(h("p", {
          class: "empty-state", text: error.message,
        }));
      });
  }
}

// renderBlockControl(member username, userId) — the member card's block arm;
// the "blocked" tier's dissolve consequence is stated in the one confirm.
export function blockControl(userId, username) {
  const kindSelect = h("select", { "aria-label": t("gc.social.blocks.kindLabel"), class: "field-select" },
    h("option", { value: "blocked", text: t("gc.social.blocks.kindBlock") }),
    h("option", { value: "ignored", text: t("gc.social.blocks.kindIgnored") }));
  const button = h("button", {
    class: "control-quiet", type: "button", text: t("gc.social.blocks.blockOrIgnore"),
    onclick: () => {
      openDialog(document, {
        heading: t("gc.social.blocks.confirm", { name: username }),
        body: kindSelect,
        actions: [
          {
            class: "button button-danger", text: t("gc.controls.set"),
            onPress: async () => {
              try {
                await setBlock(userId, kindSelect.value);
                router.renderCurrent();
              } catch (error) {
                // The card's block attempt surfaces verbatim, inline.
                button.textContent = error.message;
              }
            },
          },
          { class: "button button-quiet", text: t("gc.controls.keep") },
        ],
      });
    },
  });
  return h("div", { class: "affordance-row card-arm" }, kindSelect, button);
}

// renderConversationPane(route, mount) — the "/dm/:id" placeholder pane: the
// chat wave re-registers the "conversation" route name to fill message
// history; the manage controls (leave, group rename/add) stay here.
export function renderConversationPane(route, mount, paneOverride = null) {
  const id = Number(route.params.id);
  const conversations = store.get("conversations") || [];
  const thread = conversations.find((entry) => entry.id === id) || null;
  const pane = paneOverride || h("section", { class: "pane-main" });
  const others = thread
    ? thread.members.filter((member) => member.userId !== (store.get("user")?.id))
    : [];
  const title = thread
    ? (thread.name || others.map((member) => member.username).join(", ") || t("gc.shell.nav.dm"))
    : t("gc.social.dm.fallback");
  if (!paneOverride) {
    pane.append(
      h("header", { class: "pane-header" },
        h("h2", { class: "pane-title", text: thread?.kind === "group" ? title : title }),
        thread?.kind === "group" ? manageGroupControls(id, thread) : null),
      h("div", { class: "pane-body" },
        h("p", { class: "empty-state", text: t("gc.shell.placeholder.channel") })),
    );
  }
  mount.append(renderShell({ params: {} }, pane));
  if (!thread) {
    loadConversations().then(() => router.current() && router.renderCurrent()).catch(() => {});
  }
}

// Exported for the chat lane: the conversation route's group header
// reuses the friends-link/rename/leave manage controls (member add/remove
// stays with the chat lane's registered deferral).
export function manageGroupControls(id, thread) {
  const wrap = h("div", { class: "affordance-row pane-affordances" });
  const renameForm = createForm(document, "group-rename",
    [createInput(document, { id: "group-name", label: "", value: "" })], t("gc.controls.rename"));
  wrap.append(h("a", { class: "control-quiet", href: "/friends", text: t("gc.social.friends.heading") }),
    h("button", {
      class: "control-quiet", type: "button", text: t("gc.controls.rename"),
      onclick: () => {
        openDialog(document, {
          heading: t("gc.social.group.rename"),
          body: renameForm,
          actions: [{
            class: "button button-primary", text: t("gc.controls.save"),
            onPress: async () => {
              try {
                const name = renameForm.querySelector("#group-name").value.trim();
                if (!name) return;
                await api(`/api/conversations/${id}`, { method: "PATCH", body: { name } });
                await loadConversations();
              } catch { /* the reopen shows the fresh state; 400 texts render on retry */ }
            },
          }, { class: "button button-quiet", text: t("gc.controls.keep") }],
        });
      },
    }),
    h("button", { // leave — one confirmation; last-leaver copy states the truth
      class: "control-quiet row-quiet-danger", type: "button", text: t("gc.controls.leave"),
      onclick: () => {
        openDialog(document, {
          heading: t("gc.social.group.leaveConfirm"),
          body: h("p", {
            class: "gate-copy",
            text: thread.members.length <= 1
              ? t("gc.social.group.leaveLast")
              : t("gc.social.group.leaveNote"),
          }),
          modalOnly: true,
          actions: [
            {
              class: "button button-danger", text: t("gc.controls.leave"),
              onPress: async () => {
                try {
                  await api(`/api/conversations/${id}`, { method: "DELETE" });
                  await loadConversations();
                  router.navigate("/friends");
                } catch { /* the list remains; nothing to undo */ }
              },
            },
            { class: "button button-quiet", text: t("gc.controls.stay") },
          ],
        });
      },
    }));
  return wrap;
}
