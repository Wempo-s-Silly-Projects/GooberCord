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

// The expressions manage lane — emoji, stickers, and soundboard CRUD for
// servers the viewer manages (§W-R3 A). ONE task page per kind of work (G-6):
//   /s/:id/expressions       the three inventories + counts against the caps
//   /s/:id/expressions/new   the upload form (a separate route, not a dialog)
// Caps live IN THE PAYLOAD (max(base, blessing) is the server's job — the UI
// never re-derives the ladder); name bounds are PER KIND (the sticker 30 is
// EXACT, not a 32 superset); over-cap rows from a lapsed level render ACTIVE
// (GC only blocks new creates — items disable, never delete). Uploads ride
// the multipart arm; the JSON attach-by-id arm has no picker because no
// route lists the caller's own standalone images (reported, not invented).
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createForm, createInput, createSelect } from "../vendor/designer/kit.mjs";
import { openDialog } from "../vendor/frontload/dom.mjs";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { rosterOf, loadRoster, staffViewing } from "./members.js";
import { t } from "../i18n.js";

// --- mirrored constants (G-4: equality pins against constants.mjs) ----------

export const UI_EMOJI_FILE_MAX = 262144;
export const UI_STICKER_FILE_MAX = 524288;
export const UI_SOUND_FILE_MAX = 524288;
export const UI_EMOJI_NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;
export const UI_STICKER_NAME_PATTERN = /^[A-Za-z0-9_]{2,30}$/;
export const UI_SOUND_NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;

// The one inventory read (three GETs ride one envelope in the store so the
// count lines cite one caps trio).
const expressionsKey = (serverId) => `expressions:${serverId}`;

export async function loadExpressions(serverId) {
  const [emojis, stickers, sounds] = await Promise.all([
    api(`/api/servers/${serverId}/emojis`),
    api(`/api/servers/${serverId}/stickers`),
    api(`/api/servers/${serverId}/sounds`),
  ]);
  const payload = {
    emojis: emojis.emojis || [],
    stickers: stickers.stickers || [],
    sounds: sounds.sounds || [],
    caps: emojis.caps || stickers.caps || sounds.caps || {},
  };
  store.set({ [expressionsKey(serverId)]: payload });
  return payload;
}

export function expressionsOf(serverId) {
  return store.get(expressionsKey(serverId)) || null;
}

function inlineError() {
  return h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
}

// The plural word each cap 400 uses ("This server already has <cap> <kind>.").
const KINDS = [
  { key: "emojis", singular: "emoji", labelKey: "gc.expressions.kinds.emojis",
    nameHintKey: "gc.expressions.name.help", fileField: "image",
    namePattern: UI_EMOJI_NAME_PATTERN, accept: "image/*", fileMax: UI_EMOJI_FILE_MAX },
  { key: "stickers", singular: "sticker", labelKey: "gc.expressions.kinds.stickers",
    nameHintKey: "gc.expressions.name.helpShort", fileField: "image",
    namePattern: UI_STICKER_NAME_PATTERN, accept: "image/*", fileMax: UI_STICKER_FILE_MAX },
  { key: "sounds", singular: "sound", labelKey: "gc.expressions.kinds.sounds",
    nameHintKey: "gc.expressions.name.help", fileField: "sound",
    namePattern: UI_SOUND_NAME_PATTERN, accept: "audio/mpeg,audio/ogg", fileMax: UI_SOUND_FILE_MAX },
];

// The manage test: the expression authority is one bit, three CRUD lanes.
export function canManageExpressions(payload) {
  const viewer = payload?.viewer;
  return !!(viewer && (viewer.owner || viewer.permissions?.includes("MANAGE_EMOJI")));
}

function shellWrap(pane) {
  return renderShell(null, pane);
}

// --- the inventories page ----------------------------------------------------

