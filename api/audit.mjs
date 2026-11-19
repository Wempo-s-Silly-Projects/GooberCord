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

// T-R26-AUDIT (wave 26, W26-1): the server audit log's ONE shared writer.
// Every moderation handler's commit point calls recordAudit with the
// action's law data (actor, server, action key, optional target member,
// optional string reference, the before→after deltas as one JSON string);
// the row lands in migration 0059's gc_server_audit. ONE implementation —
// the sibling modules import THIS (never a second INSERT literal); the
// caps keep their constants.mjs single home.

import { nowSeconds } from "./core/crypto.mjs";
import { errorName } from "./servers.mjs";

export const AUDIT_INSERT_SQL =
  "INSERT INTO gc_server_audit (" +
    "server_id, actor_id, action_key, target_user_id, target_ref, payload_json, created_at" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?)";

// recordAudit(env, actorId, serverId, actionKey, targetUserId, targetRef,
// payloadJson): one batched INSERT with positional binds (the guard-binds
// law), called AFTER the mutation's success verdict — the row records what
// already happened, so the call site never rides before it. Best-effort by
// law: an audit write's failure (a malformed payload over the CHECK's
// ceiling, a transient D1 error) never fails the moderation action that
// already committed — one console error line carries the context, and the
// next action's rows keep accruing.
export async function recordAudit(env, actorId, serverId, actionKey, targetUserId, targetRef, payloadJson) {
  try {
    await env.GOOBER_DB.batch([
      env.GOOBER_DB.prepare(AUDIT_INSERT_SQL).bind(
        Number(serverId),
        Number(actorId),
        actionKey,
        targetUserId === null || targetUserId === undefined ? null : Number(targetUserId),
        targetRef === undefined ? null : targetRef,
        payloadJson,
        nowSeconds(),
      ),
    ]);
  } catch (error) {
    console.error(
      "AUDIT_WRITE_FAILED " + errorName(error) + ": " + (error && error.message ? error.message : ""),
    );
  }
}
