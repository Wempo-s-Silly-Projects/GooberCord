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

// The mod desk — AutoMod rules (the 0010 grammar AS SHIPPED), the alerts
// feed, bans/timeout/kick, prune, rules verification, and the staff
// attachment queue (§W-R3 C). Guards are owner OR the bit AND outrank, owner
// rows immune — controls render only where the roster's viewer.permissions +
// topPosition imply them; the server's 403/404 texts always render verbatim
// on mismatch (the server is truth). All cap numbers are mirrored constants
// with equality pins (G-4); the terms editor is the ONE-PER-LINE TEXTAREA
// (the string arm) — 1000 lines × 60 chars is not a chip-field job (G-7).
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createForm, createInput, createSelect } from "../vendor/designer/kit.mjs";
import { openDialog } from "../vendor/frontload/dom.mjs";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { rosterOf, loadRoster, staffViewing } from "./members.js";
import { t } from "../i18n.js";

// --- mirrored constants (G-4: equality pins against the backend's exports) ----

export const UI_TIMEOUT_MINUTE_CHOICES = [1, 5, 10, 60, 1440, 10080, 40320];
export const UI_FILTER_RULE_MAX = 10;
export const UI_FILTER_RULE_NAME_MAX = 64;
export const UI_FILTER_RULE_MAX_TERMS = 1000;
export const UI_FILTER_RULE_TERM_CHARS = 60;
export const UI_FILTER_RULE_BLOCK_MESSAGE_MAX = 150;
export const UI_FILTER_RULE_EXEMPT_ROLES_MAX = 20;
export const UI_FILTER_RULE_EXEMPT_CHANNELS_MAX = 50;
export const UI_FILTER_ALERTS_PAGE_MAX = 100;
export const UI_FILTER_ALERTS_DEFAULT = 50;
export const UI_BAN_REASON_MAX = 280;
export const UI_FILTER_RULE_ACTIONS = ["block", "alert", "timeout"];
export const UI_ALERT_PREVIEW_MAX = 280;

// --- the viewer gate ----------------------------------------------------------

export function canModerate(payload) {
  return staffViewing(payload); // owner OR KICK_MEMBERS (the desk's viewer class)
}

function inlineError() {
  return h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
}

function shellWrap(pane) {
  return renderShell(null, pane);
}

function taskBody(serverId, heading) {
  return h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: heading })));
}

// The desk gate: the roster tells the truth; a refusal or a plain member
// renders the shared 403 string (G-3) — never a fabricated form.
function deskGate(mount, serverId, build) {
  const roster = rosterOf(serverId);
  const ensure = roster ? Promise.resolve(roster) : loadRoster(serverId);
  ensure.then((payload) => {
    const body = taskBody(serverId, t("gc.settings.sections.mod"));
    if (!payload || !canModerate(payload)) {
      body.append(h("p", { class: "empty-state",
        text: t("gc.settings.errors.permission") }));
    } else {
      build(payload, body);
    }
    mount.append(shellWrap(h("section", { class: "pane-main task-main" },
      h("div", { class: "pane-body" }, body))));
  }).catch((error) => {
    mount.append(shellWrap(h("section", { class: "pane-main task-main" },
      h("div", { class: "pane-body" },
        h("section", { class: "task-page" }, h("p", { class: "empty-state",
          text: error.message }))))));
  });
}

// --- the desk route -----------------------------------------------------------

export function renderModDesk(route, mount) {
  const serverId = Number(route.params.serverId);
  deskGate(mount, serverId, (payload, body) => {
    body.append(
      h("nav", { class: "manage-nav", "aria-label": t("gc.mod.sections.heading") },
        h("a", { href: `/s/${serverId}/settings`, text: t("gc.settings.nav.server") }),
        h("a", { href: `/s/${serverId}/channels`, text: t("gc.shell.nav.channels") }),
        h("a", { href: `/s/${serverId}/roles`, text: t("gc.settings.roles.heading") }),
        h("a", { href: `/s/${serverId}/invites`, text: t("gc.settings.invites.heading") }),
        h("a", { href: `/s/${serverId}/expressions`, text: t("gc.settings.nav.expressions") })),
      rulesPanel(serverId),
      alertsPanel(serverId),
      bansPanel(serverId, payload),
      prunePanel(serverId, payload));
  });
}

