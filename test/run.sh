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
# Bands live in a fixture data dir rather than in the shipped templates: the
# wording of templates/*.json is the user's to change, and latch behaviour must
# not be asserted through it. Both lists carry the same wording here, so latch
# cases do not depend on which one is selected.
fixture_dir="$tmp/data"
mkdir -p "$fixture_dir"
entries_body='{"version": 1, "notifications": [
  {"used_percent": 20, "message": "PREFIXctx {used_percent}% ({used_tokens} / {window_tokens} tokens)"},
  {"used_percent": 40, "message": "PREFIXctx {used_percent}% ({used_tokens} / {window_tokens} tokens)"},
  {"used_percent": 60, "message": "PREFIXctx {used_percent}% ({used_tokens} / {window_tokens} tokens)"},
  {"used_percent": 80, "message": "PREFIXctx {used_percent}% ({used_tokens} / {window_tokens} tokens)"},
  {"used_percent": 90, "message": "PREFIXctx {used_percent}% ({used_tokens} / {window_tokens} tokens)"},
  {"used_percent": 95, "message": "PREFIXctx {used_percent}% ({used_tokens} / {window_tokens} tokens)"},
  {"used_percent": 97, "message": "PREFIXctx {used_percent}% ({used_tokens} / {window_tokens} tokens)"}
]}'
# write_list <path> <prefix>
write_list() { printf '%s' "${entries_body//PREFIX/$2}" > "$1"; }
write_list "$fixture_dir/autocompact-on.json" ""
write_list "$fixture_dir/autocompact-off.json" ""
export CLAUDE_CONTEXT_NOTIFY_DATA="$fixture_dir"
# Detection must not see the developer's own environment.
export CLAUDE_CONFIG_DIR="$tmp/cfgdir"
mkdir -p "$CLAUDE_CONFIG_DIR"
unset CLAUDE_CODE_AUTO_COMPACT_WINDOW DISABLE_AUTO_COMPACT DISABLE_COMPACT || true
# Window fallbacks the developer's own session may have set.
unset CLAUDE_CODE_MAX_CONTEXT_TOKENS CLAUDE_PID || true

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

# check_role <data dir>: the check role's report for that dir
check_role() { CLAUDE_CONTEXT_NOTIFY_DATA="$1" python3 "$script" check 2>&1 || true; }

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

# --- Stop speaks the band it just crossed, once -------------------------------
new_session
transcript_with 33000   # 66%
check "Stop: 跨いだ帯をその場で喋る" "ctx 66% (33,000 / 50,000 tokens)" "$(run measure Stop)"
check "Stop: 同じ band では黙る" SILENT "$(run measure Stop)"

# --- PostToolUse speaks too, on the same latch --------------------------------
new_session
transcript_with 33000
check "PostToolUse: 跨いだ帯をその場で喋る" "ctx 66% (33,000 / 50,000 tokens)" \
  "$(run measure PostToolUse)"
check "PostToolUse: 同じ band では黙る" SILENT "$(run measure PostToolUse)"
check "Stop: 別 event が進めた latch も引き継ぐ" SILENT "$(run measure Stop)"

# --- the high bands are not special -------------------------------------------
new_session
transcript_with 48600   # 97%
check "Stop: 高い帯も同じくその場で喋る" "ctx 97%" "$(run measure Stop)"

# --- a continuation turn this hook caused must not loop -----------------------
new_session
transcript_with 48600
check "stop_hook_active: 継続ターンでは喋らない" SILENT \
  "$(run measure Stop ',"stop_hook_active":true')"
check "stop_hook_active: 測ってはいるので次も黙る" SILENT "$(run measure Stop)"

# --- falling usage rewinds the latch silently ---------------------------------
new_session
transcript_with 48600
check "setup: 97% で喋る" "ctx 97%" "$(run measure PostToolUse)"
transcript_with 5000    # 10%
check "compact 相当: 下がったら黙る" SILENT "$(run measure PostToolUse)"
transcript_with 33000   # 66% again
check "compact 後: 上がり直したら再び喋る" "ctx 66%" "$(run measure PostToolUse)"