export function renderExpressions(route, mount) {
  const serverId = Number(route.params.serverId);
  const roster = rosterOf(serverId);
  const ensure = roster
    ? Promise.resolve(roster)
    : loadRoster(serverId).catch(() => null);
  ensure.then((payload) => {
    const body = h("section", { class: "task-page" },
      h("header", { class: "task-header" },
        h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
        h("h2", { class: "page-heading", text: t("gc.settings.nav.expressions") })),
      h("p", { class: "muted", text: t("gc.expressions.intro") }));

    if (!payload) {
      // Roster refused: the route page renders the shared 403 string inline.
      body.append(h("p", { class: "empty-state",
        text: t("gc.settings.errors.permission") }));
      mount.append(shellWrap(h("section", { class: "pane-main task-main" },
        h("div", { class: "pane-body" }, body))));
      return;
    }
    const manage = canManageExpressions(payload);
    if (!manage && !staffViewing(payload)) {
      body.append(h("p", { class: "empty-state",
        text: t("gc.settings.errors.permission") }));
      mount.append(shellWrap(h("section", { class: "pane-main task-main" },
        h("div", { class: "pane-body" }, body))));
      return;
    }

    const inventory = expressionsOf(serverId);
    if (!inventory) {
      body.append(h("p", { class: "empty-state", text: t("gc.expressions.inventory.fetching") }));
      mount.append(shellWrap(h("section", { class: "pane-main task-main" },
        h("div", { class: "pane-body" }, body))));
      loadExpressions(serverId).then(() => {
        if (expressionsOf(serverId)) router.renderCurrent();
      }).catch((error) => {
        mount.replaceChildren(h("section", { class: "pane-main task-main" },
          h("div", { class: "pane-body" }, body,
            h("p", { class: "form-error", text: error.message }))));
      });
      return;
    }

    for (const kind of KINDS) {
      body.append(kindPanel(serverId, kind, inventory, manage));
    }
    mount.append(shellWrap(h("section", { class: "pane-main task-main" },
      h("div", { class: "pane-body" }, body))));
  });
}

// The count line cites the payload's caps (G-4); the upload affordance
// disables at cap with the server's own 400 shape as the reason; DELETE keeps
// working (create-block only — over-cap rows stay ACTIVE).
function kindPanel(serverId, kind, inventory, manage) {
  const cap = inventory.caps[kind.key];
  const rows = inventory[kind.key] || [];
  const panel = h("div", { class: "panel" },
    h("h3", { text: t(kind.labelKey) }),
    h("p", { class: "count-line", text: t("gc.expressions.inventory.count", { count: rows.length, cap }) }),
    h("div", { class: "expr-grid", role: "list" },
      ...rows.map((row) => exprRow(serverId, row, kind, manage, panel))));
  if (manage) {
    if (cap !== undefined && rows.length >= cap) {
      panel.append(h("p", { class: "empty-state cap-line cap-line-off",
        text: t("gc.expressions.errors.full", { cap, kind: kind.singular }) }));
    } else if (rows.length === 0) {
      panel.append(h("a", { class: "control-quiet",
        href: `/s/${serverId}/expressions/new`, text: t("gc.expressions.inventory.first", { kind: kind.singular }) }));
    } else {
      panel.append(h("div", { class: "affordance-row" }, h("a", {
        class: "control-quiet", href: `/s/${serverId}/expressions/new`,
        text: t("gc.expressions.inventory.another", { kind: kind.singular }) })));
    }
  } else if (rows.length === 0) {
    panel.append(h("p", { class: "empty-state", text: t("gc.expressions.inventory.empty", { kind: kind.singular }) }));
  }
  return panel;
}

function exprRow(serverId, row, kind, manage, panel) {
  const node = h("div", { class: "expr-row", role: "listitem" },
    h("span", { class: "expr-swatch" }, row.url
      ? h("img", { class: "expr-thumb", src: row.url, alt: row.name, loading: "lazy" })
      : h("span", {
          class: `expr-sound${kind.key === "sounds" ? " expr-sound-active" : ""}`,
          "aria-hidden": "true", text: kind.fileField === "sound" ? "sound" : "?",
        })),
    h("span", { class: "expr-name", text: row.name }));
  if (manage) {
    const controls = h("span", { class: "row-controls" },
      h("button", {
        class: "row-quiet-control", type: "button", text: t("gc.controls.rename"),
        onClick: () => renameDialog(serverId, row, kind, panel),
      }),
      h("button", {
        class: "row-quiet-control", type: "button", text: t("gc.chat.row.delete"),
        onClick: () => deleteDialog(serverId, row, kind, panel),
      }));
    node.append(controls);
  }
  return node;
}

