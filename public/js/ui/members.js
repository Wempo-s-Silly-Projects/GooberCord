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

// The members lane: the roster pane (the shell's right rail), the member card
// route, and the nickname writes. Contract truth:
//   GET /api/servers/:id/roster          -> roster envelope (§3)
//   PATCH /api/servers/:id/nick          -> self, { nickname: null|""|string }
//   PATCH /api/servers/:id/nick/:uid     -> staff (KICK_MEMBERS+MANAGE_ROLES+position)
// The roster is a LINK list (G-7): rows offer themselves and open the member
// card route; the card carries the actions. Mod fields render for staff
// eyes only (owner or KICK_MEMBERS) — zero mod bits means the fields never
// render at all, not disabled ones.
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createForm, createInput } from "../vendor/designer/kit.mjs";
import { openDialog } from "../vendor/frontload/dom.mjs";
import * as router from "../core/router.js";
import { renderShell, refreshServers } from "./shell.js";
import { startConversation } from "./social.js";
import { memberModControls } from "./mod.js";
import { t } from "../i18n.js";

const rosterKey = (serverId) => `roster:${serverId}`;

// loadRoster(serverId) — the roster envelope into the store's per-server
// entry. A refusal leaves the previous cache (or nothing) and rethrows so the
// pane can render the shared 403 string inline (G-3: never a fake empty list).
export async function loadRoster(serverId) {
  const payload = await api(`/api/servers/${serverId}/roster`);
  store.set({ [rosterKey(serverId)]: payload });
  return payload;
}

export function rosterOf(serverId) {
  return store.get(rosterKey(serverId)) || null;
}

// avatarPaint(url, name) — the wave-18 avatar seat. The src is the
// payload's OWN URL, verbatim (the ?v= cache key rides inside it); a null
// or non-string arm paints NOTHING (no placeholder, no invented initials
// block — presence-of-avatar-only). A load failure removes the img itself,
// leaving the row's shape intact (the attachment-404 idiom, chat.js family).
function avatarPaint(url, name) {
  if (!url || typeof url !== "string") return null;
  return h("img", {
    class: "member-avatar", src: url, alt: name || "", loading: "lazy",
    onError: (event) => event.currentTarget.remove(),
  });
}

export const staffViewing = (payload) => !!(payload?.viewer?.owner
  || payload?.viewer?.permissions?.includes("KICK_MEMBERS"));

const canManage = (payload) => !!(payload?.viewer?.owner
  || payload?.viewer?.permissions?.includes("MANAGE_ROLES"));

// renderRosterBody(pane, serverId) — the members rail's body for an active
// server. The rail is a list of self-offering links; the card route holds
// every action. Blocks re-sorted by top position and colored by the member's
// top role.
export function renderRosterBody(pane, serverId) {
  const payload = rosterOf(serverId);
  if (!payload) {
    loadRoster(serverId).then(() => {
      if (rosterOf(serverId)) {
        pane.replaceChildren();
        renderRosterBody(pane, serverId);
      }
    }).catch((error) => {
      pane.replaceChildren();
      pane.append(h("p", { class: "empty-state", text: error.message }));
    });
    pane.append(h("p", { class: "empty-state", text: t("gc.settings.roles.fetchingRoster") }));
    return;
  }
  const staff = staffViewing(payload);
  const cardUrl = (id) => `/s/${serverId}/member/${id}`;
  const members = payload.members.toSorted((a, b) => b.topPosition - a.topPosition);
  if (members.length <= 1) {
    pane.append(h("p", {
      class: "empty-state",
      text: t("gc.members.roster.alone"),
    }), h("a", { class: "control-quiet", href: "/join", text: t("gc.members.roster.inviteLink") }));
    return;
  }
  for (const member of members) {
    pane.append(h("a", {
      class: "member-row", href: cardUrl(member.id),
      title: member.nickname ? `${member.nickname} (${member.username})` : member.username,
      "aria-label": member.nickname || member.username,
    },
    avatarPaint(member.avatarUrl, member.nickname || member.username),
    h("span", {
      class: "member-dot",
      style: member.color ? `--member-color:${member.color}` : undefined,
    }),
    h("span", { class: "member-name", text: member.nickname || member.username }),
    member.isPlus ? h("span", { class: "mark-plus", title: "Goober+", text: "+" }) : null,
    member.timedOutUntil && staff ? h("span", {
      class: "mark-muted", title: member.timedOutUntil, text: t("gc.members.card.timedOut"),
    }) : null));
  }
}

