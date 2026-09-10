#!/usr/bin/env bash
# Latch behaviour matrix for bin/ctx-notify.py.
#
# Each case feeds a hook JSON on stdin and asserts on stdout: either a spoken
# additionalContext (with the band we expect in it) or silence. State is a temp
# XDG_STATE_HOME, so cases compose within a scenario and reset between them.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/bin/ctx-notify.py"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export XDG_STATE_HOME="$tmp/state"
export CLAUDE_CONTEXT_NOTIFY_CONFIG="$root/templates/config.json"
export CLAUDE_CONTEXT_WINDOW_TOKENS=50000
unset CLAUDE_PLUGIN_DATA || true

transcript="$tmp/transcript.jsonl"
fails=0
sid=0

# transcript_with <used_tokens> [sidechain]
transcript_with() {
  local used="$1" side="${2:-false}"
  printf '%s\n' \
    '{"type":"user","message":{"role":"user"}}' \
    "{\"type\":\"assistant\",\"isSidechain\":$side,\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":$used,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}" \
    > "$transcript"
}

# run <role> <event> [extra json fields]
run() {
  local role="$1" event="$2" extra="${3:-}"
  local json="{\"session_id\":\"s$sid\",\"hook_event_name\":\"$event\",\"transcript_path\":\"$transcript\"$extra}"
  printf '%s' "$json" | python3 "$script" "$role"
}

new_session() { sid=$((sid + 1)); }

# check <label> <expected: SILENT|substring> <actual>
check() {
  local label="$1" expect="$2" actual="$3"
  if [[ "$expect" == SILENT ]]; then
    [[ -z "$actual" ]] && { echo "ok: $label"; return; }
  elif [[ "$actual" == *"$expect"* ]]; then
    echo "ok: $label"; return
  fi
  echo "NG: $label"
  echo "    expected: $expect"
  echo "    actual:   ${actual:-<silence>}"
  fails=$((fails + 1))
}

# --- deliver speaks on the way up, once ---------------------------------------
new_session
transcript_with 33000   # 66%
check "deliver: band 60 に到達したら喋る" '"additionalContext"' "$(run deliver PostToolUse)"
check "deliver: 同じ band では黙る" SILENT "$(run deliver PostToolUse)"

# --- Stop queues a mild band, the next deliver hands it over -------------------
new_session
transcript_with 33000
check "measure: 90% 未満は Stop で黙る" SILENT "$(run measure Stop)"
check "deliver: Stop が積んだ文面を配る" "66% (33,000 / 50,000 tokens)" "$(run deliver UserPromptSubmit)"
check "deliver: 配ったら空になる" SILENT "$(run deliver UserPromptSubmit)"

# --- urgent band speaks from Stop itself --------------------------------------
new_session
transcript_with 48600   # 97%
check "measure: urgent 帯は Stop から即時に喋る" "97%" "$(run measure Stop)"
check "measure: 同じ band では黙る" SILENT "$(run measure Stop)"

# --- a continuation turn this hook caused must not loop -----------------------
new_session
transcript_with 48600
check "stop_hook_active: 継続ターンでは喋らない" SILENT \
  "$(run measure Stop ',"stop_hook_active":true')"

# --- falling usage rewinds the latch silently ---------------------------------
new_session
transcript_with 48600
check "setup: 97% で喋る" "97%" "$(run deliver PostToolUse)"
transcript_with 5000    # 10%
check "compact 相当: 下がったら黙る" SILENT "$(run deliver PostToolUse)"
transcript_with 33000   # 66% again
check "compact 後: 上がり直したら再び喋る" "66%" "$(run deliver PostToolUse)"

# --- subagent lines are not the main thread -----------------------------------
new_session
transcript_with 48600 true
check "sidechain 行しか無ければ測らない" SILENT "$(run deliver PostToolUse)"

# --- window comes from the model role -----------------------------------------
new_session
unset CLAUDE_CONTEXT_WINDOW_TOKENS
transcript_with 300000  # 30% of 1M, 150% of 200k
printf '%s' "{\"session_id\":\"s$sid\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-opus-5[1m]\"}" \
  | python3 "$script" model
check "model 役が [1m] を記録したら 1M で割る" "30% (300,000 / 1,000,000 tokens)" \
  "$(run deliver PostToolUse)"
export CLAUDE_CONTEXT_WINDOW_TOKENS=50000

# --- config is user-supplied ---------------------------------------------------
new_session
transcript_with 33000
cat > "$tmp/custom.json" <<'JSON'
{"urgent_from": 50, "bands": [{"at": 50, "message": "CUSTOM {pct}%"}]}
JSON
check "設定の閾値と文面が使われる" "CUSTOM 66%" \
  "$(CLAUDE_CONTEXT_NOTIFY_CONFIG=$tmp/custom.json run deliver PostToolUse)"

# --- /context-notify:config bootstraps the file --------------------------------
cfgdir="$tmp/plugindata"
out="$(CLAUDE_CONTEXT_NOTIFY_CONFIG= python3 "$script" config "$cfgdir")"
check "config: 初回はテンプレから作成する" "テンプレから作成" "$out"
check "config: 作成したファイルを読んで閾値を並べる" "97%" "$out"
[[ -f "$cfgdir/config.json" ]] || { echo "NG: config file not created"; fails=$((fails + 1)); }

echo
if ((fails)); then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all cases passed"
