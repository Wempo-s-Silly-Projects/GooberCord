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

// The server-settings lane — SERVER settings ONLY (the settings wave's scope
// law: no register, no account settings; Accounts owns those). One task page
// per server management area, each a route with a back affordance (G-6):
//   /s/:id/settings    server settings + the rules doc (+ server delete)
//   /s/:id/channels    channels + categories (+ channel counts line)
//   /s/:id/roles       roles list; /s/:id/roles/:rid the one role editor
//   /s/:id/channels/:cid/overwrites  the overwrite editor
//   /s/:id/invites     invites
//   /join              the invite-code door + discovery (member-facing half)
// Every failure renders the payload's error string verbatim inline (G-2);
// caps cite payload values or mirrored constants with pin tests (G-4);
// deletions are single confirmations (G-6); rows never carry buttons (G-7)
// except the hover-revealed quiet writes the members/social lanes share.
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createForm, createInput, createSelect } from "../vendor/designer/kit.mjs";
import { openDialog } from "../vendor/frontload/dom.mjs";
import * as router from "../core/router.js";
import { renderShell, refreshServers } from "./shell.js";
import { guardRulesGate } from "./rules-gate.js";
import { rosterOf, loadRoster } from "./members.js";
import { t } from "../i18n.js";

// --- mirrored constants (G-4: pinned against constants.mjs / the contract) ----

export const UI_SLOWMODE_CHOICES = [0, 900, 1800, 3600, 7200, 21600];
export const UI_SERVER_PERMISSIONS = [
  "MANAGE_CHANNELS", "MANAGE_ROLES", "KICK_MEMBERS", "MANAGE_INVITES", "DELETE_MESSAGES",
  "VIEW", "SEND", "CONNECT", "SPEAK", "BYPASS_SLOWMODE", "ADD_REACTIONS", "MANAGE_EMOJI",
  "MENTION_EVERYONE",
];
export const UI_OVERWRITE_BITS = ["VIEW", "SEND", "CONNECT", "SPEAK", "ADD_REACTIONS"];
export const UI_VERIFICATION_LEVELS = [0, 1, 2, 3, 4];
export const UI_MAX_CHANNELS_PER_SERVER = 500;
export const UI_CATEGORIES_MAX_PER_SERVER = 50;
export const UI_ROLES_MAX = 250; // incl. @everyone, never raised by boosts
export const UI_RULES_MAX = 20000;

// The gear affordance lives where the bits say so: the server's membership
// role, or any channel's effectivePermissions carrying a manage bit.
export function serverAdminRights(server) {
  if (!server) return false;
  if (server.role === "owner" || server.role === "admin") return true;
  return (server.channels || []).some((channel) => (channel.effectivePermissions || [])
    .some((bit) => bit === "MANAGE_CHANNELS" || bit === "MANAGE_ROLES" || bit === "MANAGE_INVITES"));
}

function serverOf(serverId) {
  const serverId_ = Number(serverId);
  return (store.get("servers") || []).find((server) => server.id === serverId_) || null;
}

function inlineError() {
  return h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
}

// The one confirm idiom (G-6: deletions and other irreversible commits).
function confirmDialog(title, bodyText, label, fn) {
  openDialog(document, {
    heading: title,
    body: h("p", { class: "gate-copy", text: bodyText }),
    modalOnly: true,
    actions: [
      { class: "button button-danger", text: label, onPress: fn },
      { class: "button button-quiet", text: t("gc.controls.keep") },
    ],
  });
}

function taskPane(serverId, heading, ...nodes) {
  return h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" },
      h("section", { class: "task-page" },
        h("header", { class: "task-header" },
          h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
          h("h2", { class: "page-heading", text: heading })),
        h("nav", { class: "manage-nav", "aria-label": t("gc.settings.sections.heading") },
          h("a", { href: `/s/${serverId}/settings`, text: t("gc.settings.nav.server") }),
          h("a", { href: `/s/${serverId}/channels`, text: t("gc.shell.nav.channels") }),
          h("a", { href: `/s/${serverId}/roles`, text: t("gc.settings.roles.heading") }),
          h("a", { href: `/s/${serverId}/invites`, text: t("gc.settings.invites.heading") }),
          h("a", { href: `/s/${serverId}/expressions`, text: t("gc.settings.nav.expressions") }),
          h("a", { href: `/s/${serverId}/mod`, text: t("gc.settings.sections.mod") })),
        ...nodes)));
}

function shellWrap(pane) {
  return renderShell(null, pane);
}