# --- subagent lines are not the main thread -----------------------------------
new_session
transcript_with 48600 true
check "sidechain 行しか無ければ測らない" SILENT "$(run measure PostToolUse)"

# --- window comes from the model role -----------------------------------------
new_session
unset CLAUDE_CONTEXT_WINDOW_TOKENS
transcript_with 300000  # 30% of 1M, 150% of 200k
printf '%s' "{\"session_id\":\"s$sid\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-opus-5[1m]\"}" \
  | python3 "$script" model
check "model 役が [1m] を記録したら 1M で割る" "ctx 30% (300,000 / 1,000,000 tokens)" \
  "$(run measure PostToolUse)"

# --- /clear: SessionStart without a model name ---------------------------------
# The claude process is the same across /clear, so the window it recorded for
# the previous session carries over. $$ is a live pid, so the stale-record
# sweep leaves it alone.
export CLAUDE_PID=$$
new_session
printf '%s' "{\"session_id\":\"s$sid\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-opus-5[1m]\"}" \
  | python3 "$script" model
new_session   # /clear hands out a new session_id inside the same process
printf '%s' "{\"session_id\":\"s$sid\",\"hook_event_name\":\"SessionStart\",\"source\":\"clear\"}" \
  | python3 "$script" model
transcript_with 300000
check "model 欄が無くても同じ claude プロセスの記録から 1M で割る" \
  "ctx 30% (300,000 / 1,000,000 tokens)" "$(run measure PostToolUse)"
unset CLAUDE_PID

new_session
printf '%s' "{\"session_id\":\"s$sid\",\"hook_event_name\":\"SessionStart\",\"source\":\"clear\"}" \
  | CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 python3 "$script" model
check "model 欄も記録も無ければ CLAUDE_CODE_MAX_CONTEXT_TOKENS で割る" \
  "ctx 30% (300,000 / 1,000,000 tokens)" \
  "$(CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 run measure PostToolUse)"

new_session
printf '%s' "{\"session_id\":\"s$sid\",\"hook_event_name\":\"SessionStart\",\"source\":\"clear\"}" \
  | python3 "$script" model
transcript_with 100000  # 50% of the 200k default
check "どの手掛かりも無ければ既定の 200k で割る" "ctx 50% (100,000 / 200,000 tokens)" \
  "$(run measure PostToolUse)"

export CLAUDE_CONTEXT_WINDOW_TOKENS=50000

# --- the lists are user-supplied ----------------------------------------------
# one_band <dir> <message>: a data dir whose two lists share a single entry
one_band() {
  mkdir -p "$1"
  printf '{"version": 1, "notifications": [{"used_percent": 50, "message": "%s"}]}' "$2" > "$1/autocompact-on.json"
  printf '{"version": 1, "notifications": [{"used_percent": 50, "message": "%s"}]}' "$2" > "$1/autocompact-off.json"
}

new_session
transcript_with 33000
one_band "$tmp/custom" "CUSTOM {used_percent}%"
check "設定の閾値と文面が使われる" "CUSTOM 66%" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$tmp/custom run measure PostToolUse)"

# --- the remaining-room placeholders complement the used ones ------------------
new_session
transcript_with 33000
one_band "$tmp/available" "LEFT {available_tokens} tokens / {available_percent}% of {window_tokens}"
check "available_tokens / available_percent が展開される" \
  "LEFT 17,000 tokens / 34% of 50,000" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$tmp/available run measure PostToolUse)"

# --- entries sharing an `at` join into one notice ------------------------------
new_session
transcript_with 33000
dupdir="$tmp/dup"
mkdir -p "$dupdir"
for f in autocompact-on autocompact-off; do
  printf '{"version": 1, "notifications": [{"used_percent": 50, "message": "FIRST {used_percent}%%"}, {"used_percent": 50, "message": "SECOND"}]}' \
    > "$dupdir/$f.json"