// --- AutoMod rules ---------------------------------------------------------------

function rulesPanel(serverId) {
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.mod.automod.heading") }));
  api(`/api/servers/${serverId}/filter/rules`).then(({ rules }) => {
    if (rules.length === 0) {
      panel.append(h("p", { class: "empty-state",
        text: t("gc.mod.automod.empty") }));
    }
    panel.append(h("div", { class: "manage-rows" }, ...rules.map((rule) =>
      h("a", {
        class: "member-row rule-row", href: `/s/${serverId}/filter/rules/${rule.id}`,
        title: `${rule.name} — ${t("gc.mod.rules.editTail")}`,
      },
      h("span", { class: "expr-name", text: rule.name }),
      h("span", { class: "muted", text: ruleActionText(rule) })))));
    if (rules.length >= UI_FILTER_RULE_MAX) {
      panel.append(h("p", { class: "empty-state cap-line cap-line-off",
        text: t("gc.mod.automod.full", { max: UI_FILTER_RULE_MAX }) }));
    } else {
      panel.append(h("div", { class: "affordance-row" },
        h("a", { class: "control-quiet",
          href: `/s/${serverId}/filter/rules/new`, text: t("gc.mod.rules.new") })));
    }
  }).catch((error) => {
    panel.append(h("p", { class: "form-error", text: error.message }));
  });
  return panel;
}

function ruleActionText(rule) {
  const actions = (rule.actions || []).join(" + ") || t("gc.mod.rules.noActions");
  return rule.isCare ? `${actions} · ${t("gc.mod.rules.careSuffix")}` : actions;
}

// The rule editor route: /s/:id/filter/rules/:rid ("new" = create). The
// terms input is the ONE-PER-LINE TEXTAREA (the string arm), bound at
// 1000 lines × 60 chars — the counter counts both and the maxlength seats
// the characters; the server's 400 remains the truth after any client slip.
export function renderFilterRule(route, mount) {
  const serverId = Number(route.params.serverId);
  const rid = route.params.rid;
  deskGate(mount, serverId, (payload, body) => {
    body.append(ruleEditor(serverId, rid, rid === "new", payload));
  });
}