// saveNickname(serverId, uid, nickname) — the two nick writes share one body
// grammar ({ nickname: null|""|string }); a word-filter or shape 400 keeps
// the caller's input (the form is not cleared) and its error renders verbatim.
export async function saveNickname(serverId, uid, nickname) {
  const path = uid === null
    ? `/api/servers/${serverId}/nick`
    : `/api/servers/${serverId}/nick/${uid}`;
  const result = await api(path, {
    method: "PATCH", body: { nickname: nickname === null ? null : String(nickname) },
  });
  const cached = rosterOf(serverId);
  if (cached) {
    store.set({ [rosterKey(serverId)]: {
      ...cached,
      members: cached.members.map((member) => member.id === (result?.member?.userId ?? uid)
        ? { ...member, nickname: result?.member?.nickname ?? null }
        : member),
    } });
  }
  return result;
}

function nicknameForm(serverId, uid, current, onDone) {
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  const field = createInput(document, {
    id: "nickname-input", label: uid === null
      ? t("gc.members.card.nicknameLabel") : t("gc.members.card.nicknameHeading"),
    description: t("gc.members.card.nicknameHelp"), value: current || "",
  });
  const form = createForm(document, "nickname", [field], t("gc.members.card.saveNickname"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = form.querySelector("#nickname-input").value.trim();
    try {
      await saveNickname(serverId, uid, raw === "" ? null : raw);
      errorLine.textContent = "";
      onDone?.();
    } catch (error) {
      errorLine.textContent = error.message; // verbatim (G-2): input stays
    }
  });
  return h("div", { class: "panel" }, h("h3", { text: t("gc.members.card.nicknameHeading") }), form, errorLine);
}

// leavePanel — the own card's exit: one destructive confirm, then the plain
// POST of the frozen leave route. The owner's refusal (the server's 409 body
// naming the transfer route) and every other failure land VERBATIM in the
// error lane (G-2 — the client never re-words); success re-reads the servers
// lane through refreshServers and walks home.
function leavePanel(serverId) {
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  return h("div", { class: "panel panel-danger" },
    h("h3", { text: t("gc.members.leave.heading") }),
    h("button", {
      class: "button button-danger", type: "button", text: t("gc.members.leave.button"),
      onclick: () => openDialog(document, {
        heading: t("gc.members.leave.confirmTitle"),
        body: h("p", { class: "gate-copy", text: t("gc.members.leave.confirmBody") }),
        modalOnly: true,
        actions: [
          { class: "button button-danger", text: t("gc.members.leave.action"), onPress: async () => {
            try {
              await api(`/api/servers/${serverId}/leave`, { method: "POST" });
              // The roster cache dies with the membership (mod.js kick's
              // idiom) — a leave→rejoin in this session never serves the
              // stale cached envelope.
              store.set({ [rosterKey(serverId)]: null });
              await refreshServers();
              router.navigate("/");
            } catch (error) {
              errorLine.textContent = error.message; // verbatim (G-2)
            }
          } },
          { class: "button button-quiet", text: t("gc.controls.keep") },
        ],
      }),
    }),
    errorLine);
}