done
check "同じ used_percent の 2 エントリが改行で連結されて 1 回出る" 'FIRST 66%\nSECOND' \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$dupdir run measure PostToolUse)"
check "同じ used_percent を check は許容する" "設定は妥当です" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$dupdir python3 "$script" check 2>&1 || true)"

# --- a 0 entry fires once, on the session's first measurement ------------------
zerodir="$tmp/zero"
mkdir -p "$zerodir"
for f in autocompact-on autocompact-off; do
  printf '{"version": 1, "notifications": [{"used_percent": 0, "message": "ZERO {used_percent}%%"}, {"used_percent": 60, "message": "SIXTY"}]}' \
    > "$zerodir/$f.json"
done
zero_run() { CLAUDE_CONTEXT_NOTIFY_DATA="$zerodir" run measure PostToolUse; }

new_session
transcript_with 5000    # 10%
check "used_percent 0: 最初の測定で出る" "ZERO 10%" "$(zero_run)"
check "used_percent 0: 2 回目の測定では出ない" SILENT "$(zero_run)"
transcript_with 33000   # 66%
check "used_percent 0: 上の帯は普通に出る" "SIXTY" "$(zero_run)"
transcript_with 5000    # compact 相当で 10% へ
check "used_percent 0: 下がった時は黙る" SILENT "$(zero_run)"
transcript_with 6000    # 12%、0 帯のまま
check "used_percent 0: 戻っても 0 は再発火しない" SILENT "$(zero_run)"
check "check: 0 の閾値を許容する" "設定は妥当です" "$(check_role "$zerodir")"

# --- the schema version is announced, never migrated ---------------------------
verdir="$tmp/version"
mkdir -p "$verdir"
for f in autocompact-on autocompact-off; do
  printf '{"notifications": [{"used_percent": 50, "message": "NOVER {used_percent}%%"}]}' > "$verdir/$f.json"
done
check "check: version 欠落を指摘" "version が古い (ファイル: None / 現在: 1)" \
  "$(check_role "$verdir")"
printf '{"version": 0, "notifications": [{"used_percent": 50, "message": "OLDVER"}]}' > "$verdir/autocompact-on.json"
check "check: version 不一致を指摘" "version が古い (ファイル: 0 / 現在: 1)" \
  "$(check_role "$verdir")"
check "check: version 一致なら言及しない" SILENT \
  "$(check_role "$fixture_dir" | grep 'version が古い' || true)"
new_session
transcript_with 33000
check "version が古くても hook は notifications を使い続ける" "NOVER 66%" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$verdir run measure PostToolUse)"

# --- which list a session reads ------------------------------------------------
# Asserted through fixtures, not the shipped wording, which is the user's to edit.
seldir="$tmp/select"
mkdir -p "$seldir"
printf '{"version": 1, "notifications": [{"used_percent": 50, "message": "ON {used_percent}%%"}]}' > "$seldir/autocompact-on.json"
printf '{"version": 1, "notifications": [{"used_percent": 50, "message": "OFF {used_percent}%%"}]}' > "$seldir/autocompact-off.json"

new_session
transcript_with 33000
printf '{"session_id":"s%s","hook_event_name":"SessionStart","model":"claude-x"}' "$sid" \
  | python3 "$script" model
check "auto compact が有効なら on ファイルを読む" "ON 66%" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$seldir run measure PostToolUse)"

new_session
printf '{"session_id":"s%s","hook_event_name":"SessionStart","model":"claude-x"}' "$sid" \
  | DISABLE_AUTO_COMPACT=1 python3 "$script" model
check "state に検出結果が入る" '"enabled": false' \
  "$(cat "$XDG_STATE_HOME/claude-context-notify/s$sid.json")"
check "auto compact が無効なら off ファイルを読む" "OFF 66%" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$seldir run measure PostToolUse)"