function ruleEditor(serverId, rid, isNew, payload) {
  const errorLine = inlineError();
  const panel = h("div", { class: "panel" },
    h("h3", { text: isNew ? t("gc.mod.rules.new") : t("gc.mod.rules.edit") }));
  const nameBox = createInput(document, {
    id: "rule-name", label: t("gc.mod.rules.nameLabel"),
    maxLength: String(UI_FILTER_RULE_NAME_MAX),
    description: t("gc.mod.rules.nameHelp"),
  });
  const counter = h("p", { class: "muted count-line", text: t("gc.mod.rules.termsHelp") });
  const termsBox = h("textarea", {
    id: "rule-terms", rows: "10",
    maxlength: String(UI_FILTER_RULE_TERM_CHARS * UI_FILTER_RULE_MAX_TERMS),
    "aria-label": t("gc.mod.rules.termsField"), placeholder: t("gc.mod.rules.termsPlaceholder"),
  });
  termsBox.addEventListener("input", () => {
    const lines = termsBox.value.split("\n").length;
    // "Stops accepting input at the bound": trim back to the line seat.
    if (lines > UI_FILTER_RULE_MAX_TERMS) {
      termsBox.value = termsBox.value.split("\n").slice(0, UI_FILTER_RULE_MAX_TERMS).join("\n");
    }
    counter.textContent = t("gc.mod.rules.termsCount", {
      lines: termsBox.value.split("\n").length,
      chars: `${termsBox.value.length} / ${UI_FILTER_RULE_TERM_CHARS * UI_FILTER_RULE_MAX_TERMS}`,
    }) + " " + t("gc.mod.rules.termsHint");
  });
  const actionBoxes = UI_FILTER_RULE_ACTIONS.map((action) =>
    h("label", { class: "check-inline" },
      h("input", { type: "checkbox", name: "rule-actions", value: action }),
      h("span", { text: action })));
  const timeout = createSelect(document, {
    id: "rule-timeout", label: t("gc.mod.rules.timeoutLabel"),
    options: UI_TIMEOUT_MINUTE_CHOICES.map((minutes) => ({
      value: String(minutes), label: String(minutes),
    })),
  });
  timeout.querySelector("select").value = String(10);
  const blockMessage = createInput(document, {
    id: "rule-block-message", label: t("gc.mod.rules.blockMessageLabel"),
    maxLength: String(UI_FILTER_RULE_BLOCK_MESSAGE_MAX),
    description: t("gc.mod.rules.blockMessageHelp", { max: UI_FILTER_RULE_BLOCK_MESSAGE_MAX }),
  });
  const careBox = h("label", { class: "check-inline" },
    h("input", { type: "checkbox", id: "rule-care" }),
    h("span", { text: t("gc.mod.rules.careFlag") }));
  const namesBox = h("label", { class: "check-inline" },
    h("input", { type: "checkbox", id: "rule-names" }),
    h("span", { text: t("gc.mod.rules.screenNicknames") }));
  const exempt = exemptPicker(payload, form);

  const form = createForm(document, "filter-rule",
    [nameBox,
      h("div", { class: "form-field" },
        h("label", { for: "rule-terms", text: t("gc.mod.rules.termsLabel") }), termsBox, counter),
      h("div", { class: "bit-grid" }, ...actionBoxes),
      timeout, blockMessage,
      h("div", { class: "bit-grid check-inline-pair" }, careBox, namesBox),
      ...exempt.nodes], t("gc.mod.rules.save"));

  if (!isNew) {
    // The read-back rides the rules GET (the rule's own seat in the envelope).
    api(`/api/servers/${serverId}/filter/rules`).then(({ rules }) => {
      const rule = rules.find((entry) => String(entry.id) === String(rid));
      if (!rule) return;
      nameBox.querySelector("input").value = rule.name;
      termsBox.value = (rule.terms || []).map((term) => term.text).join("\n");
      for (const box of form.querySelectorAll("input[name='rule-actions']")) {
        box.checked = (rule.actions || []).includes(box.value);
      }
      timeout.querySelector("select").value = String(rule.timeoutMinutes ?? 10);
      blockMessage.querySelector("input").value = rule.blockMessage || "";
      form.querySelector("#rule-care").checked = !!rule.isCare;
      form.querySelector("#rule-names").checked = !!rule.checkNames;
      exempt.sync(rule);
    }).catch((error) => { errorLine.textContent = error.message; });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      name: nameBox.querySelector("input").value,
      terms: termsBox.value, // the ONE-PER-LINE STRING ARM
      timeoutMinutes: Number(timeout.querySelector("select").value),
    };
    body.actions = [...form.querySelectorAll("input[name='rule-actions']")]
      .filter((box) => box.checked).map((box) => box.value);
    const message = blockMessage.querySelector("input").value.trim();
    body.blockMessage = message === "" ? null : message;
    body.isCare = form.querySelector("#rule-care").checked === true;
    body.checkNames = form.querySelector("#rule-names").checked === true;
    body.exemptRoleIds = exempt.roleIds();
    body.exemptChannelIds = exempt.channelIds();
    try {
      if (isNew) {
        await api(`/api/servers/${serverId}/filter/rules`, { method: "POST", body });
      } else {
        await api(`/api/servers/${serverId}/filter/rules/${rid}`, { method: "PUT", body });
      }
      router.navigate(`/s/${serverId}/mod`);
    } catch (error) {
      errorLine.textContent = error.message; // cap 400 / 403 / name bound verbatim
    }
  });
  panel.append(form, errorLine);
  return panel;
}

