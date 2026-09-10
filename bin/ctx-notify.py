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

stdin: hook JSON. stdout: hookSpecificOutput.additionalContext, or nothing.
"""
import json
import os
import pathlib
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


def load_config(path=None):
    """User config if readable, else the bundled defaults."""
    cfg = load_json(path or config_path()) or load_json(BUNDLED_CONFIG) or {}
    bands = {}
    for entry in cfg.get("bands") or []:
        try:
            bands[int(entry["at"])] = str(entry["message"])
        except (KeyError, TypeError, ValueError):
            continue
    urgent = cfg.get("urgent_from")
    return bands, (int(urgent) if isinstance(urgent, int) else 90)


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
    """SessionStart / PostModelSwitch: record the window for later events."""
    name = ev.get("to_model") or ev.get("model")
    if not name:
        return
    sp = state_path(ev["session_id"])
    st = load(sp)
    st["window"] = window_of(name)
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


def measure(ev, bands):
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
        st["pending"] = bands[band].format(pct=pct, used=f"{used:,}", win=f"{win:,}")
    sp.write_text(json.dumps(st))
    return band if band > prev else None


def take_pending(session_id):
    sp = state_path(session_id)
    st = load(sp)
    text = st.pop("pending", None)
    if text:
        sp.write_text(json.dumps(st))
    return text


def show_config(data_dir):
    """Create the config from the template if absent, then describe it."""
    path = config_path(data_dir)
    created = False
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(BUNDLED_CONFIG.read_text())
        created = True
    print(f"config: {path}" + ("  (テンプレから作成しました)" if created else ""))
    bands, urgent_from = load_config(path)
    print(f"urgent_from: {urgent_from}%  (この帯以上は Stop から即時に通知)")
    for at in sorted(bands):
        print(f"  {at:>3}%  {bands[at]}")
    print("\nこのファイルを編集すると閾値と文面を変えられます。")
    print("プレースホルダ: {pct} 使用率 / {used} 使用トークン / {win} window")


def main():
    role = sys.argv[1] if len(sys.argv) > 1 else "deliver"

    if role == "config":
        arg = sys.argv[2] if len(sys.argv) > 2 else ""
        # The caller passes ${CLAUDE_PLUGIN_DATA}; an unexpanded template means
        # we are not running under a plugin install, so fall back to XDG.
        show_config(arg if arg and "${" not in arg else None)
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

    bands, urgent_from = load_config()
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
