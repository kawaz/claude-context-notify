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

# --- a typo in a placeholder must not break the session -----------------------
new_session
transcript_with 33000
cat > "$tmp/typo.json" <<'JSON'
{"urgent_from": 90, "bands": [{"at": 50, "message": "TYPO {pcnt}% {pct}%"}]}
JSON
check "未知のプレースホルダはそのまま残して喋る" "TYPO {pcnt}% 66%" \
  "$(CLAUDE_CONTEXT_NOTIFY_CONFIG=$tmp/typo.json run deliver PostToolUse)"

# --- check role: validation for /context-notify:setup --------------------------
check_role() { CLAUDE_CONTEXT_NOTIFY_CONFIG="$1" python3 "$script" check 2>&1 || true; }

check "check: 既定テンプレは妥当" "設定は妥当です" "$(check_role "$root/templates/config.json")"
check "check: 未知のプレースホルダを指摘" "未知のプレースホルダ {pcnt}" "$(check_role "$tmp/typo.json")"

cat > "$tmp/bad.json" <<'JSON'
{"urgent_from": 900, "bands": [{"at": 60, "message": "a"}, {"at": 20, "message": "b"}, {"at": 20, "message": ""}]}
JSON
bad_out="$(check_role "$tmp/bad.json")"
check "check: urgent_from の範囲外を指摘" "urgent_from は 1〜100" "$bad_out"
check "check: 昇順違反を指摘" "昇順になっていません" "$bad_out"
check "check: 重複を指摘" "重複しています" "$bad_out"
check "check: 空の文面を指摘" "空でない文字列" "$bad_out"

printf 'not json' > "$tmp/broken.json"
check "check: 壊れた JSON を指摘" "JSON として読めません" "$(check_role "$tmp/broken.json")"

if CLAUDE_CONTEXT_NOTIFY_CONFIG="$tmp/bad.json" python3 "$script" check >/dev/null 2>&1; then
  echo "NG: check は問題があれば非ゼロで終了すべき"
  fails=$((fails + 1))
else
  echo "ok: check: 問題があれば非ゼロで終了する"
fi

echo
if ((fails)); then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all cases passed"