// Exempt roles/channels: checkbox groups bounded by the contract's seats
// (≤ 20 roles / ≤ 50 channels, validated as THIS server's ids — the boxes
// only ever list this server's own rows).
function exemptPicker(payload, form, rid) {
  const roles = payload.roles || [];
  const server = (store.get("servers") || []).find((entry) => entry.id);
  const channels = (server?.channels) || [];
  const roleBoxes = roles.map((role) =>
    h("label", { class: "check-inline" },
      h("input", { type: "checkbox", name: "exempt-roles", value: String(role.id) }),
      h("span", { text: role.name })));
  const channelBoxes = channels.map((channel) =>
    h("label", { class: "check-inline" },
      h("input", { type: "checkbox", name: "exempt-channels", value: String(channel.id) }),
      h("span", { text: channel.name ? `#${channel.name}` : `#${channel.id}` })));
  const nodes = [];
  if (roles.length > 0) {
    nodes.push(h("p", {
      class: "muted", text: t("gc.mod.rules.exemptRoles", { max: UI_FILTER_RULE_EXEMPT_ROLES_MAX }),
    }),
      h("div", { class: "bit-grid" }, ...roleBoxes));
  }
  if (channels.length > 0) {
    nodes.push(h("p", {
      class: "muted", text: t("gc.mod.rules.exemptChannels", { max: UI_FILTER_RULE_EXEMPT_CHANNELS_MAX }),
    }),
      h("div", { class: "bit-grid" }, ...channelBoxes));
  }
  return {
    nodes,
    sync(rule) {
      for (const box of form.querySelectorAll("input[name='exempt-roles']")) {
        box.checked = (rule.exemptRoleIds || []).map(String).includes(box.value);
      }
      for (const box of form.querySelectorAll("input[name='exempt-channels']")) {
        box.checked = (rule.exemptChannelIds || []).map(String).includes(box.value);
      }
    },
    roleIds() {
      return [...form.querySelectorAll("input[name='exempt-roles']:checked")]
        .map((box) => Number(box.value));
    },
    channelIds() {
      return [...form.querySelectorAll("input[name='exempt-channels']:checked")]
        .map((box) => Number(box.value));
    },
  };
}

// --- alerts ---------------------------------------------------------------------

function alertsPanel(serverId) {
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.mod.alerts.heading") }));
  api(`/api/servers/${serverId}/filter/alerts?limit=${UI_FILTER_ALERTS_DEFAULT}`).then(({ alerts }) => {
    if (alerts.length === 0) {
      panel.append(h("p", { class: "empty-state", text: t("gc.mod.alerts.empty") }));
      return;
    }
    panel.append(h("div", { class: "manage-rows" },
      ...alerts.map((alert) => alertRow(serverId, alert))));
  }).catch((error) => {
    panel.append(h("p", { class: "form-error", text: error.message })); // the limit 400 verbatim
  });
  return panel;
}

// Rows jump to the message along the channel route; a row without a live
// channel renders the channel id placeholder as plain text (the chat wave
// owns the deep-link highlight).
function alertRow(serverId, alert) {
  const jump = alert.channelId
    ? h("a", { href: `/s/${serverId}/${alert.channelId}`, title: alert.ruleName },
      h("span", { class: "alert-body", text: alertBody(alert) }))
    : h("span", { class: "muted", text: t("gc.mod.alerts.channel",
      { channel: alert.channelId || t("gc.mod.alerts.unknown") }) });
  return h("div", { class: "alert-row" },
    h("span", { class: "alert-meta", text: `${alert.username} · ${alert.ruleName} · ${alert.createdAt}` }),
    jump,
    h("span", { class: "muted", text: alert.matched
      ? t("gc.mod.alerts.matched", { matched: alert.matched }) : "" }));
}

const alertBody = (alert) => (alert.body || "").slice(0, UI_ALERT_PREVIEW_MAX);

// --- bans -------------------------------------------------------------------------

