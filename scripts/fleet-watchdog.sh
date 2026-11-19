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

# Cost-activity canary (cost-monitor rider, 2026-11-19): token spend is NOT
# CLI-observable — the owner alone reads the true number against the $1000
# ceiling from claude.ai. This guard correlates observable fleet motion
# (.team/cost.log lines in the tick's machine-parsable shape, the FLEET TICK
# being the single writer) and flags a spike so the owner knows to go look;
# it never halts, never blocks, never writes cost.log. A spike fires when
# any of deploys/lanes/suites/seats exceeds max(prev 3) * 2 + 1 — the +1
# floor stops the idle->first-activity 0->1 crossing from crying wolf.
COST_LOG="$STATE_DIR/cost.log"
TODAY="$(date -u +%F)"
if [ -f "$COST_LOG" ]; then
  # Only conforming lines (day= + numeric metrics) count; prose lines are inert.
  LINES_TODAY="$(grep 'day=' "$COST_LOG" | grep "day=$TODAY" | wc -l | tr -d ' ')"
  if [ "$LINES_TODAY" -ge 4 ]; then
    spike_alert=""
    for METRIC in deploys lanes suites seats; do
      EXPR="s/^.*[[:space:]]${METRIC}=\([0-9]*\).*/\1/p"
      C="$(printf '%s\n' "$(grep 'day=' "$COST_LOG" | grep "day=$TODAY" | tail -1)" | sed -n "$EXPR")"
      [ -n "$C" ] || continue
      P_MAX=0
      for PREV_LINE in $(grep 'day=' "$COST_LOG" | grep "day=$TODAY" | tail -n 4 | head -n 3 | tr '\n' '|' | tr -d "'"); do
        P="$(printf '%s' "$PREV_LINE" | sed -n "$EXPR")"
        [ -n "$P" ] && [ "$P" -gt "$P_MAX" ] && P_MAX="$P"
      done
      THRESHOLD=$(( P_MAX * 2 + 1 ))
      if [ "$C" -ge "$THRESHOLD" ] && [ "$C" -gt 1 ]; then
        spike_alert="COST-ACTIVITY-SPIKE: $METRIC=$C vs last-3 max=$P_MAX"
        break
      fi
    done
    if [ -n "$spike_alert" ]; then
      SPIKE_ALERT_FILE="$STATE_DIR/ALERT-$(date -u +%Y%m%dT%H%M%SZ)-cost.md"
      printf '# Fleet watchdog cost-activity spike %s\n\n%s\n\n(a canary, not a dollar meter: token spend is not CLI-observable — the owner reads the true number on claude.ai against the $1000 ceiling)\n' "$NOW" "$spike_alert" > "$SPIKE_ALERT_FILE"
      osascript -e "display notification \"Fleet watchdog: $spike_alert\" with title \"GooberCord fleet\"" >/dev/null 2>&1 &
    fi
  fi
fi
exit 0