// manageGate(serverId, renderTask) — every manage route starts here: the
// viewer without rights sees the shared 403 string inline (G-3), never a
// fabricated form.
function manageGate(mount, serverId, title, build) {
  const server = serverOf(serverId);
  if (!server) {
    refreshServers().then(() => {
      if (serverOf(serverId)) manageGate(mount, serverId, title, build);
      else mount.append(renderShell(null, taskPane(serverId, title,
        h("p", { class: "empty-state", text: t("gc.settings.errors.permission") }))));
    }).catch(() => {
      mount.append(renderShell(null, taskPane(serverId, title,
        h("p", { class: "empty-state", text: t("gc.settings.errors.permission") }))));
    });
    return;
  }
  if (!serverAdminRights(server)) {
    mount.append(renderShell(null, taskPane(serverId, title,
      h("p", { class: "empty-state", text: t("gc.settings.errors.permission") }))));
    return;
  }
  mount.append(shellWrap(taskPane(serverId, title, ...build(server))));
}

// --- E1: the server settings page ---------------------------------------------

export function renderServerSettings(route, mount) {
  const serverId = Number(route.params.serverId);
  manageGate(mount, serverId, t("gc.settings.heading"), (server) => {
    const nodes = [settingsForm(serverId, server), rulesPanel(serverId)];
    if (server.role === "owner") nodes.push(deletePanel(serverId));
    return nodes;
  });
}

function settingsForm(serverId, server) {
  const errorLine = inlineError();
  const nameField = createInput(document, {
    id: "server-name", label: t("gc.settings.name.label"), maxLength: 100, value: server.name,
  });
  const visibility = createSelect(document, {
    id: "server-visibility", label: t("gc.settings.discovery.label"),
    options: [
      { value: "private", label: t("gc.settings.privacy.private") },
      { value: "public", label: t("gc.settings.privacy.public") },
    ],
  });
  visibility.querySelector("select").value = server.isPublic ? "public" : "private";
  const verification = createSelect(document, {
    id: "server-verification", label: t("gc.settings.verification.label"),
    description: t("gc.settings.verification.help"),
    options: UI_VERIFICATION_LEVELS.map((level) => ({ value: String(level), label: String(level) })),
  });
  verification.querySelector("select").value = String(server.verificationLevel ?? 0);
  const form = createForm(document, "server-settings", [nameField, visibility, verification],
    t("gc.settings.save"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = form.querySelector("#server-name").value.trim();
    const isPublic = form.querySelector("#server-visibility").value === "public";
    const verificationLevel = Number(form.querySelector("#server-verification").value);
    const body = {};
    if (name !== server.name) body.name = name;
    if (isPublic !== server.isPublic) body.is_public = isPublic;
    if (verificationLevel !== (server.verificationLevel ?? 0)) body.verification_level = verificationLevel;
    if (Object.keys(body).length === 0) return; // zero-changes is the server's own 403 — send nothing
    try {
      await api(`/api/servers/${serverId}`, { method: "PATCH", body });
      await refreshServers();
      errorLine.textContent = "";
    } catch (error) {
      // The rules gate rides this route's writes too: accept, then re-offer.
      if (!guardRulesGate(document, error, () =>
        api(`/api/servers/${serverId}`, { method: "PATCH", body }).then(() => refreshServers()))) {
        errorLine.textContent = error.message;
      }
    }
  });
  return h("div", { class: "panel" }, h("h3", { text: t("gc.settings.general") }), form, errorLine);
}

function rulesPanel(serverId) {
  const errorLine = inlineError();
  const counter = h("p", { class: "muted", text: "" });
  const docBox = h("textarea", {
    id: "rules-doc", rows: "8", maxlength: String(UI_RULES_MAX),
    "aria-label": t("gc.settings.rules.heading"), placeholder: t("gc.settings.rules.placeholder"),
  });
  docBox.addEventListener("input", () => {
    if (docBox.value.length > UI_RULES_MAX) docBox.value = docBox.value.slice(0, UI_RULES_MAX);
    counter.textContent = docBox.value.length
      ? t("gc.settings.rules.count", { count: docBox.value.length, max: UI_RULES_MAX })
      : t("gc.settings.rules.emptyNote");
  });
  const form = createForm(document, "rules-doc", [h("div", { class: "form-field" },
    h("label", { for: "rules-doc", text: t("gc.settings.rules.heading") }), docBox, counter)],
  t("gc.settings.rules.save"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = docBox.value;
    try {
      await api(`/api/servers/${serverId}`, {
        method: "PATCH", body: { rules_text: text.trim() === "" ? null : text },
      });
      await refreshServers();
      errorLine.textContent = "";
    } catch (error) {
      errorLine.textContent = error.message; // word-filter 400 keeps the text (input intact)
    }
  });
  // The doc reads back via the GET (PATCH never echoes rules_text).
  api(`/api/servers/${serverId}/rules`).then((payload) => {
    if (payload?.rules) {
      docBox.value = payload.rules;
      docBox.dispatchEvent(new Event("input"));
    }
  }).catch(() => { /* an unread doc leaves the editor empty */ });
  return h("div", { class: "panel" }, h("h3", { text: t("gc.settings.gate.heading") }), form, errorLine);
}

