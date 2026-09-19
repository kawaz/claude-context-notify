#!/usr/bin/env python3
"""Notify the session when its context usage crosses a threshold.

argv[1] is the role:
  model    -- wire to SessionStart / PostModelSwitch. Records the context
              window, which only these events spell with the `[1m]` suffix,
              and whether auto-compact is enabled. When the payload carries no
              model name (`/clear` and headless starts do not), the window is
              resolved from the record kept per claude process and from
              CLAUDE_CODE_MAX_CONTEXT_TOKENS.
  measure  -- wire to Stop and PostToolUse. Reads usage, moves the latch, and
              speaks on the spot when the latch just moved up into a band.
  config   -- not a hook. Called by /context-notify:config with the plugin
              data dir as argv[2]. Creates the two notification lists from the
              bundled templates if absent, then prints their paths and the
              bands of the one this session uses.
  check    -- not a hook. Called by /context-notify:setup after editing.
              Validates both lists and exits non-zero if either has problems.

stdin: hook JSON. stdout: hookSpecificOutput.additionalContext, or nothing.
"""
import json
import os
import pathlib
import string
import sys

DEFAULT_WINDOW = 200_000
CONFIG_VERSION = 1
TEMPLATES = pathlib.Path(__file__).resolve().parent.parent / "templates"
LISTS = ("autocompact-on", "autocompact-off")


def data_dir(explicit=None):
    """Where the user's notification lists live, whether or not they exist yet.

    CLAUDE_PLUGIN_DATA survives plugin updates, so it is the primary home.
    The XDG fallback keeps the script usable outside a plugin install.
    """
    override = os.environ.get("CLAUDE_CONTEXT_NOTIFY_DATA")
    if override:
        return pathlib.Path(override)
    data = explicit or os.environ.get("CLAUDE_PLUGIN_DATA")
    if data:
        return pathlib.Path(data)
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return pathlib.Path(base) / "claude-context-notify"


def load_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def list_name(info):
    """Which of the two lists this session uses."""
    return "autocompact-on" if (info or {}).get("enabled") else "autocompact-off"


def list_path(name, dir_=None):
    return data_dir(dir_) / f"{name}.json"


def ensure_list(name, dir_=None):
    """The user's copy of a list, created from the bundled template if absent.

    An existing file is never touched. When the directory cannot be written,
    the bundled template is returned instead so the session keeps working.
    """
    path = list_path(name, dir_)
    if path.exists():
        return path, False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text((TEMPLATES / f"{name}.json").read_text())
    except OSError:
        return TEMPLATES / f"{name}.json", False
    return path, True


def _entries_of(cfg):
    return [e for e in (cfg.get("notifications") or []) if isinstance(e, dict)]


def resolve_bands(entries):
    """Turn band entries into {percent: message}.

    Several entries may share a `used_percent`; their messages join with newlines
    in the order they are written, so crossing the band still speaks exactly once.
    """
    bands = {}
    for entry in entries:
        message = entry.get("message")
        if not isinstance(message, str):
            continue
        try:
            at = int(entry.get("used_percent"))
        except (TypeError, ValueError):
            continue
        if 0 < at <= 100:
            bands[at] = f"{bands[at]}\n{message}" if at in bands else message
    return bands


def load_bands(info=None, dir_=None):
    """The bands for this session, plus the name of the list they came from."""
    name = list_name(info)
    path, _ = ensure_list(name, dir_)
    entries = _entries_of(load_json(path) or {})
    if not entries:
        entries = _entries_of(load_json(TEMPLATES / f"{name}.json") or {})
    return entries, name


PLACEHOLDERS = (
    "used_tokens",
    "used_percent",
    "available_tokens",
    "available_percent",
    "window_tokens",
)


def config_dir():
    """Where Claude Code keeps its settings for this session.

    `CLAUDE_CONFIG_DIR` reaches hooks only when the user exported it themselves
    (measured: it is absent otherwise). `CLAUDE_ENV_FILE`, which SessionStart
    hooks do get, sits at `<config dir>/session-env/<session>/...`, so it names
    the real directory even when the variable is unset.
    """
    env_file = os.environ.get("CLAUDE_ENV_FILE")
    if env_file:
        head, sep, _ = env_file.partition("/session-env/")
        if sep and head:
            return pathlib.Path(head)
    return pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"))


