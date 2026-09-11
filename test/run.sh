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
export CLAUDE_CONTEXT_WINDOW_TOKENS=50000
unset CLAUDE_PLUGIN_DATA || true
# Most cases assert against the no-autocompact wording, so point the config at
# that profile explicitly instead of letting detection pick.
printf '{"profile":"autocompact-off"}' > "$tmp/off.json"
export CLAUDE_CONTEXT_NOTIFY_CONFIG="$tmp/off.json"
# Detection must not see the developer's own environment.
export CLAUDE_CONFIG_DIR="$tmp/cfgdir"
mkdir -p "$CLAUDE_CONFIG_DIR"
unset CLAUDE_CODE_AUTO_COMPACT_WINDOW DISABLE_AUTO_COMPACT DISABLE_COMPACT || true

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

# --- autocompact detection ----------------------------------------------------
detect() { python3 -c "
import json, sys
sys.path.insert(0, '$root/bin')
sys.argv = ['x']
import importlib.util
spec = importlib.util.spec_from_file_location('ctx', '$root/bin/ctx-notify.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.detect_autocompact('${1:-}' or None)))
"; }

out="$(detect)"
check "検出: 何も無ければ閾値なし (reactive)" '"window": null' "$out"
check "検出: 既定では有効" '"enabled": true' "$out"

out="$(DISABLE_AUTO_COMPACT=1 detect)"
check "検出: DISABLE_AUTO_COMPACT で無効" '"enabled": false' "$out"
check "検出: 無効の理由を持つ" 'DISABLE_AUTO_COMPACT env' "$out"

printf '{"autoCompactEnabled": false}' > "$CLAUDE_CONFIG_DIR/.claude.json"
check "検出: .claude.json の autoCompactEnabled=false で無効" '"enabled": false' "$(detect)"
printf '{}' > "$CLAUDE_CONFIG_DIR/.claude.json"

out="$(CLAUDE_CODE_AUTO_COMPACT_WINDOW=120000 detect)"
check "検出: env の window を読む" '"window": 120000' "$out"
check "検出: 閾値は window - 33k" '"threshold": 87000' "$out"

printf '{"autoCompactWindow": 110000}' > "$CLAUDE_CONFIG_DIR/settings.json"
check "検出: user settings の autoCompactWindow を読む" '"window": 110000' "$(detect)"
printf '{"autoCompactWindow": 105000}' > "$CLAUDE_CONFIG_DIR/settings.local.json"
check "検出: user の settings.local.json が settings.json に勝つ" '"window": 105000' "$(detect)"
rm "$CLAUDE_CONFIG_DIR/settings.local.json"

# CLAUDE_CONFIG_DIR does not reach hooks unless the user exported it; the config
# dir has to come out of CLAUDE_ENV_FILE in that case.
mkdir -p "$tmp/viaenvfile"
printf '{"autoCompactWindow": 101000}' > "$tmp/viaenvfile/settings.json"
check "検出: CLAUDE_ENV_FILE から config dir を割り出す" '"window": 101000' \
  "$(unset CLAUDE_CONFIG_DIR
     CLAUDE_ENV_FILE="$tmp/viaenvfile/session-env/abc/sessionstart-hook-0.sh" detect)"
check "検出: CLAUDE_ENV_FILE が CLAUDE_CONFIG_DIR に優先する" '"window": 101000' \
  "$(CLAUDE_ENV_FILE="$tmp/viaenvfile/session-env/abc/sessionstart-hook-0.sh" detect)"
mkdir -p "$tmp/fakehome/.claude"
printf '{"autoCompactWindow": 102000}' > "$tmp/fakehome/.claude/settings.json"
check "検出: どちらも無ければ HOME/.claude を見る" '"window": 102000' \
  "$(unset CLAUDE_CONFIG_DIR CLAUDE_ENV_FILE; HOME="$tmp/fakehome" detect)"
check "検出: env が settings に勝つ" '"window": 120000' \
  "$(CLAUDE_CODE_AUTO_COMPACT_WINDOW=120000 detect)"

mkdir -p "$tmp/proj/.claude"
printf '{"autoCompactWindow": 90000}' > "$tmp/proj/.claude/settings.json"
check "検出: project settings が user settings に勝つ" '"window": 90000' "$(detect "$tmp/proj")"
printf '{"autoCompactWindow": 80000}' > "$tmp/proj/.claude/settings.local.json"
check "検出: local settings が project settings に勝つ" '"window": 80000' "$(detect "$tmp/proj")"
rm "$CLAUDE_CONFIG_DIR/settings.json"

# --- profile selection ---------------------------------------------------------
new_session
transcript_with 33000
printf '{"profile":"auto"}' > "$tmp/auto.json"
out="$(CLAUDE_CONTEXT_NOTIFY_CONFIG=$tmp/auto.json run deliver PostToolUse)"
check "profile auto: 閾値が無ければ通知はする" "66% (33,000 / 50,000 tokens)" "$out"
if [[ "$out" == *"auto compact"* ]]; then
  echo "NG: profile auto: 閾値が無ければ off 側 (auto compact に触れない) を選ぶ"
  fails=$((fails + 1))
else
  echo "ok: profile auto: 閾値が無ければ off 側 (auto compact に触れない) を選ぶ"
fi

new_session
printf '{"session_id":"s%s","hook_event_name":"SessionStart","model":"claude-x"}' "$sid" \
  | CLAUDE_CODE_AUTO_COMPACT_WINDOW=45000 python3 "$script" model
transcript_with 12000  # 24% of 50,000
check "profile auto: 閾値を検出したら on 側の文面" "auto compact" \
  "$(CLAUDE_CONTEXT_NOTIFY_CONFIG=$tmp/auto.json run deliver PostToolUse)"
check "state に検出結果が入る" '"threshold": 12000' "$(cat "$XDG_STATE_HOME/claude-context-notify/s$sid.json")"

# --- before_autocompact bands --------------------------------------------------
new_session
cat > "$tmp/rel.json" <<'JSON'
{"urgent_from": 99, "bands": [{"before_autocompact": 5, "message": "REL {pct}% ac={ac_pct}% tok={ac_tokens}"}]}
JSON
# window 50,000 with auto-compact at 40,000 tokens -> fires at 80%, band at 75%
printf '{"session_id":"s%s","hook_event_name":"SessionStart","model":"claude-x"}' "$sid" \
  | CLAUDE_CODE_AUTO_COMPACT_WINDOW=73000 python3 "$script" model
transcript_with 38000  # 76% of 50,000
check "before_autocompact: 発火の 5pt 手前で喋る" "REL 76% ac=80% tok=40,000" \
  "$(CLAUDE_CONTEXT_NOTIFY_CONFIG=$tmp/rel.json run deliver PostToolUse)"

new_session
transcript_with 38000
check "before_autocompact: 閾値不明なら帯ごと落とす" SILENT \
  "$(CLAUDE_CONTEXT_NOTIFY_CONFIG=$tmp/rel.json run deliver PostToolUse)"

# --- PreCompact ----------------------------------------------------------------
new_session
transcript_with 48600
check "setup: 97% まで上げる" "97%" "$(run deliver PostToolUse)"
run precompact PreCompact
check "precompact: latch を 0 に戻す" '"band": 0' "$(cat "$XDG_STATE_HOME/claude-context-notify/s$sid.json")"
# Japanese comes back \u-escaped in the JSON, so assert on the ASCII head.
check "precompact: 直後のターンで知らせる (測定に上書きされない)" \
  '"[context-notify] auto compact' "$(run deliver UserPromptSubmit)"
check "precompact: 一度配ったら消える" SILENT "$(run deliver UserPromptSubmit)"

# --- check role: new fields ----------------------------------------------------
printf '{"profile":"nope"}' > "$tmp/badprofile.json"
check "check: 未知の profile を指摘" "profile は auto" "$(check_role "$tmp/badprofile.json")"
printf '{"profile":"auto"}' > "$tmp/onlyprofile.json"
check "check: bands 無しの profile 指定は妥当" "設定は妥当です" "$(check_role "$tmp/onlyprofile.json")"
cat > "$tmp/badrel.json" <<'JSON'
{"bands": [{"at": 50, "before_autocompact": 5, "message": "x"}, {"before_autocompact": 90, "message": "y"}]}
JSON
out="$(check_role "$tmp/badrel.json")"
check "check: at と before_autocompact の併記を指摘" "同時に書けません" "$out"
check "check: before_autocompact の範囲外を指摘" "0〜50 の整数" "$out"

echo
if ((fails)); then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all cases passed"