// renderMemberCard(route, mount) — the "/s/:serverId/member/:uid" task page
// (G-6: a route, never a dialog stack). Fields, then the affordances the
// viewer actually has.
export function renderMemberCard(route, mount) {
  const serverId = Number(route.params.serverId);
  const uid = Number(route.params.uid);
  const payload = rosterOf(serverId);
  const me = store.get("user");
  const card = h("section", { class: "task-page" });

  if (!payload) {
    card.append(h("p", { class: "empty-state", text: t("gc.settings.roles.fetchingRoster") }));
    loadRoster(serverId).then(() => routerRerender()).catch((error) => {
      card.replaceChildren(h("p", { class: "empty-state", text: error.message }));
    });
    mount.append(renderShellAroundCard(card));
    return;
  }

  const member = payload.members.find((entry) => entry.id === uid);
  if (!member) {
    card.append(h("p", {
      class: "empty-state", text: t("gc.members.errors.notMember"),
    }));
    mount.append(renderShellAroundCard(card));
    return;
  }

  const staff = staffViewing(payload);
  const roles = payload.roles.filter((role) => member.roleIds.includes(role.id));

  // The card's avatar seat: the roster row's own field first; the signed-in
  // member's OWN card falls to the store's user payload (publicUser's
  // avatarUrl — main.js's session write seats it at store.get("user"))
  // when the row carries none. Both arms are payload-carried URLs, verbatim.
  const cardAvatarUrl = member.avatarUrl || (me && me.id === uid
    && typeof me.avatarUrl === "string" ? me.avatarUrl : null);
  const cardName = member.nickname || member.username;

  card.append(
    avatarPaint(cardAvatarUrl, cardName),
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: cardName })),
    h("p", { class: "muted", text: member.nickname && member.nickname !== member.username
      ? member.username : t("gc.members.card.noNickname") }),
    h("div", { class: "chip-row" },
      ...roles.map((role) => h("span", {
        class: "chip", style: role.color ? `--member-color:${role.color}` : undefined,
        text: role.name,
      })),
      member.isPlus ? h("span", { class: "chip mark-plus", text: "Goober+" }) : null,
      member.timedOutUntil ? h("span", {
        class: "chip mark-muted",
        text: t("gc.members.card.timedOutUntil") + " " + member.timedOutUntil,
      }) : null,
      payload.server.hasRules && member.rulesAccepted ? h("span", {
        class: "chip mark-muted", text: t("gc.members.card.rulesAccepted"),
      }) : null,
      member.verificationEligible ? h("span", {
        class: "chip mark-muted", text: t("gc.members.card.verificationPending"),
      }) : null),
    h("p", { class: "muted", text: t("gc.members.card.joined") + " " + member.joinedAt
      + " " + t("gc.members.card.accountMade") + " " + member.accountCreatedAt }),
  );

  // Staff-only fields (C5), NEVER hidden-but-rendered for plain members.
  if (staff && (member.createdByInvite || member.verificationEligible)) {
    const notes = [member.createdByInvite
      ? t("gc.members.card.viaInvite") + " " + member.createdByInvite : null,
    member.verificationEligible ? t("gc.members.card.owesVerification") : null]
      .filter(Boolean);
    card.append(h("div", { class: "panel staff-notes" },
      h("h3", { text: t("gc.members.card.notesHeading") }),
      h("ul", {}, ...notes.map((note) => h("li", { text: note })))));
  }

  if (me && me.id === uid) {
    card.append(nicknameForm(serverId, null, member.nickname, routerRerender));
    // The own card's exit door (wave 9): the leave control lives on the
    // signed-in member's self surface and nowhere else (no stranger's card,
    // no staff surface).
    card.append(leavePanel(serverId));
  } else if (canManage(payload) && member.topPosition < payload.viewer.topPosition) {
    card.append(nicknameForm(serverId, uid, member.nickname, routerRerender));
  }

  card.append(h("div", { class: "affordance-row" },
    h("a", { class: "control-quiet", href: "/friends", text: t("gc.social.friends.heading") }),
    startDmControl(serverId, member)));

  // The W-R3 mod actions (timeout/kick/ban/rules-verify) — null unless the
  // viewer outranks the row (owner rows immune, self rows carry none); the
  // card re-renders off the roster refetch each write's onDone.
  const modControls = memberModControls(payload, member, routerRerender);
  if (modControls) card.append(modControls);

  mount.append(renderShellAroundCard(card));
}

// startDmControl — the quiet Message affordance; the DM attempt's 403/400
// shapes flow back inline on the card (the blocked-pair and friends-gate
// texts are the contract's, never paraphrased).
function startDmControl(serverId, member) {
  const link = h("a", {
    class: "control-quiet", href: "#", text: t("gc.social.row.message"),
    onclick: async (event) => {
      event.preventDefault();
      try {
        await startConversation(member.id);
      } catch (error) {
        link.textContent = error.message; // inline, verbatim
      }
    },
  });
  return link;
}

// routerRerender — the card re-reads the store the cheap way: re-running the
// current route's render through the router (avoids cross-module DOM reaches).
function routerRerender() {
  if (router.current()) router.renderCurrent();
}

// renderShellAroundCard(card) — the task page reuses the shell frame with the
// card in the main pane (members rail stays live beside it).
function renderShellAroundCard(card) {
  const pane = h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, card));
  return renderShell(null, pane);
}