function bansPanel(serverId, payload) {
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.mod.bans.heading") }));
  // The ban list rides the roster's own `bans` key (owner-or-KICK_MEMBERS
  // only) — never requested separately for viewers the shape excludes.
  const bans = payload.bans || [];
  if (bans.length === 0) {
    panel.append(h("p", { class: "empty-state", text: t("gc.mod.bans.empty") }));
  }
  panel.append(h("div", { class: "manage-rows" }, ...bans.map((ban) =>
    h("div", { class: "manage-row" },
      h("span", { class: "expr-name", text: ban.username || t("gc.social.blocks.member", { id: ban.id }) }),
      h("span", { class: "muted", text: `${ban.reason ? ban.reason + " · " : ""}${ban.bannedAt}` }),
      h("span", { class: "row-controls" },
        h("button", { class: "row-quiet-control", type: "button", text: t("gc.mod.bans.unban"),
          onClick: async () => {
            try {
              await api(`/api/servers/${serverId}/bans/${ban.id}`, { method: "DELETE" });
              errorLine.textContent = "";
              await loadRoster(serverId);
              router.renderCurrent();
            } catch (error) {
              errorLine.textContent = error.message; // the shared 403 verbatim
            }
          } }))))));

  // The ban write: user_id WITHOUT coercion + reason ≤ BAN_REASON_MAX.
  const errorLine = inlineError();
  const idBox = createInput(document, {
    id: "ban-user-id", label: t("gc.mod.bans.byIdHeading"),
    description: t("gc.mod.bans.byIdHelp"),
  });
  const reasonBox = createInput(document, {
    id: "ban-reason", label: t("gc.mod.bans.reasonLabel"), maxLength: "280",
  });
  const form = createForm(document, "ban-form", [idBox, reasonBox], t("gc.mod.bans.button"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = idBox.querySelector("input").value.trim();
    const reason = reasonBox.querySelector("input").value;
    const body = /^\d+$/.test(raw)
      ? { user_id: Number(raw) }
      : { user_id: raw }; // no coercion — the server's shape 400 is the truth
    if (reason) body.reason = reason;
    try {
      await api(`/api/servers/${serverId}/bans`, { method: "POST", body });
      errorLine.textContent = "";
      await loadRoster(serverId);
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message; // self 400 / shape 400 / 403 verbatim
    }
  });
  panel.append(form, errorLine);
  return panel;
}

// --- prune -----------------------------------------------------------------------

function prunePanel(serverId, payload) {
  const errorLine = inlineError();
  const resultLine = h("p", { class: "muted count-line", text: "" });
  const days = createSelect(document, {
    id: "prune-days", label: t("gc.mod.prune.windowLabel"),
    options: [
      { value: "7", label: t("gc.mod.prune.days7") },
      { value: "30", label: t("gc.mod.prune.days30") },
    ],
  });
  const roleFilter = createSelect(document, {
    id: "prune-role", label: t("gc.mod.prune.roleFilterLabel"),
    options: [{ value: "", label: t("gc.mod.prune.anyRole") },
      ...(payload.roles || []).map((role) => ({ value: String(role.id), label: role.name }))],
  });
  const rules = h("p", { class: "muted", text: t("gc.mod.prune.candidates") });
  const dryRun = h("button", { class: "button button-primary", type: "button",
    text: t("gc.mod.prune.dryRun") });
  const pruneBody = () => ({
    days: Number(days.querySelector("select").value),
    dry_run: false,
    ...(roleFilter.querySelector("select").value
      ? { role_filter_id: Number(roleFilter.querySelector("select").value) } : {}),
  });
  dryRun.addEventListener("click", async () => {
    try {
      const result = await api(`/api/servers/${serverId}/prune`, {
        method: "POST",
        body: { ...pruneBody(), dry_run: true },
      });
      openDialog(document, {
        heading: t("gc.mod.prune.confirm", { count: result.count }),
        body: rules, // the confirm carries the count and the rules
        modalOnly: true,
        actions: [
          { class: "button button-danger", text: t("gc.mod.prune.run"), onPress: async () => {
            const run = await api(`/api/servers/${serverId}/prune`,
              { method: "POST", body: pruneBody() });
            resultLine.textContent = t("gc.mod.prune.result", { count: run.kicked });
            await loadRoster(serverId);
            router.renderCurrent();
          } },
          { class: "button button-quiet", text: t("gc.controls.keep") },
        ],
      });
    } catch (error) {
      errorLine.textContent = error.message; // the shape 400s verbatim
    }
  });
  return h("div", { class: "panel" }, h("h3", { text: t("gc.mod.prune.heading") }), rules,
    days, roleFilter, dryRun, resultLine, errorLine);
}