// Rename: the per-kind 409 keeps the input; the name input never clears.
function renameDialog(serverId, row, kind, panel) {
  const errorLine = inlineError();
  const field = createInput(document, {
    id: `rename-${kind.key}-${row.id}`, label: t("gc.settings.fields.name"),
    description: t(kind.nameHintKey), value: row.name,
  });
  const form = createForm(document, `rename-${row.id}`, [field], t("gc.expressions.name.save"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/servers/${serverId}/${kind.key}/${row.id}`, {
        method: "PATCH", body: { name: field.querySelector("input").value },
      });
      errorLine.textContent = "";
      await loadExpressions(serverId);
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message; // verbatim (G-2) — input intact
    }
  });
}

// Delete: ONE confirmation that states the asset's bytes go with the row
// when nothing else references them (G-6).
function deleteDialog(serverId, row, kind, panel) {
  openDialog(document, {
    heading: t("gc.expressions.confirm.delete", { name: row.name }),
    body: h("p", { class: "gate-copy", text: t("gc.expressions.confirm.deleteBytes") }),
    modalOnly: true,
    actions: [
      { class: "button button-danger", text: t("gc.chat.row.delete"), onPress: async () => {
        await api(`/api/servers/${serverId}/${kind.key}/${row.id}`, { method: "DELETE" });
        await loadExpressions(serverId);
        router.renderCurrent();
      } },
      { class: "button button-quiet", text: t("gc.controls.keep") },
    ],
  });
}

// --- the upload route ---------------------------------------------------------

export function renderExpressionCreate(route, mount) {
  const serverId = Number(route.params.serverId);
  const roster = rosterOf(serverId);
  const ensure = roster ? Promise.resolve(roster) : loadRoster(serverId);
  ensure.then((payload) => {
    const body = h("section", { class: "task-page" },
      h("header", { class: "task-header" },
        h("a", { class: "back-link", href: `/s/${serverId}/expressions`, text: t("gc.controls.back") }),
        h("h2", { class: "page-heading", text: t("gc.expressions.dialog.heading") })));
    if (!payload || !canManageExpressions(payload)) {
      body.append(h("p", { class: "empty-state",
        text: t("gc.settings.errors.permission") }));
      mount.append(shellWrap(h("section", { class: "pane-main task-main" },
        h("div", { class: "pane-body" }, body))));
      return;
    }
    const inventory = expressionsOf(serverId);
    body.append(uploadForm(serverId, inventory));
    mount.append(shellWrap(h("section", { class: "pane-main task-main" },
      h("div", { class: "pane-body" }, body))));
  }).catch((error) => {
    mount.append(shellWrap(h("section", { class: "pane-main task-main" },
      h("div", { class: "pane-body" }, h("section", { class: "task-page" },
        h("p", { class: "empty-state", text: error.message }))))));
  });
}

// The multipart arm: a name + exactly one file. The JSON attach-by-id arm is
// deliberately absent — no route lists the caller's own standalone images,
// and an invented picker id would only earn the server's two refusal texts.
function uploadForm(serverId, inventory) {
  const kind = createSelect(document, {
    id: "expr-kind", label: t("gc.expressions.dialog.question"),
    options: KINDS.map((entry) => ({ value: entry.key, label: entry.singular })),
  });
  const errorLine = inlineError();
  const nameBox = createInput(document, {
    id: "expr-name", label: t("gc.settings.fields.name"),
    description: t(KINDS[0].nameHintKey),
  });
  const capLine = h("p", { class: "muted count-line cap-line", text: "" });
  const fileBox = createInput(document, {
    id: "expr-file", label: t("gc.expressions.file.label"),
    type: "file", accept: KINDS[0].accept,
  });
  const form = createForm(document, "expression-new", [kind, nameBox, fileBox, capLine],
    t("gc.expressions.upload"));
  const sync = () => {
    const entry = kindChoice(kind);
    nameBox.setAttribute("title", t(entry.nameHintKey));
    fileBox.querySelector("input")?.setAttribute("accept", entry.accept);
    if (inventory) {
      const cap = inventory.caps[entry.key];
      const count = (inventory[entry.key] || []).length;
      capLine.textContent = count >= cap
        ? t("gc.expressions.errors.full", { cap, kind: entry.singular })
        : t("gc.expressions.inventory.used", { count, cap });
    }
  };
  kind.addEventListener("change", sync);
  sync();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const entry = kindChoice(kind);
    const files = fileBox.querySelector("input")?.files;
    const data = new FormData();
    data.append("name", nameBox.querySelector("input").value);
    data.append(entry.fileField, files[0]);
    try {
      await api(`/api/servers/${serverId}/${entry.key}`, { method: "POST", body: data });
      await loadExpressions(serverId);
      router.navigate(`/s/${serverId}/expressions`);
    } catch (error) {
      errorLine.textContent = error.message; // 409/413/400 verbatim; name intact
    }
  });
  return h("div", { class: "panel" }, form, errorLine);
}

function kindChoice(selectNode) {
  const value = selectNode.querySelector("select")?.value || selectNode.value;
  return KINDS.find((entry) => entry.key === value) || KINDS[0];
}
