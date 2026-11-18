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
// see <https://www.gnu.org/licenses/>.

// T79 RED lane (docs/drafts/t79-post-boost-spec.md): the two lead-named
// contract rows for the forum post boost's GC render half — the announcement
// channel id gate and the mirrored card's byte shape. These rows are RED by
// design at spec time: api/boost.mjs does not exist yet (the spec's §3
// records the import failure as the red state); the GREEN commit writes the
// module to the spec and flips the file, not these expectations.
import test from "node:test";
import assert from "node:assert/strict";

import { validateAnnouncementChannel, renderBoostCard } from "../api/boost.mjs";
import { HttpError } from "../api/core/http.mjs";

const FORUM_ORIGIN = "https://wempos-forum.itswempo.workers.dev";

const ANNOUNCEMENT_CHANNEL = {
  id: 12,
  server_id: 3,
  name: "announcement",
  kind: "announcement",
  position: 0,
};

const BOOST = {
  id: 1,
  forum_post_id: 4242,
  thread_title: "The wobbly button thread",
  thread_excerpt: "A member asked for the wobbly buttons and the owner shipped them.",
  author_id: 7,
  author_name: "wempos",
};

// --- the announcement channel id gate -------------------------------------------

test("an unknown channel id fails the announcement gate with 404", () => {
  assert.throws(
    () => validateAnnouncementChannel(null),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

test("a text channel fails the announcement gate with 409", () => {
  assert.throws(
    () => validateAnnouncementChannel({ ...ANNOUNCEMENT_CHANNEL, kind: "text" }),
    (error) => error instanceof HttpError && error.status === 409,
  );
});

test("a voice channel fails the announcement gate with 409", () => {
  assert.throws(
    () => validateAnnouncementChannel({ ...ANNOUNCEMENT_CHANNEL, kind: "voice" }),
    (error) => error instanceof HttpError && error.status === 409,
  );
});

test("an announcement channel passes the gate and rides it untouched", () => {
  assert.equal(validateAnnouncementChannel(ANNOUNCEMENT_CHANNEL), ANNOUNCEMENT_CHANNEL);
});

// --- the mirrored card shape ------------------------------------------------------

test("the mirrored card carries title, excerpt and provenance on its lines", () => {
  const card = renderBoostCard(BOOST, FORUM_ORIGIN);
  assert.equal(
    card.body,
    "[Forum boost] The wobbly button thread\n" +
      "\n" +
      "A member asked for the wobbly buttons and the owner shipped them.\n" +
      "\n" +
      `Posted in the forum by wempos — read it at ${FORUM_ORIGIN}/posts/4242`,
  );
});

test("a long thread excerpt ellipsizes at the card's 240-character cap", () => {
  const longExcerpt = "x".repeat(300);
  const card = renderBoostCard({ ...BOOST, thread_excerpt: longExcerpt }, FORUM_ORIGIN);
  assert.equal(card.body.split("\n")[2], "x".repeat(240) + "…");
});

test("the card's provenance rides the forum's canonical /posts/ addressable URL", () => {
  const card = renderBoostCard(BOOST, FORUM_ORIGIN);
  assert.ok(card.body.endsWith(`${FORUM_ORIGIN}/posts/${BOOST.forum_post_id}`));
});