def autocompact_sources(cwd=None):
    """Where `autoCompactEnabled` may sit, highest precedence first.

    The settings files come in Claude Code's own order (project before user,
    `.local` before shared); the global `.claude.json` is the last resort.
    """
    project = pathlib.Path(cwd) if cwd else pathlib.Path.cwd()
    cfg = config_dir()
    return [
        (project / ".claude" / "settings.local.json", ".claude/settings.local.json"),
        (project / ".claude" / "settings.json", ".claude/settings.json"),
        (cfg / "settings.local.json", "settings.local.json"),
        (cfg / "settings.json", "settings.json"),
        (cfg / ".claude.json", ".claude.json"),
    ]


def detect_autocompact(cwd=None):
    """Whether auto-compact will fire at all.

    Only the on/off question is asked: where it fires depends on Claude Code's
    own window setting, and placing bands against it is the user's job. See
    docs/decisions/DR-0002.
    """
    for var in ("DISABLE_AUTO_COMPACT", "DISABLE_COMPACT"):
        if os.environ.get(var):
            return {"enabled": False, "reason": f"{var} env"}

    for path, label in autocompact_sources(cwd):
        value = (load_json(path) or {}).get("autoCompactEnabled")
        if isinstance(value, bool):
            why = f"autoCompactEnabled: {'true' if value else 'false'} ({label})"
            return {"enabled": value, "reason": why}

    return {"enabled": True, "reason": "default"}


class _Lenient(dict):
    """Leaves unknown placeholders as literal text instead of raising."""

    def __missing__(self, key):
        return "{" + key + "}"


def render(template, pct, used, window):
    """Fill a band message. A typo in the config must not break the session.

    `available_percent` is derived from the rounded `used_percent` so the two
    always add up to 100 in the same sentence.
    """
    values = _Lenient(
        used_tokens=f"{used:,}",
        used_percent=pct,
        available_tokens=f"{window - used:,}",
        available_percent=100 - pct,
        window_tokens=f"{window:,}",
    )
    try:
        return template.format_map(values)
    except (IndexError, ValueError):
        return template


def check_config(path):
    """Problems with a notification list, as a list of human-readable lines."""
    raw = load_json(path)
    if raw is None:
        return [f"JSON として読めません: {path}"]

    problems = []
    version = raw.get("version")
    if version != CONFIG_VERSION:
        problems.append(
            f"version が古い (ファイル: {version!r} / 現在: {CONFIG_VERSION})。"
            f"テンプレ templates/{path.stem}.json を参考に書き直してください"
        )

    entries = raw.get("notifications")
    if not isinstance(entries, list) or not entries:
        return problems + ["notifications は 1 件以上の配列にしてください"]

    seen = []
    for i, entry in enumerate(entries):
        where = f"notifications[{i}]"
        if not isinstance(entry, dict):
            problems.append(f"{where}: オブジェクトにしてください")
            continue
        at = entry.get("used_percent")
        if not isinstance(at, int) or isinstance(at, bool) or not 1 <= at <= 100:
            problems.append(
                f"{where}.used_percent は 1〜100 の整数にしてください (現在: {at!r})"
            )
        else:
            # Entries may share a `used_percent` (their messages join); only a
            # step back in the order is a mistake.
            if seen and at < seen[-1]:
                problems.append(
                    f"{where}.used_percent = {at} が昇順になっていません (前は {seen[-1]})"
                )
            seen.append(at)
        msg = entry.get("message")
        if not isinstance(msg, str) or not msg.strip():
            problems.append(f"{where}.message は空でない文字列にしてください")
            continue
        for name in _placeholder_names(msg):
            if name not in PLACEHOLDERS:
                problems.append(
                    f"{where}.message: 未知のプレースホルダ {{{name}}} "
                    f"(使えるのは {', '.join('{%s}' % p for p in PLACEHOLDERS)})"
                )
    return problems


def check_all(dir_=None):
    """Validate both lists. Returns the exit status the caller should use."""
    status = 0
    for name in LISTS:
        path, created = ensure_list(name, dir_)
        print(f"{name}: {path}" + ("  (テンプレから作成しました)" if created else ""))
        status |= report_problems(check_config(path))
        print()
    return status


def _placeholder_names(template):
    try:
        return [n for _, n, _, _ in string.Formatter().parse(template) if n]
    except ValueError:
        return []


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    d = pathlib.Path(base) / "claude-context-notify"
    d.mkdir(parents=True, exist_ok=True)
    return d


