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

# The fleet tick — the monitoring loop only. It probes prod and escalates.
# It NEVER deploys, NEVER writes D1, and NEVER touches secrets. Stop it by
# creating the sentinel file /Users/itswempo/GooberCord/.team/loop-stop.

set -u

REPO="/Users/itswempo/GooberCord"
BOARD="$REPO/.team"
LOG="$BOARD/tick.log"
STOP="$BOARD/loop-stop"
LOCK="/tmp/gc-fleet-tick.lock"
URL="https://goobercord.itswempo.workers.dev"

mkdir -p "$BOARD"

# One tick at a time; a held lock from a live tick exits silently.
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Sentinel: any tick after the stop file exists is a no-op.
if [ -f "$STOP" ]; then
  exit 0
fi

stamp="$(curl -s -m 15 "$URL/api/version" 2>/dev/null || echo ERR)"
it_status="$(curl -s -m 15 -o /dev/null -w '%{http_code} %{content_type}' "$URL/locales/it.json" 2>/dev/null || echo ERR)"
en_status="$(curl -s -m 15 -o /dev/null -w '%{http_code} %{content_type}' "$URL/locales/en.json" 2>/dev/null || echo ERR)"
now="$(date -u '+%Y-%m-%dT%H:%MZ')"

echo "$now stamp=$stamp it=$it_status en=$en_status" >> "$LOG"

# Escalation only — a flipped stamp or a re-wedged funnel wakes one
# claude -p triage (bounded by --max-turns), never an action.
if echo "$stamp" | grep -q 'build":""' || echo "$it_status" | grep -q '^200'; then
  echo "$now ESCALATION: churn/funnel signature detected" >> "$LOG"
  cd "$REPO" || exit 0
  claude -p --max-turns 8 "GooberCord fleet tick ESCALATION at $now — prod shows $stamp / it.json $it_status / en.json $en_status. Diagnose read-only (no deploys, no D1 writes, never print secrets) and append a one-line finding to $REPO/.remember/now.md. Do not commit." \
    >> "$LOG" 2>&1
fi