# --- the data dir is bootstrapped from the bundled templates -------------------
bootdir="$tmp/plugindata"
out="$(CLAUDE_CONTEXT_NOTIFY_DATA= python3 "$script" config "$bootdir")"
check "config: 初回は 2 ファイルともテンプレから作成する" "テンプレから作成" "$out"
check "config: どちらを使うかを示す" "このセッションが使うのは: autocompact-" "$out"
check "config: 使えるプレースホルダを並べる" "{available_percent}" "$out"
for name in autocompact-on autocompact-off; do
  [[ -f "$bootdir/$name.json" ]] || { echo "NG: $name.json not created"; fails=$((fails + 1)); }
done

# 既存ファイルは決して上書きしない
printf '{"version": 1, "notifications": [{"used_percent": 50, "message": "MINE {used_percent}%%"}]}' > "$bootdir/autocompact-on.json"
CLAUDE_CONTEXT_NOTIFY_DATA= python3 "$script" config "$bootdir" >/dev/null
check "config: 既存ファイルは上書きしない" "MINE" "$(cat "$bootdir/autocompact-on.json")"

# data dir が書けなくても同梱テンプレで動き続ける
new_session
transcript_with 33000
check "data dir が作れなくても同梱テンプレで喋る" '"additionalContext"' \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=/dev/null/nope run measure PostToolUse)"

# --- a typo in a placeholder must not break the session -----------------------
new_session
transcript_with 33000
one_band "$tmp/typo" "TYPO {pcnt}% {used_percent}%"
check "未知のプレースホルダはそのまま残して喋る" "TYPO {pcnt}% 66%" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$tmp/typo run measure PostToolUse)"

# A list left on the previous placeholder names must degrade to literal text,
# never to an exception that breaks every turn of the session.
new_session
transcript_with 33000
one_band "$tmp/oldnames" "OLD {pct}% {used} {window}"
check "旧名の設定でも hook は落ちず文面がそのまま出る" "OLD {pct}% {used} {window}" \
  "$(CLAUDE_CONTEXT_NOTIFY_DATA=$tmp/oldnames run measure PostToolUse)"

# --- check role: validation for /context-notify:setup --------------------------

out="$(check_role "$fixture_dir")"
check "check: 妥当な 2 ファイルを通す" "設定は妥当です" "$out"
check "check: on 側も見る" "autocompact-on:" "$out"
check "check: off 側も見る" "autocompact-off:" "$out"
check "check: 片方だけの綴り間違いも拾う" "未知のプレースホルダ {pcnt}" "$(check_role "$tmp/typo")"

baddir="$tmp/baddata"
mkdir -p "$baddir"
printf '{"version": 1, "notifications": [{"used_percent": 60, "message": "a"}, {"used_percent": 20, "message": "b"}, {"used_percent": 20, "message": ""}]}' \
  > "$baddir/autocompact-on.json"
printf 'not json' > "$baddir/autocompact-off.json"
bad_out="$(check_role "$baddir")"
check "check: 昇順違反を指摘" "昇順になっていません" "$bad_out"
check "check: 空の文面を指摘" "空でない文字列" "$bad_out"
check "check: 壊れた JSON を指摘" "JSON として読めません" "$bad_out"

nobands="$tmp/nobands"
mkdir -p "$nobands"
printf '{"version": 1}' > "$nobands/autocompact-on.json"
printf '{"version": 1}' > "$nobands/autocompact-off.json"
check "check: notifications 欠落を指摘" "notifications は 1 件以上の配列" "$(check_role "$nobands")"

noat="$tmp/noat"
mkdir -p "$noat"
printf '{"version": 1, "notifications": [{"message": "x"}]}' > "$noat/autocompact-on.json"
printf '{"version": 1, "notifications": [{"message": "x"}]}' > "$noat/autocompact-off.json"
check "check: used_percent 欠落を指摘" "used_percent は 0〜100 の整数" "$(check_role "$noat")"

if CLAUDE_CONTEXT_NOTIFY_DATA="$baddir" python3 "$script" check >/dev/null 2>&1; then
  echo "NG: check は問題があれば非ゼロで終了すべき"
  fails=$((fails + 1))