def state_path(session_id):
    return state_dir() / f"{session_id}.json"


def load(path):
    return load_json(path) or {}


def tail_lines(path, budget=400_000):
    """Read the last `budget` bytes and return whole lines from it."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - budget))
        chunk = f.read()
    if len(chunk) < size:
        chunk = chunk.split(b"\n", 1)[1] if b"\n" in chunk else b""
    return chunk.splitlines()


def last_main_usage(path):
    """Prompt length of the most recent main-thread request, or None."""
    for raw in reversed(tail_lines(path)):
        if b'"usage"' not in raw:
            continue
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if d.get("type") != "assistant" or d.get("isSidechain"):
            continue
        u = (d.get("message") or {}).get("usage") or {}
        total = (
            u.get("input_tokens", 0)
            + u.get("cache_creation_input_tokens", 0)
            + u.get("cache_read_input_tokens", 0)
        )
        if total:
            return total
    return None


def window_of(model_name):
    """Context window implied by a model name as SessionStart spells it."""
    return 1_000_000 if "[1m]" in (model_name or "") else DEFAULT_WINDOW


def _claude_pid():
    """PID of the claude process this hook belongs to, when it is in the env."""
    pid = os.environ.get("CLAUDE_PID") or ""
    return pid if pid.isdigit() else None


def pid_record_path(pid):
    d = state_dir() / "by-pid"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{pid}.json"


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except (OSError, ValueError):
        # A live process owned by somebody else, or an unusable pid string.
        return True
    return True


def remember_pid_window(window):
    """Keep the window under the claude process, so `/clear` can inherit it.

    `/clear` starts a new session_id inside the same process and its
    SessionStart payload carries no model name, which leaves the per-session
    record with nothing to read. CLAUDE_PID is stable across that boundary.
    """
    pid = _claude_pid()
    if not pid:
        return
    path = pid_record_path(pid)
    path.write_text(json.dumps({"window": window}))
    for other in path.parent.glob("*.json"):
        if other != path and not _pid_alive(other.stem):
            other.unlink(missing_ok=True)


def pid_window():
    """Window recorded by an earlier session of the same claude process."""
    pid = _claude_pid()
    if not pid:
        return None
    value = (load_json(pid_record_path(pid)) or {}).get("window")
    return value if isinstance(value, int) else None


def env_window():
    """CLAUDE_CODE_MAX_CONTEXT_TOKENS, which Claude Code itself falls back to.

    Claude Code reads this variable as the context window whenever it cannot
    derive one from the model name (a gateway model it does not know, say), so
    a session configured with it measures against the same number we do.
    """
    value = os.environ.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS") or ""
    return int(value) if value.isdigit() else None


def resolve_window(recorded=None, model_name=None):
    """The window to measure against, most specific source first.

    The env override wins outright; then the model name as SessionStart /
    PostModelSwitch spell it (the only place `[1m]` survives — the transcript
    and the upstream request both drop it), then what an earlier session of
    this claude process saw, then Claude Code's own window variable.
    """
    override = os.environ.get("CLAUDE_CONTEXT_WINDOW_TOKENS")
    if override and override.isdigit():
        return int(override)
    if model_name:
        return window_of(model_name)
    return recorded or pid_window() or env_window() or DEFAULT_WINDOW


def window_for(st):
    return resolve_window(recorded=st.get("window"))


def remember_window(ev):
    """SessionStart / PostModelSwitch: record the window and the compact setup."""
    sp = state_path(ev["session_id"])
    st = load(sp)
    name = ev.get("to_model") or ev.get("model")
    if name:
        st["window"] = window_of(name)
        remember_pid_window(st["window"])
    st["autocompact"] = detect_autocompact(ev.get("cwd"))
    sp.write_text(json.dumps(st))


def band_of(pct, bands):
    hit = 0
    for b in sorted(bands):
        if pct >= b:
            hit = b
    return hit


def speak(event, text):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": event,
        "additionalContext": f"[context-notify] {text}",
    }}))


def measure(ev, entries):
    """Move the latch to match current usage. Returns the text to speak, if any.

    The transcript is written asynchronously, so at Stop the newest assistant
    line is sometimes not there yet. Measuring on PostToolUse as well as at Stop
    means a missed read is picked up by the next one.
    """
    tp = ev.get("transcript_path")
    if not tp or not os.path.exists(tp):
        return
    used = last_main_usage(tp)
    if not used:
        return
    sp = state_path(ev["session_id"])
    st = load(sp)
    win = window_for(st)
    bands = resolve_bands(entries)
    pct = round(used * 100 / win)
    band = band_of(pct, bands)

    prev = st.get("band", 0)
    if band == prev:
        return

    st["band"] = band
    sp.write_text(json.dumps(st))
    # Going down means a compact or clear reset the usage. Move the latch back
    # without saying anything.
    if band > prev and band in bands:
        return render(bands[band], pct=pct, used=used, window=win)


def show_config(dir_=None, session_id=None):
    """Create the two lists from the templates if absent, then describe them."""
    for name in LISTS:
        path, created = ensure_list(name, dir_)
        print(f"{name}: {path}" + ("  (テンプレから作成しました)" if created else ""))
    info = detect_autocompact()
    print(describe_autocompact(info))
    entries, chosen = load_bands(info, dir_)
    # Percentages mean different token counts per window, so show the bands
    # against this session's own window when we know it.
    st = load(state_path(session_id)) if session_id else {}
    override = os.environ.get("CLAUDE_CONTEXT_WINDOW_TOKENS")
    if override and override.isdigit():
        window, window_from = int(override), "CLAUDE_CONTEXT_WINDOW_TOKENS"
    elif st.get("window"):
        window, window_from = st["window"], "このセッション"
    elif pid_window():
        window, window_from = pid_window(), "同じ claude プロセスの直前のセッション"
    elif env_window():
        window, window_from = env_window(), "CLAUDE_CODE_MAX_CONTEXT_TOKENS"
    else:
        window, window_from = DEFAULT_WINDOW, "既定"
    print(f"このセッションが使うのは: {chosen}")
    for entry in entries:
        at = entry.get("used_percent")
        label = f"{at:>3}%" if isinstance(at, int) else "  ?%"
        print(f"  {label}  {entry.get('message', '')}")
    print(f"\n(帯は window {window:,} tokens = {window_from}の値 を基準に表示しています)")
    print("上の 2 ファイルを編集すると閾値と文面を変えられます。")
    print(
        "プレースホルダ: {used_tokens} 使用トークン / {used_percent} 使用率 / "
        "{available_tokens} 残りトークン / {available_percent} 残り % / "
        "{window_tokens} window"
    )
    report_problems(check_config(list_path(chosen, dir_)))


def describe_autocompact(info):
    """One line on whether auto-compact is on, for humans and for the model."""
    if not info.get("enabled"):
        return f"auto compact: 無効 ({info.get('reason')})"
    return "auto compact: 有効 (発火点は Claude Code 側の window 設定で決まる)"


def report_problems(problems):
    """Print a verdict. Returns the exit status the caller should use."""
    if not problems:
        print("\n設定は妥当です。")
        return 0
    print("\n設定に問題があります:")
    for p in problems:
        print(f"  - {p}")
    return 1


def main():
    role = sys.argv[1] if len(sys.argv) > 1 else "measure"

    if role in ("config", "check"):
        arg = sys.argv[2] if len(sys.argv) > 2 else ""
        # The caller passes ${CLAUDE_PLUGIN_DATA}; an unexpanded template means
        # we are not running under a plugin install, so fall back to XDG.
        dir_ = arg if arg and "${" not in arg else None
        sid_arg = sys.argv[3] if len(sys.argv) > 3 else ""
        session_id = sid_arg if sid_arg and "${" not in sid_arg else None
        if role == "check":
            sys.exit(check_all(dir_))
        show_config(dir_, session_id)
        return

    try:
        ev = json.load(sys.stdin)
    except ValueError:
        return
    sid = ev.get("session_id")
    if not sid:
        return

    if role == "model":
        remember_window(ev)
        return

    bands, _chosen = load_bands(load(state_path(sid)).get("autocompact"))
    if not bands:
        return

    # A continuation turn this hook caused. Measuring again is fine; speaking
    # again would loop.
    if ev.get("stop_hook_active"):
        measure(ev, bands)
        return

    text = measure(ev, bands)
    if text:
        speak(ev.get("hook_event_name"), text)


if __name__ == "__main__":
    main()
