#!/bin/bash
# Copyright 2026 ItsWempo
#
# This file is part of GooberCord.
#
# GooberCord is free software: you can redistribute it and/or modify it
# under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the
# GNU Affero General Public License along with this program.  If not,
# see <https://www.gnu.org/licenses/>
#
# Fleet watchdog — OS-level fleet tick that survives session close.
# Owner-approved 2026-11-19 ("set everything up" after lead offered the
# LaunchAgent). Read-only toward prod; appends .team/tick.log and writes
# .team/ALERT-<ts>.md + a macOS notification on failure. Never deploys,
# never writes D1, never pushes.
set -u
cd /Users/itswempo/GooberCord || exit 1
STATE_DIR=".team"
STATE_FILE="$STATE_DIR/watchdog-state.json"
LOG_FILE="$STATE_DIR/tick.log"
NOW="$(date -u +%FT%TZ)"

GC_VERSION="$(curl -s --max-time 20 https://goobercord.itswempo.workers.dev/api/version)"
GC_INDEX="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://goobercord.itswempo.workers.dev/)"
FORUM_VERSION="$(curl -s --max-time 20 https://wempos-forum.itswempo.workers.dev/api/version)"

GC_BUILD="$(printf '%s' "$GC_VERSION" | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')"
PREV_BUILD=""
if [ -f "$STATE_FILE" ]; then
  PREV_BUILD="$(printf '%s' "$(cat "$STATE_FILE")" | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')"
fi

alert=""
if [ -z "$GC_BUILD" ]; then
  alert="GC version probe failed or no build stamp (T25 churn signature): ${GC_VERSION:-<empty>}"
elif [ -n "$PREV_BUILD" ] && [ "$GC_BUILD" != "$PREV_BUILD" ]; then
  alert="GC build stamp changed outside deploy ritual: $PREV_BUILD -> $GC_BUILD"
elif [ "$GC_INDEX" != "200" ]; then
  alert="GC index probe HTTP $GC_INDEX (expected 200)"
fi
if ! printf '%s' "$FORUM_VERSION" | grep -q '"commit"'; then
  alert="${alert:+$alert; }Forum version probe failed: ${FORUM_VERSION:-<empty>}"
fi

printf '%s WATCHDOG gc=%s index=%s forum=%s' "$NOW" "$GC_BUILD" "$GC_INDEX" "$FORUM_VERSION" >> "$LOG_FILE"
if [ -n "$alert" ]; then
  printf ' ALERT=%s\n' "$alert" >> "$LOG_FILE"
  # Re-seed state so a one-off stamp change does not loop-alert forever.
  if [ -n "$GC_BUILD" ]; then
    printf '{"build":"%s","at":"%s"}\n' "$GC_BUILD" "$NOW" > "$STATE_FILE"
  fi
  ALERT_FILE="$STATE_DIR/ALERT-$(date -u +%Y%m%dT%H%M%SZ).md"
  printf '# Fleet watchdog alert %s\n\n%s\n\n- gc build: %s\n- index: %s\n- forum: %s\n' "$NOW" "$alert" "$GC_BUILD" "$GC_INDEX" "$FORUM_VERSION" > "$ALERT_FILE"
  osascript -e "display notification \"Fleet watchdog: $alert\" with title \"GooberCord fleet\"" >/dev/null 2>&1 &
else
  printf ' OK\n' >> "$LOG_FILE"
  if [ -n "$GC_BUILD" ]; then
    printf '{"build":"%s","at":"%s"}\n' "$GC_BUILD" "$NOW" > "$STATE_FILE"
  fi
fi
exit 0