else
  echo "ok: check: 問題があれば非ゼロで終了する"
fi

# --- autocompact detection ----------------------------------------------------
# The project side of the lookup is the hook payload's cwd, so cases pass one
# explicitly; the default is an empty directory, not the developer's own repo.
mkdir -p "$tmp/nocwd"
detect() { python3 -c "
import json, sys
import importlib.util
spec = importlib.util.spec_from_file_location('ctx', '$root/bin/ctx-notify.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.detect_autocompact(sys.argv[1])))
" "${1-$tmp/nocwd}"; }

check "検出: 既定では有効" '"enabled": true' "$(detect)"

out="$(DISABLE_AUTO_COMPACT=1 detect)"
check "検出: DISABLE_AUTO_COMPACT で無効" '"enabled": false' "$out"
check "検出: 無効の理由を持つ" 'DISABLE_AUTO_COMPACT env' "$out"

out="$(DISABLE_COMPACT=1 detect)"
check "検出: DISABLE_COMPACT で無効" '"enabled": false' "$out"

printf '{"autoCompactEnabled": false}' > "$CLAUDE_CONFIG_DIR/settings.json"
out="$(detect)"
check "検出: settings.json の autoCompactEnabled=false で無効" '"enabled": false' "$out"
check "検出: settings.json 由来だと分かる" 'autoCompactEnabled: false (settings.json)' "$out"
rm "$CLAUDE_CONFIG_DIR/settings.json"

printf '{"autoCompactEnabled": false}' > "$CLAUDE_CONFIG_DIR/.claude.json"
out="$(detect)"
check "検出: settings が無ければ .claude.json の false で無効" '"enabled": false' "$out"
check "検出: .claude.json 由来だと分かる" 'autoCompactEnabled: false (.claude.json)' "$out"

printf '{"autoCompactEnabled": true}' > "$CLAUDE_CONFIG_DIR/settings.json"
check "検出: settings.json の true が .claude.json の false に勝つ" '"enabled": true' "$(detect)"

mkdir -p "$tmp/proj/.claude"
printf '{"autoCompactEnabled": false}' > "$tmp/proj/.claude/settings.json"
out="$(detect "$tmp/proj")"
check "検出: プロジェクトの settings.json がユーザ設定に勝つ" '"enabled": false' "$out"
check "検出: プロジェクト由来だと分かる" 'autoCompactEnabled: false (.claude/settings.json)' "$out"
rm -r "$tmp/proj"
rm "$CLAUDE_CONFIG_DIR/settings.json"
printf '{}' > "$CLAUDE_CONFIG_DIR/.claude.json"

# CLAUDE_CONFIG_DIR does not reach hooks unless the user exported it; the config
# dir has to come out of CLAUDE_ENV_FILE in that case.
mkdir -p "$tmp/viaenvfile"
printf '{"autoCompactEnabled": false}' > "$tmp/viaenvfile/.claude.json"
check "検出: CLAUDE_ENV_FILE から config dir を割り出す" '"enabled": false' \
  "$(unset CLAUDE_CONFIG_DIR
     CLAUDE_ENV_FILE="$tmp/viaenvfile/session-env/abc/sessionstart-hook-0.sh" detect)"
check "検出: CLAUDE_ENV_FILE が CLAUDE_CONFIG_DIR に優先する" '"enabled": false' \
  "$(CLAUDE_ENV_FILE="$tmp/viaenvfile/session-env/abc/sessionstart-hook-0.sh" detect)"
mkdir -p "$tmp/fakehome/.claude"
printf '{"autoCompactEnabled": false}' > "$tmp/fakehome/.claude/.claude.json"
check "検出: どちらも無ければ HOME/.claude を見る" '"enabled": false' \
  "$(unset CLAUDE_CONFIG_DIR CLAUDE_ENV_FILE; HOME="$tmp/fakehome" detect)"

echo
if ((fails)); then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all cases passed"