function deletePanel(serverId) {
  return h("div", { class: "panel panel-danger" },
    h("h3", { text: t("gc.settings.danger.heading") }),
    h("button", {
      class: "button button-danger", type: "button", text: t("gc.settings.danger.button"),
      onclick: () => confirmDialog(t("gc.settings.danger.confirm"),
        t("gc.settings.danger.body"), t("gc.chat.row.delete"), async () => {
          try {
            const result = await api(`/api/servers/${serverId}`, { method: "DELETE" });
            await refreshServers();
            router.navigate("/");
            // The echoed deletion counts render once as the consequence (G-6).
            const counts = result?.deleted || {};
            openDialog(document, {
              heading: t("gc.settings.danger.done"),
              body: h("p", { class: "gate-copy",
                text: t("gc.settings.danger.removed") + Object.entries(counts)
                  .map(([key, count]) => `${key} ${count}`).join(", ") }),
              actions: [{ class: "button button-quiet", text: t("gc.controls.done") }],
            });
          } catch (error) {
            openDialog(document, {
              heading: t("gc.settings.danger.failed"),
              body: h("p", { class: "gate-copy", text: error.message }),
              actions: [{ class: "button button-quiet", text: t("gc.controls.done") }],
            });
          }
        }),
    }));
}

// --- E2: channels + categories -------------------------------------------------

export function renderServerChannels(route, mount) {
  const serverId = Number(route.params.serverId);
  manageGate(mount, serverId, t("gc.shell.nav.channels"), (server) => {
    const counts = (server.channels || []).length + (server.categories || []).length;
    return [
      channelForm(serverId, counts),
      categoriesPanel(serverId, server),
      channelsList(serverId, server),
    ];
  });
}

function channelForm(serverId, counts) {
  const errorLine = inlineError();
  const atCap = counts >= UI_MAX_CHANNELS_PER_SERVER;
  const kind = createSelect(document, {
    id: "channel-kind", label: t("gc.settings.channels.kind"),
    options: [
      { value: "text", label: t("gc.settings.channels.kindText") },
      { value: "voice", label: t("gc.settings.channels.kindVoice") },
    ],
  });
  const name = createInput(document, {
    id: "channel-name", label: t("gc.settings.fields.name"), maxLength: 100, required: true,
  });
  const slowmode = createSelect(document, {
    id: "channel-slowmode", label: t("gc.settings.channels.slowmode"),
    options: UI_SLOWMODE_CHOICES.map((seconds) => ({
      value: String(seconds), label: seconds === 0
        ? t("gc.settings.channels.slowmodeOff") : `${seconds}s`,
    })),
  });
  const form = createForm(document, "channel-create", [kind, name, slowmode],
    t("gc.settings.channels.createHeading"));
  if (atCap) {
    for (const control of form.querySelectorAll("button[type=submit]")) control.disabled = true;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/servers/${serverId}/channels`, {
        method: "POST",
        body: {
          kind: form.querySelector("#channel-kind").value,
          name: form.querySelector("#channel-name").value.trim(),
          slowmode_seconds: Number(form.querySelector("#channel-slowmode").value),
        },
      });
      await refreshServers();
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message;
    }
  });
  return h("div", { class: "panel" },
    h("h3", { text: t("gc.settings.channels.createForm") }),
    atCap ? h("p", {
      class: "empty-state",
      text: t("gc.settings.channels.full", { count: counts, max: UI_MAX_CHANNELS_PER_SERVER }),
    }) : null,
    form, errorLine);
}

function categoriesPanel(serverId, server) {
  const panel = h("div", { class: "panel" },
    h("h3", { text: t("gc.settings.categories.heading") }),
    h("p", {
      class: "muted",
      text: t("gc.settings.categories.count",
        { count: (server.categories || []).length, max: UI_CATEGORIES_MAX_PER_SERVER }),
    }));
  const nameField = createInput(document,
    { id: "category-name", label: t("gc.settings.categories.new"), maxLength: 100 });
  const form = createForm(document, "category-create", [nameField], t("gc.settings.categories.create"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/servers/${serverId}/categories`, {
        method: "POST", body: { name: form.querySelector("#category-name").value.trim() },
      });
      await refreshServers();
      router.renderCurrent();
    } catch (error) {
      panel.append(h("p", { class: "form-error", text: error.message }));
    }
  });
  panel.append(form);
  // Category rows: rename offers itself; delete is the single confirmation.
  panel.append(h("div", { class: "manage-list" },
    ...(server.categories || []).map((category) => {
      return h("div", { class: "manage-row" },
        h("span", { class: "manage-name", text: category.name }),
        h("span", { class: "row-controls" },
          h("button", {
            class: "row-quiet-control", type: "button", text: t("gc.controls.rename"),
            onclick: () => {
              openDialog(document, {
                heading: t("gc.settings.categories.rename"),
                body: createInput(document, {
                  id: "category-rename", label: t("gc.settings.fields.name"), value: category.name, maxLength: 100,
                }),
                actions: [{
                  class: "button button-primary", text: t("gc.controls.save"),
                  onPress: async () => {
                    try {
                      await api(`/api/servers/${serverId}/categories/${category.id}`, {
                        method: "PATCH",
                        body: { name: document.getElementById("category-rename").value.trim() },
                      });
                      await refreshServers();
                    } catch { /* the fresh list shows the failure's absence */ }
                  },
                }, { class: "button button-quiet", text: t("gc.controls.keep") }],
              });
            },
          }),
          h("button", {
            class: "row-quiet-control row-quiet-danger", type: "button", text: t("gc.chat.row.delete"),
            onclick: () => confirmDialog(t("gc.settings.categories.deleteConfirm"),
              t("gc.settings.categories.deleteNote"), t("gc.chat.row.delete"), async () => {
                try {
                  await api(`/api/servers/${serverId}/categories/${category.id}`, { method: "DELETE" });
                  await refreshServers();
                  router.renderCurrent();
                } catch (error) {
                  openDialog(document, {
                    heading: t("gc.settings.danger.failed"),
                    body: h("p", { class: "gate-copy", text: error.message }),
                    actions: [{ class: "button button-quiet", text: t("gc.controls.done") }],
                  });
                }
              }),
          })));
    })));
  return panel;
}