// --- the staff attachment queue (platform staff only; the check is server-side) ----

export function renderStaffQueue(route, mount) {
  const user = store.get("user");
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: "/", text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.mod.queue.heading") })));
  if (!user || !["admin", "owner"].includes(user.role)) {
    body.append(h("p", { class: "empty-state",
      text: t("gc.settings.errors.permission") }));
    mount.append(shellWrap(h("section", { class: "pane-main task-main" },
      h("div", { class: "pane-body" }, body))));
    return;
  }
  api("/api/admin/attachments").then(({ attachments }) => {
    if (attachments.length === 0) {
      body.append(h("p", { class: "empty-state", text: t("gc.mod.queue.empty") }));
    }
    body.append(h("div", { class: "manage-rows" },
      ...attachments.map((attachment) => queueRow(attachment, body))));
  }).catch((error) => {
    body.append(h("p", { class: "form-error", text: error.message }));
  });
  mount.append(shellWrap(h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body))));
}

function queueRow(attachment, body) {
  return h("div", { class: "manage-row" },
    h("span", { class: "expr-name", text: `#${attachment.id}` }),
    h("span", { class: "muted", text: t("gc.mod.queue.summary", {
      name: attachment.uploaderName,
      bytes: attachment.sizeBytes,
      mime: attachment.mime,
      createdAt: attachment.createdAt,
    }) }),
    h("span", { class: "row-controls" },
      h("button", { class: "row-quiet-control", type: "button", text: t("gc.mod.queue.approve"),
        onClick: async () => {
          try {
            await api(`/api/admin/attachments/${attachment.id}/approve`, { method: "POST" });
            router.renderCurrent();
          } catch (error) {
            body.append(h("p", { class: "form-error", text: error.message })); // 404 verbatim
          }
        } }),
      h("button", { class: "row-quiet-control", type: "button", text: t("gc.mod.queue.reject"),
        onClick: () => {
          openDialog(document, {
            heading: t("gc.mod.queue.rejectConfirm", { id: attachment.id }),
            body: h("p", { class: "gate-copy", text: t("gc.mod.queue.rejectNote") }),
            modalOnly: true,
            actions: [
              { class: "button button-danger", text: t("gc.mod.queue.reject"), onPress: async () => {
                await api(`/api/admin/attachments/${attachment.id}/reject`, { method: "POST" });
                router.renderCurrent();
              } },
              { class: "button button-quiet", text: t("gc.controls.keep") },
            ],
          });
        } })));
}

// --- the member card's mod actions (consumed by members.js) -----------------------

// timeoutMember / clearTimeout / kickMember / banMember / verifyMember — the
// five contract writes; the card's controls render only where the viewer
// outranks (owner rows immune, self rows carry no mod controls).
export async function timeoutMember(serverId, uid, minutes) {
  return api(`/api/servers/${serverId}/members/${uid}/timeout`, {
    method: "PUT", body: { minutes },
  });
}

export async function clearTimeout_(serverId, uid) {
  return api(`/api/servers/${serverId}/members/${uid}/timeout`, { method: "DELETE" });
}

export async function kickMember(serverId, uid) {
  return api(`/api/servers/${serverId}/members/${uid}`, { method: "DELETE" });
}

export async function banMember(serverId, uid, reason) {
  const body = { user_id: Number(uid) };
  if (reason) body.reason = reason;
  return api(`/api/servers/${serverId}/bans`, { method: "POST", body });
}

