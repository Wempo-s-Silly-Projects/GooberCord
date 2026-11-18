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

// Soundboard Studio (T85): the server's sound packs — the groupings layer
// over approved clips. The board's own sounds ride api/soundboard.mjs and
// keep their Discord-real 512KB intake (docs/parity-limits.md, verified
// 2026-11-17); packs are the GC-beyond-parity surface whose clip intake
// rides the 5MB tier-caps floor (GC_SOUND_PACK_CLIP_MAX_BYTES via this
// module's ONE equality-pinned G-4 mirror — no second declaration exists).
// Every failure renders the payload's error string VERBATIM inline (G-2);
// arms are explicit mod presses (no bulk, no auto); and the rider's law is
// quoted and kept: pack surfaces browse + a LOCAL preview only — playing
// into chat or voice is a later parity lane, never this rider, and nothing
// auto-plays anywhere.

import { h } from "../core/dom.js";
import { t } from "../i18n.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { openDialog } from "../vendor/frontload/dom.mjs";
import { canManageExpressions } from "./expressions.js";

export const UI_SOUND_PACK_CLIP_MAX_BYTES = 5242880; // GC_SOUND_PACK_CLIP_MAX_BYTES (G-4)

const packsPath = (serverId) => `/api/servers/${serverId}/sound-packs`;

// --- the CRUD consults (the routes the backend lane lands) -------------------

export function listPacks(serverId) {
  return api(packsPath(serverId));
}

export function createPack(serverId, name) {
  return api(packsPath(serverId), { method: "POST", body: { name } });
}

export function deletePack(serverId, packId) {
  return api(`/api/servers/${serverId}/sound-packs/${packId}`, { method: "DELETE" });
}

// The candidate arms: approve commits the staging reference into the pack
// (staged bytes ride the 0025 gc_upload_parts lane); drop rides the staging
// abandon route — refusal is deletion of the staging rows, nothing invented.
export function approveClip(serverId, packId, clipId) {
  return api(`/api/servers/${serverId}/sound-packs/${packId}/clips`, {
    method: "POST", body: { clipId },
  });
}

export function dropClip(serverId, packId, clipId) {
  return api(`/api/servers/${serverId}/sound-packs/${packId}/clips/${clipId}`, {
    method: "DELETE",
  });
}

// clipIntake(file) — the client mirror's fail-fast: an over-cap file
// refuses BEFORE any staging POST (the server re-checks and stays the
// authority). The cap note names the formats the board already admits.
export function clipIntake(file) {
  if (!file) return { ok: false, error: t("gc.studio.capNote") };
  if (file.size > UI_SOUND_PACK_CLIP_MAX_BYTES) {
    return { ok: false, error: t("gc.studio.overCap") };
  }
  return { ok: true };
}

// --- the seat (the expressions manage surface's third kind) ------------------

// packManagerArm(serverId, payload) — mod-gated the way the roster gates its
// manage seats: a refused viewer gets the shared 403 string verbatim, never
// a fabricated form. The panel carries the pack list, the named create
// field, and the candidates list; every write is an explicit press.
export function packManagerArm(serverId, payload) {
  if (!canManageExpressions(payload)) {
    return h("div", { class: "panel soundboard-studio" },
      h("h3", { text: t("gc.studio.packHeading") }),
      h("p", { class: "empty-state", text: t("gc.settings.errors.permission") }));
  }
  const errorLine = h("p", { class: "form-error", role: "alert" });
  const nameWell = h("input", {
    class: "field input", type: "text", maxlength: "32",
    "aria-label": t("gc.studio.packCreate"),
  });
  const createButton = h("button", {
    class: "button button-primary", type: "button", text: t("gc.controls.save"),
    onclick: async () => {
      errorLine.textContent = "";
      try {
        await createPack(serverId, String(nameWell.value || "").trim());
        nameWell.value = "";
        body.replaceChildren();
        paintPacks(errorLine, body);
      } catch (error) {
        errorLine.textContent = error.message; // verbatim
      }
    },
  });
  const body = h("div", { class: "pack-list" });
  const seat = h("div", { class: "panel soundboard-studio" },
    h("h3", { text: t("gc.studio.heading") }),
    h("h4", { text: t("gc.studio.packHeading") }),
    h("p", { class: "muted", text: t("gc.studio.capNote") }),
    h("div", { class: "affordance-row" }, nameWell, createButton),
    errorLine, body);
  paintPacks(errorLine, body);
  return seat;
}

async function paintPacks(errorLine, body) {
  const serverId = store.get("activeServerId");
  try {
    const payload = await listPacks(serverId);
    const packs = payload.packs || [];
    const candidates = payload.candidates || [];
    if (packs.length === 0) {
      body.append(h("p", { class: "empty-state", text: t("gc.studio.empty") }));
    }
    for (const pack of packs) {
      body.append(h("div", { class: "manage-row" },
        h("span", { class: "expr-name", text: pack.name }),
        h("span", { class: "muted", text: String(pack.sounds ?? 0) }),
        h("span", { class: "row-controls" }, deleteArm(serverId, pack))));
    }
    const waiting = h("div", {
      class: "pack-candidates",
      "aria-label": t("gc.studio.candidates"),
    });
    if (candidates.length === 0) {
      waiting.append(h("p", { class: "muted", text: t("gc.studio.candidatesEmpty") }));
    }
    for (const candidate of candidates) {
      waiting.append(h("div", { class: "manage-row" },
        h("span", { class: "expr-name", text: candidate.name }),
        candidateArm(serverId, candidate)));
    }
    body.append(waiting);
  } catch (error) {
    if (errorLine) errorLine.textContent = error.message; // verbatim
  }
}

function deleteArm(serverId, pack) {
  return h("button", {
    class: "row-quiet-control", type: "button", text: t("gc.studio.packDelete"),
    onclick: () => {
      openDialog(document, {
        heading: t("gc.studio.packDeleteConfirm"),
        body: h("p", { class: "gate-copy", text: pack.name }),
        actions: [
          { class: "button button-danger", text: t("gc.studio.packDelete"), onPress: () => deletePack(serverId, pack.id) },
          { class: "button button-quiet", text: t("gc.controls.keep") },
        ],
      });
    },
  });
}

function candidateArm(serverId, candidate) {
  const errorLine = h("span", { class: "form-error", role: "alert" });
  const seat = h("span", { class: "row-controls" }, errorLine,
    h("button", {
      class: "row-quiet-control", type: "button", text: t("gc.studio.approve"),
      onClick: async () => {
        errorLine.textContent = "";
        try { await approveClip(serverId, candidate.packId, candidate.id); }
        catch (error) { errorLine.textContent = error.message; } // verbatim
      },
    }),
    h("button", {
      class: "row-quiet-control", type: "button", text: t("gc.studio.drop"),
      onClick: async () => {
        errorLine.textContent = "";
        try { await dropClip(serverId, candidate.packId, candidate.id); }
        catch (error) { errorLine.textContent = error.message; } // verbatim
      },
    }));
  return seat;
}

// The pack surface's audio seat — browse + LOCAL preview only, the rider's
// law verbatim; preload none, user-initiated controls, never autoplay.
export function packSoundPreview(url) {
  return h("audio", { controls: true, src: url, preload: "none" });
}