function channelsList(serverId, server) {
  const categories = server.categories || [];
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.settings.channels.rowsHeading") }));
  const rows = (channel) => h("div", { class: "manage-row" },
    h("span", { class: "manage-name", text: channel.name },
      h("span", { class: "mark-muted", text: ` · ${channel.kind}` +
        (channel.categoryId ? ` · ${categoryNames.get(channel.categoryId) || ""}` : "") +
        (channel.slowmodeSeconds ? ` · ${channel.slowmodeSeconds}s` : "") +
        (channel.isSpoiler ? " · " + t("gc.settings.channels.spoiler") : "") })),
    h("span", { class: "row-controls" },
      h("a", {
        class: "row-quiet-control", text: t("gc.chat.row.edit"),
        href: `/s/${serverId}/channels/${channel.id}/overwrites`,
      }),
      h("button", {
        class: "row-quiet-control row-quiet-danger", type: "button", text: t("gc.chat.row.delete"),
        onclick: () => confirmDialog(t("gc.settings.channels.deleteConfirm", { name: channel.name }),
          t("gc.settings.channels.deleteNote"), t("gc.chat.row.delete"),
          async () => {
            try {
              await api(`/api/servers/${serverId}/channels/${channel.id}`, { method: "DELETE" });
              await refreshServers();
              router.renderCurrent();
            } catch { /* the fresh list tells the rest */ }
          }),
      })));

  panel.append(h("div", { class: "manage-list" },
    ...(server.channels || []).map((channel) => rows(channel))));
  return panel;
}

// Overwrites editor (E4) — the resolution order is copy, not machinery.
export function renderOverwrites(route, mount) {
  const serverId = Number(route.params.serverId);
  const channelId = Number(route.params.channelId);
  const server = serverOf(serverId);
  if (!server || !serverAdminRights(server)) {
    mount.append(shellWrap(taskPane(serverId, t("gc.settings.overwrites.heading"),
      h("p", { class: "empty-state", text: t("gc.settings.errors.permission") }))));
    return;
  }
  api(`/api/servers/${serverId}/channels/${channelId}/overwrites`).then((payload) => {
    const pane = taskPane(serverId, t("gc.settings.overwrites.heading"),
      h("p", {
        class: "muted",
        text: t("gc.settings.overwrites.order"),
      }),
      overwritesEditor(serverId, channelId, payload));
    mount.replaceChildren(shellWrap(pane));
  }).catch((error) => {
    mount.append(shellWrap(taskPane(serverId, t("gc.settings.overwrites.heading"),
      h("p", { class: "empty-state", text: error.message }))));
  });
}

