#!/usr/bin/env python3
"""Notify the session when its context usage crosses a threshold.

argv[1] is the role:
  model    -- wire to SessionStart / PostModelSwitch. Records the context
              window, which only these events spell with the `[1m]` suffix.
  measure  -- wire to Stop. Reads usage, moves the latch, queues the message.
              At the urgent band it also speaks immediately (Stop can inject).
  deliver  -- wire to PostToolUse / UserPromptSubmit. Speaks whatever measure
              queued, so the report rides a turn that was happening anyway.
  config   -- not a hook. Called by /context-notify:config with the plugin
              data dir as argv[2]. Creates the config from the bundled
              template if absent, then prints the path and the thresholds.
  precompact -- wire to PreCompact (matcher auto). Rewinds the latch and
              queues one notice for the first turn after the compaction.
  check    -- not a hook. Called by /context-notify:setup after editing.
              Validates the config and exits non-zero if it has problems.

stdin: hook JSON. stdout: hookSpecificOutput.additionalContext, or nothing.
"""
import json
import os
import pathlib
import string
import sys

DEFAULT_WINDOW = 200_000
BUNDLED_CONFIG = pathlib.Path(__file__).resolve().parent.parent / "templates" / "config.json"


def config_path(data_dir=None):
    """Where the user's config lives, whether or not it exists yet.

    CLAUDE_PLUGIN_DATA survives plugin updates, so it is the primary home.
    The XDG fallback keeps the script usable outside a plugin install.
    """
    override = os.environ.get("CLAUDE_CONTEXT_NOTIFY_CONFIG")
    if override:
        return pathlib.Path(override)
    data = data_dir or os.environ.get("CLAUDE_PLUGIN_DATA")
    if data:
        return pathlib.Path(data) / "config.json"
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return pathlib.Path(base) / "claude-context-notify" / "config.json"


def load_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


PROFILES = ("autocompact-on", "autocompact-off")


def profile_path(name):
    return BUNDLED_CONFIG.parent / f"{name}.json"


def _bands_of(cfg):
    """Band entries as written, still unresolved (`before_autocompact` intact)."""
    return [e for e in (cfg.get("bands") or []) if isinstance(e, dict)]


def resolve_bands(entries, info, window):
    """Turn band entries into {percent: message} for a known window.

    `before_autocompact: 5` means "five points before auto-compact fires". It
    can only be placed once we know both the window we measure against and the
    token count auto-compact triggers at, so it happens here rather than at
    load time. Without that number those bands are dropped.
    """
    ac_pct = autocompact_pct(info or {}, window)
    bands = {}
    for entry in entries:
        message = entry.get("message")
        if not isinstance(message, str):
            continue
        at = entry.get("at")
        if at is None:
            offset = entry.get("before_autocompact")
            if ac_pct is None or not isinstance(offset, int):
                continue
            at = ac_pct - offset
        try:
            at = int(at)
        except (TypeError, ValueError):
            continue
        if 0 < at <= 100:
            bands[at] = message
    return bands


def choose_profile(requested, info):
    """Resolve `profile: auto` against what we detected. Unknown names fall back."""
    if requested in PROFILES:
        return requested, "設定で指定"
    if info.get("enabled") and info.get("threshold"):
        return "autocompact-on", "auto compact が閾値で走ると検出"
    if info.get("enabled"):
        return "autocompact-off", "auto compact は有効だが閾値が定まらない (reactive)"
    return "autocompact-off", "auto compact は無効"


def load_config(path=None, info=None):
    """The bands to use, plus how they were chosen.

    Bands written in the config always win. Otherwise the profile decides, and
    `auto` (the shipped default) picks one from what we detect.
    """
    cfg = load_json(path or config_path()) or load_json(BUNDLED_CONFIG) or {}
    entries = _bands_of(cfg)
    if entries:
        chosen, why = "custom", "設定に bands があるため"
    else:
        chosen, why = choose_profile(cfg.get("profile", "auto"), info or {})
        profile_cfg = load_json(profile_path(chosen)) or {}
        entries = _bands_of(profile_cfg)
        if not isinstance(cfg.get("urgent_from"), int):
            cfg = dict(cfg, urgent_from=profile_cfg.get("urgent_from"))
    urgent = cfg.get("urgent_from")
    return entries, (int(urgent) if isinstance(urgent, int) else 90), (chosen, why)


PLACEHOLDERS = ("pct", "used", "window", "ac_pct", "ac_tokens")