export async function verifyMember(serverId, uid) {
  return api(`/api/servers/${serverId}/members/${uid}/rules-verify`, { method: "POST" });
}

// The card's quiet mod block; null when the viewer cannot act on this row
// (self rows, owner rows, and rows above the viewer's position stay clean).
export function memberModControls(payload, member, onDone) {
  const me = store.get("user");
  const viewer = payload?.viewer;
  if (!me || !viewer) return null;
  const self = me.id === member.id;
  const immune = member.membershipRole === "owner";
  const outranks = viewer.owner || member.topPosition < viewer.topPosition;
  if (self || immune || !outranks || !canModerate(payload)) return null;
  const errorLine = inlineError();
  const rerun = async (fn) => {
    try {
      await fn();
      errorLine.textContent = "";
      onDone?.();
    } catch (error) {
      errorLine.textContent = error.message; // verbatim, always
    }
  };
  const timeout = createSelect(document, {
    id: "mod-timeout", label: t("gc.mod.timeout.label"),
    options: [
      ...UI_TIMEOUT_MINUTE_CHOICES.map((minutes) => ({
        value: String(minutes), label: t("gc.mod.timeout.choice", { count: minutes }),
      })),
      { value: "clear", label: t("gc.mod.bans.clearTimeout") },
    ],
  });
  const timeoutButton = h("button", { class: "control-quiet row-quiet-inline",
    type: "button", text: t("gc.mod.timeout.apply") });
  timeoutButton.addEventListener("click", async () => {
    const value = timeout.querySelector("select").value;
    if (value === "clear") await rerun(() => clearTimeout_(payload.server.id, member.id));
    else await rerun(() => timeoutMember(payload.server.id, member.id, Number(value)));
  });
  const ban = h("button", { class: "control-quiet row-quiet-inline",
    type: "button", text: t("gc.mod.bans.open") });
  ban.addEventListener("click", () => {
    openDialog(document, {
      heading: t("gc.mod.bans.confirm", { name: member.nickname || member.username }),
      body: h("div", { class: "form-field" }, h("label", {
        for: "ban-card-reason", text: t("gc.mod.bans.reasonLabel") }),
      h("input", { id: "ban-card-reason", maxlength: String(UI_BAN_REASON_MAX) })),
      modalOnly: true,
      actions: [
        { class: "button button-danger", text: t("gc.mod.bans.button"), onPress: async () => {
          const reason = document.getElementById("ban-card-reason")?.value || "";
          await rerun(() => banMember(payload.server.id, member.id,
            reason.trim() === "" ? undefined : reason));
        } },
        { class: "button button-quiet", text: t("gc.controls.keep") },
      ],
    });
  });
  const kick = h("button", { class: "control-quiet row-quiet-inline",
    type: "button", text: t("gc.mod.kick.open") });
  kick.addEventListener("click", () => {
    openDialog(document, {
      heading: t("gc.mod.kick.confirm", { name: member.nickname || member.username }),
      body: h("p", { class: "gate-copy", text: t("gc.mod.kick.note") }),
      modalOnly: true,
      actions: [
        { class: "button button-danger", text: t("gc.mod.kick.button"), onPress: async () => {
          await rerun(() => kickMember(payload.server.id, member.id));
        } },
        { class: "button button-quiet", text: t("gc.controls.keep") },
      ],
    });
  });
  const nodes = [timeout, timeoutButton, ban, kick];
  if (payload.server.hasRules && !member.rulesAccepted) {
    const verify = h("button", { class: "control-quiet row-quiet-inline",
      type: "button", text: t("gc.mod.automod.markVerified") });
    verify.addEventListener("click", async () => {
      await rerun(() => verifyMember(payload.server.id, member.id));
    });
    nodes.push(verify);
  }
  return h("div", { class: "panel mod-controls" },
    h("h3", { text: t("gc.mod.card.heading") }), ...nodes, errorLine);
}