function bitGrid(row, readOnly) {
  const existing = row ? { allow: new Set(row.allow || []), deny: new Set(row.deny || []) } : null;
  return h("div", { class: "bit-grid" },
    ...UI_OVERWRITE_BITS.flatMap((bit) => [
      h("label", { class: "check-inline" },
        h("input", {
          type: "checkbox", "data-bit": bit, "data-kind": "allow",
          checked: existing?.allow.has(bit) ? true : undefined,
          disabled: readOnly ? true : undefined,
        }), t("gc.settings.overwrites.allow", { bit })),
      h("label", { class: "check-inline" },
        h("input", {
          type: "checkbox", "data-bit": bit, "data-kind": "deny",
          checked: existing?.deny.has(bit) ? true : undefined,
          disabled: readOnly ? true : undefined,
        }), t("gc.settings.overwrites.deny", { bit })),
    ]));
}

// Role-targeted rows the viewer cannot write render READ-ONLY — a disabled
// control is a lie about affordance, but hiding them hides the truth (G-7).
function overwritesEditor(serverId, channelId, payload) {
  const viewerTop = payload.viewer?.topPosition ?? 0;
  const roles = new Map(payload.roles.map((role) => [role.id, role]));
  const existing = new Map(payload.overwrites.map((row) => [row.roleId ?? "everyone", row]));
  const rows = [{ id: "everyone", name: "@everyone", position: Infinity }, ...payload.roles];
  const canWriteRoles = (payload.viewer?.permissions || []).includes("MANAGE_ROLES")
    || payload.viewer?.owner === true;
  const panels = [];
  for (const role of rows) {
    const row = existing.get(role.id);
    const readOnly = role.id !== "everyone" && !canWriteRoles && role.position > viewerTop;
    const panel = h("div", { class: "panel overwrite-panel" },
      h("h3", { text: role.name + (readOnly ? " " + t("gc.settings.overwrites.readOnly") : "") }),
      bitGrid(row, readOnly));
    if (row && !readOnly) {
      panel.append(h("button", {
        class: "row-quiet-control row-quiet-danger", type: "button", text: t("gc.settings.overwrites.clear"),
        onclick: () => confirmDialog(t("gc.settings.overwrites.clearConfirm"),
          t("gc.settings.overwrites.clearNote"), t("gc.settings.overwrites.clearAction"), async () => {
            try {
              await api(`/api/servers/${serverId}/channels/${channelId}/overwrites/${role.id}`,
                { method: "DELETE" });
              router.renderCurrent();
            } catch { /* the fresh pull tells the rest */ }
          }),
      }));
    }
    if (!readOnly) {
      panel.append(h("button", {
        class: "button button-primary", type: "button", text: t("gc.settings.overwrites.save"),
        onclick: async () => {
          const allow = [...panel.querySelectorAll('input[data-kind="allow"][data-bit]:checked')]
            .map((box) => box.dataset.bit);
          const deny = [...panel.querySelectorAll('input[data-kind="deny"][data-bit]:checked')]
            .map((box) => box.dataset.bit);
          try {
            await api(`/api/servers/${serverId}/channels/${channelId}/overwrites/${role.id}`, {
              method: "PUT", body: { allow_mask: allow, deny_mask: deny },
            });
            router.renderCurrent();
          } catch (error) {
            panel.append(h("p", { class: "form-error", text: error.message }));
          }
        },
      }));
    }
    panels.push(panel);
  }
  return h("div", {}, ...panels);
}

// --- E3: roles -----------------------------------------------------------------

export function renderServerRoles(route, mount) {
  const serverId = Number(route.params.serverId);
  manageGate(mount, serverId, t("gc.settings.roles.heading"), (server) => [rolesPanel(serverId)]);
}