# Measured constant: /context reports "Autocompact buffer | 33k" for every
# explicit window (110k / 120k / 150k), and 1M - 33k = 967K matches the figure
# the changelog gives for Sonnet 5. Compaction fires at window - buffer.
AUTOCOMPACT_BUFFER = 33_000


def _argv_of(pid):
    """Full argument vector of a process, or [] when it cannot be read.

    `ps` is not usable here: on macOS it hands back the parent's command line
    truncated to ~63 characters (measured, and `-ww` does not lift it), which
    silently hides a `--autocompact` that sits late in the line.
    """
    if sys.platform.startswith("linux"):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                return [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
        except OSError:
            return []
    if sys.platform != "darwin":
        return []
    try:
        import ctypes

        libc = ctypes.CDLL("libc.dylib", use_errno=True)
        CTL_KERN, KERN_PROCARGS2 = 1, 49
        mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
        size = ctypes.c_size_t(1 << 18)
        buf = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
            return []
        raw = buf.raw[:size.value]
        argc = int.from_bytes(raw[:4], sys.byteorder)
        # argc, then the exec path, then the arguments themselves.
        parts = [p for p in raw[4:].split(b"\0") if p]
        if len(parts) <= argc:
            return []
        return [p.decode("utf-8", "replace") for p in parts[1:1 + argc]]
    except (OSError, ValueError, AttributeError):
        return []


def _ppid_of(pid):
    import subprocess

    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=", "-p", str(pid)],
            capture_output=True, text=True, timeout=2,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return 0
    return int(out) if out.isdigit() else 0


def _cli_autocompact_window(limit=4):
    """`--autocompact <tokens>` on the claude process that owns this hook."""
    pid = os.getppid()
    for _ in range(limit):
        if pid <= 1:
            break
        argv = _argv_of(pid)
        for i, part in enumerate(argv):
            value = None
            if part == "--autocompact" and i + 1 < len(argv):
                value = argv[i + 1]
            elif part.startswith("--autocompact="):
                value = part.split("=", 1)[1]
            if value is not None:
                return int(value) if value.isdigit() else None
        pid = _ppid_of(pid)
    return None


def _settings_files(cwd):
    """Settings files that can carry autoCompactWindow, highest precedence first."""
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    project = pathlib.Path(cwd or ".")
    return [
        pathlib.Path(config_dir) / "managed-settings.json",
        project / ".claude" / "settings.local.json",
        project / ".claude" / "settings.json",
        pathlib.Path(config_dir) / "settings.json",
    ]


def detect_autocompact(cwd=None):
    """Whether auto-compact will fire, and at how many tokens.

    Every channel here was measured against Claude Code v2.1.268 (macOS); see
    docs/decisions/DR-0002. `window` is None when nothing pins one, which means
    Claude Code compacts reactively rather than at a threshold we can predict.
    """
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    enabled, why = True, "default"

    global_config = load_json(pathlib.Path(config_dir) / ".claude.json") or {}
    if global_config.get("autoCompactEnabled") is False:
        enabled, why = False, "autoCompactEnabled: false"
    for var in ("DISABLE_AUTO_COMPACT", "DISABLE_COMPACT"):
        if os.environ.get(var):
            enabled, why = False, f"{var} env"

    window, source = None, "auto"
    env_window = os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    cli_window = _cli_autocompact_window()
    if env_window and env_window.isdigit():
        # Measured: env wins over --autocompact (env 120k + CLI 150k -> 120k).
        window, source = int(env_window), "CLAUDE_CODE_AUTO_COMPACT_WINDOW env"
    elif cli_window:
        window, source = cli_window, "--autocompact"
    else:
        for path in _settings_files(cwd):
            value = (load_json(path) or {}).get("autoCompactWindow")
            if isinstance(value, int):
                window, source = value, f"autoCompactWindow ({path})"
                break

    result = {"enabled": enabled, "reason": why, "window": window, "source": source}
    if enabled and window:
        result["threshold"] = max(0, window - AUTOCOMPACT_BUFFER)
    return result


def autocompact_pct(info, window):
    """Where auto-compact fires, as a percentage of the window we measure against."""
    threshold = info.get("threshold")
    if not threshold or not window:
        return None
    return round(threshold * 100 / window)


class _Lenient(dict):
    """Leaves unknown placeholders as literal text instead of raising."""

    def __missing__(self, key):
        return "{" + key + "}"


def render(template, pct, used, window, info=None):
    """Fill a band message. A typo in the config must not break the session."""
    ac_tokens = (info or {}).get("threshold")
    values = _Lenient(
        pct=pct,
        used=f"{used:,}",
        window=f"{window:,}",
        ac_pct=autocompact_pct(info or {}, window),
        ac_tokens=f"{ac_tokens:,}" if ac_tokens else None,
    )
    try:
        return template.format_map(values)
    except (IndexError, ValueError):
        return template


def check_config(path):
    """Problems with a config file, as a list of human-readable lines."""
    raw = load_json(path)
    if raw is None:
        return [f"JSON として読めません: {path}"]

    problems = []
    urgent = raw.get("urgent_from", 90)
    if not isinstance(urgent, int) or not 1 <= urgent <= 100:
        problems.append(f"urgent_from は 1〜100 の整数にしてください (現在: {urgent!r})")

    profile = raw.get("profile", "auto")
    if profile not in PROFILES + ("auto",):
        problems.append(
            f"profile は auto / {' / '.join(PROFILES)} のいずれかにしてください "
            f"(現在: {profile!r})"
        )

    entries = raw.get("bands")
    if entries is None:
        # No bands means the profile supplies them, which is the shipped default.
        return problems
    if not isinstance(entries, list) or not entries:
        return problems + ["bands は 1 件以上の配列にしてください (profile に任せるなら丸ごと消す)"]

    seen = []
    for i, entry in enumerate(entries):
        where = f"bands[{i}]"
        if not isinstance(entry, dict):
            problems.append(f"{where}: オブジェクトにしてください")
            continue
        at, offset = entry.get("at"), entry.get("before_autocompact")
        if at is not None and offset is not None:
            problems.append(f"{where}: at と before_autocompact は同時に書けません")
        elif offset is not None:
            if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 50:
                problems.append(
                    f"{where}.before_autocompact は 0〜50 の整数にしてください (現在: {offset!r})"
                )
        elif not isinstance(at, int) or isinstance(at, bool) or not 1 <= at <= 100:
            problems.append(f"{where}.at は 1〜100 の整数にしてください (現在: {at!r})")
        else:
            if at in seen:
                problems.append(f"{where}.at = {at} が重複しています")
            if seen and at < seen[-1]:
                problems.append(f"{where}.at = {at} が昇順になっていません (前は {seen[-1]})")
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


def _placeholder_names(template):
    try:
        return [n for _, n, _, _ in string.Formatter().parse(template) if n]
    except ValueError:
        return []


def state_path(session_id):
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    d = pathlib.Path(base) / "claude-context-notify"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{session_id}.json"


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


def window_for(st):
    override = os.environ.get("CLAUDE_CONTEXT_WINDOW_TOKENS")
    if override and override.isdigit():
        return int(override)
    # Recorded by the `model` role. The transcript spells the model without its
    # `[1m]` suffix, so this is the only place the real window is known.
    return st.get("window") or DEFAULT_WINDOW


def remember_window(ev):
    """SessionStart / PostModelSwitch: record the window and the compact setup.

    Detection costs a few `ps` calls, so it runs here (twice a session at most)
    rather than on every measured event.
    """
    sp = state_path(ev["session_id"])
    st = load(sp)
    name = ev.get("to_model") or ev.get("model")
    if name:
        st["window"] = window_of(name)
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
    """Move the latch to match current usage. Returns the band just crossed.

    The transcript is written asynchronously, so at Stop the newest assistant
    line is sometimes not there yet. Measuring on every event instead of only
    at Stop means a missed read is picked up by the next one.
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
    info = st.get("autocompact") or {}
    bands = resolve_bands(entries, info, win)
    pct = round(used * 100 / win)
    band = band_of(pct, bands)

    prev = st.get("band", 0)
    if band == prev:
        return

    st["band"] = band
    st.pop("pending", None)
    # Going down means a compact or clear reset the usage. Move the latch back
    # without saying anything.
    if band > prev and band in bands:
        st["pending"] = render(bands[band], pct=pct, used=used, window=win, info=info)
    sp.write_text(json.dumps(st))
    return band if band > prev else None


PRECOMPACT_MESSAGE = (
    "auto compact が走りました。ここより前のやり取りは要約に置き換わっています。"
    "要約が落とした前提があれば、作業を進める前に確認してください。"
    "使用率の通知は 0% から測り直します。"
)


def precompact(ev):
    """PreCompact: rewind the latch and leave one notice for after the compact.

    Speaking here would be wasted — the turn that reads it is the one being
    summarised away. Queuing keeps it for the first turn of the new context,
    and rewinding matches how a drop in usage is handled everywhere else.
    """
    sp = state_path(ev["session_id"])
    st = load(sp)
    st["band"] = 0
    st.pop("pending", None)  # a threshold notice about the context being replaced
    # Kept apart from `pending`: the transcript can still read high right after
    # PreCompact, and a measurement that lands in between would otherwise
    # overwrite this notice with a threshold message.
    st["notice"] = PRECOMPACT_MESSAGE
    sp.write_text(json.dumps(st))


def take_pending(session_id):
    """Everything queued for the next turn: event notices first, then bands."""
    sp = state_path(session_id)
    st = load(sp)
    parts = [st.pop("notice", None), st.pop("pending", None)]
    texts = [p for p in parts if p]
    if texts:
        sp.write_text(json.dumps(st))
    return " ".join(texts) if texts else None


def show_config(data_dir, session_id=None):
    """Create the config from the template if absent, then describe it."""
    path = config_path(data_dir)
    created = False
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(BUNDLED_CONFIG.read_text())
        created = True
    print(f"config: {path}" + ("  (テンプレから作成しました)" if created else ""))
    info = detect_autocompact(os.getcwd())
    print(describe_autocompact(info))
    entries, urgent_from, (profile, why) = load_config(path, info)
    # Relative bands land differently depending on the window we measure
    # against, so show them against this session's own window when we know it.
    st = load(state_path(session_id)) if session_id else {}
    window, window_from = st.get("window"), "このセッション"
    if not window:
        window, window_from = DEFAULT_WINDOW, "既定"
    print(f"profile: {profile}  ({why})")
    print(f"urgent_from: {urgent_from}%  (この帯以上は Stop から即時に通知)")
    ac_pct = autocompact_pct(info, window)
    for entry in entries:
        message = entry.get("message", "")
        if entry.get("at") is not None:
            label = f"{entry['at']:>3}%"
        else:
            offset = entry.get("before_autocompact")
            placed = f"= {ac_pct - offset}%" if ac_pct and isinstance(offset, int) else "未確定"
            label = f"AC-{offset}pt ({placed})"
        print(f"  {label}  {message}")
    print(f"\n(帯は window {window:,} tokens = {window_from}の値 を基準に表示しています)")
    print("このファイルを編集すると閾値と文面を変えられます。")
    print("プレースホルダ: {pct} 使用率 / {used} 使用トークン / {window} window /"
          " {ac_pct} auto compact の発火率 / {ac_tokens} 同トークン数")
    report_problems(check_config(path))


def describe_autocompact(info):
    """One line on what auto-compact will do, for humans and for the model."""
    if not info.get("enabled"):
        return f"auto compact: 無効 ({info.get('reason')})"
    window, threshold = info.get("window"), info.get("threshold")
    if not threshold:
        return (
            "auto compact: 有効だが閾値は未確定 "
            "(window 指定が無く、Claude Code が上限到達時に反応的に compact する)"
        )
    return (
        f"auto compact: 有効、{threshold:,} tokens で発火 "
        f"(window {window:,} - buffer {AUTOCOMPACT_BUFFER:,}、由来: {info.get('source')})"
    )


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
    role = sys.argv[1] if len(sys.argv) > 1 else "deliver"

    if role in ("config", "check"):
        arg = sys.argv[2] if len(sys.argv) > 2 else ""
        # The caller passes ${CLAUDE_PLUGIN_DATA}; an unexpanded template means
        # we are not running under a plugin install, so fall back to XDG.
        data_dir = arg if arg and "${" not in arg else None
        sid_arg = sys.argv[3] if len(sys.argv) > 3 else ""
        session_id = sid_arg if sid_arg and "${" not in sid_arg else None
        if role == "check":
            path = config_path(data_dir)
            print(f"config: {path}")
            sys.exit(report_problems(check_config(path)))
        show_config(data_dir, session_id)
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

    if role == "precompact":
        precompact(ev)
        return

    bands, urgent_from, _profile = load_config(info=load(state_path(sid)).get("autocompact"))
    if not bands:
        return

    # A continuation turn this hook caused. Measuring again is fine; speaking
    # again would loop.
    if ev.get("stop_hook_active"):
        measure(ev, bands)
        return

    band = measure(ev, bands)
    # Stop only interrupts for a band worth its own turn; anything milder waits
    # for a turn that was going to happen anyway.
    if role == "measure" and not (band and band >= urgent_from):
        return
    text = take_pending(sid)
    if text:
        speak(ev.get("hook_event_name"), text)


if __name__ == "__main__":
    main()