function rolesPanel(serverId) {
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.settings.roles.heading") }), inlineError());
  const errorLine = panel.querySelector(".form-error");
  const form = createForm(document, "role-create", [
    createInput(document, { id: "role-name", label: t("gc.settings.fields.name"), maxLength: 100 }),
  ], t("gc.settings.roles.createHeading"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/servers/${serverId}/roles`, {
        method: "POST",
        body: { name: form.querySelector("#role-name").value.trim() },
      });
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message;
    }
  });
  // Roles ride a separate read (§3 Roles) with its authoritative list.
  api(`/api/servers/${serverId}/roles`).then((payload) => {
    const list = payload?.roles || [];
    panel.append(h("p", {
      class: "muted",
      text: t("gc.settings.roles.count", { count: list.length, max: UI_ROLES_MAX }),
    }));
    for (const role of list) {
      panel.append(h("a", {
        class: "manage-row", href: `/s/${serverId}/roles/${role.id}`,
        style: role.color ? `--member-color:${role.color}` : undefined,
      },
      h("span", { class: "manage-name", text: role.name }),
      h("span", { class: "mark-muted", text: t("gc.settings.roles.position", { position: role.position }) })));
    }
  }).catch((error) => {
    errorLine.textContent = error.message;
  });
  panel.append(h("div", { class: "panel" }, h("h3", { text: t("gc.settings.roles.new") }), form));
  return panel;
}

export function renderServerRole(route, mount) {
  const serverId = Number(route.params.serverId);
  const roleId = Number(route.params.roleId);
  manageGate(mount, serverId, t("gc.settings.roles.editor"), () => [roleEditor(serverId, roleId)]);
}

function roleEditor(serverId, roleId) {
  const wrap = h("div", {}, h("p", {
    class: "empty-state", text: t("gc.settings.roles.fetchingRoster"),
  }));
  Promise.all([
    api(`/api/servers/${serverId}/roles`),
    rosterOf(serverId) ? Promise.resolve(rosterOf(serverId)) : loadRoster(serverId),
  ]).then(([rolesPayload, rosterPayload]) => {
    const role = (rolesPayload?.roles || []).find((entry) => entry.id === roleId);
    if (!role) {
      wrap.replaceChildren(h("p", {
        class: "empty-state", text: t("gc.settings.roles.notFound"),
      }));
      return;
    }
    wrap.replaceChildren(roleEditPanels(serverId, role, rosterPayload));
  }).catch((error) => {
    wrap.replaceChildren(h("p", { class: "empty-state", text: error.message }));
  });
  return wrap;
}

function roleEditPanels(serverId, role, rosterPayload) {
  const errorLine = inlineError();
  const nameField = createInput(document, {
    id: "role-edit-name", label: t("gc.settings.fields.name"), maxLength: 100, value: role.name,
  });
  const colorField = createInput(document, {
    id: "role-edit-color", label: t("gc.settings.roles.colorLabel"),
    value: role.color || "", description: t("gc.settings.roles.colorHelp"),
  });
  const positionField = createInput(document, {
    id: "role-edit-position", label: t("gc.settings.fields.position"), type: "number",
    value: String(role.position), description: t("gc.settings.roles.swapNote"),
  });
  const bits = h("div", { class: "bit-grid" },
    ...UI_SERVER_PERMISSIONS.map((bit) => h("label", { class: "check-inline" },
      h("input", {
        type: "checkbox", "data-bit": bit,
        checked: (role.permissions || []).includes(bit) ? true : undefined,
      }), bit)));
  const form = createForm(document, "role-edit", [nameField, colorField, positionField, bits],
    t("gc.settings.roles.save"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = form.querySelector("#role-edit-name").value.trim();
    const colorRaw = form.querySelector("#role-edit-color").value.trim();
    const position = Number(form.querySelector("#role-edit-position").value);
    const body = { name, color: colorRaw === "" ? null : colorRaw.toLowerCase(), position };
    body.permissions = [...form.querySelectorAll("input[data-bit]:checked")].map((box) => box.dataset.bit);
    try {
      await api(`/api/servers/${serverId}/roles/${role.id}`, { method: "PATCH", body });
      errorLine.textContent = "";
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message;
    }
  });
  const panels = [h("div", { class: "panel" }, h("h3", { text: role.name }), form, errorLine),
    deleteRolePanel(serverId, role)];
  if (rosterPayload) {
    panels.push(roleAssignPanel(serverId, role, rosterPayload));
  }
  return panels;
}

function deleteRolePanel(serverId, role) {
  return h("div", { class: "panel panel-danger" },
    h("button", {
      class: "row-quiet-control row-quiet-danger", type: "button", text: t("gc.settings.roles.delete"),
      onclick: () => confirmDialog(t("gc.settings.roles.deleteConfirm", { name: role.name }),
        t("gc.settings.roles.deleteNote"), t("gc.chat.row.delete"), async () => {
          try {
            await api(`/api/servers/${serverId}/roles/${role.id}`, { method: "DELETE" });
            router.navigate(`/s/${serverId}/roles`);
          } catch { /* the fresh list tells the rest */ }
        }),
    }));
}

function roleAssignPanel(serverId, role, rosterPayload) {
  const me = store.get("user");
  const panel = h("div", { class: "panel" },
    h("h3", { text: t("gc.settings.roles.holdersHeading") }));
  const held = new Set(rosterPayload.members
    .filter((member) => member.roleIds.includes(role.id)).map((member) => member.id));
  // Owner rows are immune; the viewer's own row too (never a self-target).
  for (const member of rosterPayload.members) {
    const ownerRow = member.membershipRole === "owner";
    const isSelf = me?.id === member.id;
    if (ownerRow || isSelf) {
      // Owner rows immune; the viewer's own row too (never a self-target).
      panel.append(h("a", { class: "manage-row", href: `/s/${serverId}/member/${member.id}` },
        h("span", { class: "manage-name", text: member.nickname || member.username }),
        h("span", { class: "mark-muted", text: ownedLabel(isSelf, ownerRow) })));
      continue;
    }
    panel.append(h("div", { class: "manage-row" },
      h("a", { class: "manage-name", href: `/s/${serverId}/member/${member.id}`, text: member.nickname || member.username }),
      h("span", { class: "row-controls" },
        held.has(member.id)
          ? h("button", {
            class: "row-quiet-control row-quiet-danger", type: "button", text: t("gc.controls.remove"),
            onclick: async (event) => {
              event.target.disabled = true;
              try {
                await api(`/api/servers/${serverId}/roles/${role.id}/members/${member.id}`,
                  { method: "DELETE" });
                await loadRoster(serverId);
                router.renderCurrent();
              } catch (error) {
                event.target.textContent = error.message;
              }
            },
          })
          : h("button", {
            class: "row-quiet-control", type: "button", text: t("gc.settings.roles.assign"),
            onclick: async (event) => {
              event.target.disabled = true;
              try {
                await api(`/api/servers/${serverId}/roles/${role.id}/members/${member.id}`,
                  { method: "PUT" });
                await loadRoster(serverId);
                router.renderCurrent();
              } catch (error) {
                event.target.textContent = error.message; // verbatim
              }
            },
          }))));
  }
  return panel;
}

function ownedLabel(isSelf, ownerRow) {
  if (isSelf && ownerRow) return t("gc.settings.roles.ownerImmune");
  if (isSelf) return t("gc.settings.roles.you");
  if (ownerRow) return t("gc.settings.roles.owner");
  return t("gc.settings.roles.held");
}

// --- E5: invites ------------------------------------------------------------------

// The choice values are data; the labels resolve at render time (t() at module
// load would freeze the boot locale onto every later pane). Every key stays
// static — the catalog and the pins read the source's keys.
const inviteExpiryChoices = () => [
  { value: "", label: t("gc.settings.invites.expiryNever") },
  { value: "3600", label: t("gc.settings.invites.expiry3600") },
  { value: "86400", label: t("gc.settings.invites.expiry86400") },
  { value: "604800", label: t("gc.settings.invites.expiry604800") },
  { value: "2592000", label: t("gc.settings.invites.expiry2592000") },
];
const inviteUseChoices = () => [
  { value: "", label: t("gc.settings.invites.usesUnlimited") },
  { value: "1", label: t("gc.settings.invites.uses1") },
  { value: "5", label: t("gc.settings.invites.uses5") },
  { value: "25", label: t("gc.settings.invites.uses25") },
  { value: "100", label: t("gc.settings.invites.uses100") },
];

export function renderServerInvites(route, mount) {
  const serverId = Number(route.params.serverId);
  manageGate(mount, serverId, t("gc.settings.invites.heading"), () => [invitesPanel(serverId)]);
}

function invitesPanel(serverId) {
  const panel = h("div", { class: "panel" },
    h("h3", { text: t("gc.settings.invites.heading") }), inlineError());
  const errorLine = panel.querySelector(".form-error");
  const fresh = h("p", { class: "muted", "aria-live": "polite" });
  const expiry = createSelect(document, {
    id: "invite-expiry", label: t("gc.settings.invites.expiryLabel"),
    description: t("gc.settings.invites.neverNote"),
    options: inviteExpiryChoices(),
  });
  const uses = createSelect(document, {
    id: "invite-uses", label: t("gc.settings.invites.useCap"),
    description: t("gc.settings.invites.emptyNote"), options: inviteUseChoices(),
  });
  const form = createForm(document, "invite-create", [expiry, uses],
    t("gc.settings.invites.mint"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const maxAge = form.querySelector("#invite-expiry").value;
    const maxUses = form.querySelector("#invite-uses").value;
    const body = {};
    if (maxAge !== "") body.maxAgeSeconds = Number(maxAge);
    if (maxUses !== "") body.maxUses = Number(maxUses);
    try {
      const result = await api(`/api/servers/${serverId}/invites`, { method: "POST", body });
      fresh.textContent = t("gc.settings.invites.fresh", { code: result.code });
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message;
    }
  });
  panel.append(form, fresh);
  api(`/api/servers/${serverId}/invites`).then((payload) => {
    for (const invite of payload?.invites || []) {
      panel.append(h("div", { class: "manage-row" },
        h("span", { class: "manage-name manage-code", text: invite.code },
          h("span", { class: "mark-muted", text: inviteRowMeta(invite) })),
        invite.active || invite.revokedAt === null ? h("span", { class: "row-controls" },
          h("button", {
            class: "row-quiet-control row-quiet-danger", type: "button",
            text: t("gc.settings.invites.revoke"),
            onclick: () => confirmDialog(t("gc.settings.invites.revokeConfirm", { code: invite.code }),
              t("gc.settings.invites.revokeNote"), t("gc.settings.invites.revoke"), async () => {
                try {
                  await api(`/api/servers/${serverId}/invites/${invite.code}`, { method: "DELETE" });
                  router.renderCurrent();
                } catch (error) {
                  openDialog(document, {
                    heading: t("gc.settings.invites.revokeFailed"),
                    body: h("p", { class: "gate-copy", text: error.message }),
                    actions: [{ class: "button button-quiet", text: t("gc.controls.done") }],
                  });
                }
              }),
          })) : null));
    }
  }).catch((error) => {
    errorLine.textContent = error.message;
  });
  return panel;
}

function inviteRowMeta(invite) {
  const expiry = invite.expiresAt
    ? " " + t("gc.settings.invites.expires") + " " + new Date(invite.expiresAt * 1000).toLocaleString()
    : " " + t("gc.settings.invites.never");
  const uses = invite.maxUses
    ? " " + t("gc.settings.invites.usesOf", { count: invite.uses, max: invite.maxUses })
    : " " + t("gc.settings.invites.uses", { count: invite.uses });
  const by = invite.createdByName
    ? " " + t("gc.settings.invites.by", { name: invite.createdByName }) : "";
  const revoked = invite.revokedAt ? " " + t("gc.settings.invites.revoked") : "";
  return expiry + uses + by + revoked;
}

// --- the member-facing door: /join ---------------------------------------------------

export function renderJoin(route, mount) {
  const pane = h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" },
      h("section", { class: "task-page" },
        h("header", { class: "task-header" },
          h("a", { class: "back-link", href: "/", text: t("gc.controls.back") }),
          h("h2", { class: "page-heading", text: t("gc.settings.join.heading") })),
        joinByCode(), discoverPanel())));
  mount.append(renderShell(null, pane));
}

function joinByCode() {
  const errorLine = inlineError();
  const codeField = createInput(document, {
    id: "invite-code", label: t("gc.settings.join.codeLabel"),
    description: t("gc.settings.join.codeHelp"),
  });
  const form = createForm(document, "invite-join", [codeField], t("gc.voice.join"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = form.querySelector("#invite-code").value.trim();
    const match = /([A-Za-z0-9_-]{8})\s*$/.exec(raw);
    if (!match) {
      errorLine.textContent = t("gc.settings.join.invalid");
      return;
    }
    try {
      const result = await api(`/api/invites/${match[1]}/join`, { method: "POST" });
      await refreshServers();
      if (result?.joined === false) {
        errorLine.textContent = t("gc.settings.join.already");
        return;
      }
      navigateJoinedServer(result.serverId);
    } catch (error) {
      errorLine.textContent = error.message; // lapsed/maxed/revoked/banned, verbatim
    }
  });
  return h("div", { class: "panel" },
    h("h3", { text: t("gc.settings.join.withInvite") }), form, errorLine);
}

function navigateJoinedServer(serverId) {
  const server = (store.get("servers") || []).find((entry) => entry.id === serverId);
  const first = server?.channels?.[0];
  router.navigate(first ? `/s/${serverId}/${first.id}` : `/s/${serverId}`);
}

// Discover (GET /api/discover, public, own memberships excluded server-side):
// each row IS the commit (label carries it) — a button-per-row of pills would
// be icon-soup, a commit-shaped row is not.
function discoverPanel() {
  const panel = h("div", { class: "panel" },
    h("h3", { text: t("gc.settings.join.openForDiscovery") }),
    h("p", { class: "empty-state", text: t("gc.settings.join.fetchingDiscover") }));
  api("/api/discover").then((payload) => {
    const list = h("div", { class: "manage-list" });
    for (const server of payload?.servers || []) {
      list.append(h("button", {
        class: "discover-row", type: "button",
        text: t("gc.settings.join.serverRow", { name: server.name, count: server.memberCount }),
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const result = await api(`/api/discover/${server.id}/join`, { method: "POST" });
            await refreshServers();
            if (result?.joined === false) {
              router.navigate(`/s/${server.id}`);
              return;
            }
            navigateJoinedServer(server.id);
          } catch (error) {
            event.currentTarget.disabled = false;
            event.currentTarget.textContent = error.message; // verbatim, the row becomes the error line
          }
        },
      }));
    }
    panel.replaceChildren(h("h3", { text: t("gc.settings.join.openForDiscovery") }),
      list.children.length ? list
        : h("p", {
          class: "empty-state", text: t("gc.settings.join.discoverEmpty"),
        }));
  }).catch((error) => {
    panel.append(h("p", { class: "empty-state", text: error.message }));
  });
  return panel;
}
