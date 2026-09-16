# claude-context-notify

> English | [日本語](./README-ja.md)

A Claude Code plugin that tells the running session how much of its context window it has
used — once per threshold crossed (20 / 40 / 60 / 80 / 90 / 95 / 97% by default).

Hooks only. No proxy, no status line, no external service: `python3` is the whole dependency.

## What it solves

A long-running session has no idea how much room it has left. It keeps starting large
investigations at 94% and gets cut off mid-handoff. The numbers exist — in the transcript and
in the `SessionStart` payload — but nothing puts them in front of the model.

This plugin measures usage after every turn and, when a threshold is crossed, injects a line
the model actually reads:

```
<system-reminder>
PostToolUse:Bash hook additional context: [context-notify] Main context usage: 60% (36,242 / 60,000 tokens)
</system-reminder>
```

## Quick Start

```bash
/plugin marketplace add kawaz/claude-context-notify
/plugin install context-notify@context-notify
/reload-plugins
```

Then, to see (and create) your config:

```bash
/context-notify:config
```

## Configuring thresholds and wording

There are two commands. Either way the config lives in the plugin data directory, so it
survives plugin updates.

| Command | Audience | What it does |
|---|---|---|
| `/context-notify:config` | **You only** (the model never invokes it) | Copies the bundled template on first run, then prints the path and the current bands. **Never edits.** |
| `/context-notify:setup [request]` | The model edits for you | Rewrites the config to match a free-form request, validates it, and reports the diff |

Open the file yourself with `config`, or ask in words with `setup`:

```bash
/context-notify:setup make the 90% message shorter
/context-notify:setup add a 70 threshold and drop 95 and 97
/context-notify:setup            # no argument: shows the current bands and asks what to change
```

After editing, `setup` runs `ctx-notify.py check`, which verifies the JSON, the thresholds
(integers 1–100, ascending, no duplicates), the presence of messages, and the spelling of
every placeholder.

### Adapting to auto-compact

When auto-compact is on, the high bands should be telling you to write a handoff before the
conversation is summarised away; when it is off, that wording is just misleading. So the
plugin checks one thing at startup — whether auto-compact is enabled — and picks the band
template to match.

| Detected | Profile used |
|---|---|
| Enabled | `autocompact-on` (wording that assumes a compaction is coming) |
| Disabled (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `autoCompactEnabled: false`) | `autocompact-off` |

Set `profile` to `autocompact-on` / `autocompact-off` to pin it. Writing your own `bands`
overrides the profile entirely.

**The plugin does not work out where auto-compact fires.** That point is set by Claude Code's
own window setting (`window - buffer`), so if you want a band just before it, put that percent
in `at` yourself. The on/off answer comes from `autoCompactEnabled` in
`$CLAUDE_CONFIG_DIR/.claude.json` and the two environment variables above; the config
directory is located from `CLAUDE_ENV_FILE`, since `CLAUDE_CONFIG_DIR` only reaches hooks when
you export it yourself. The reasoning is recorded in
[DR-0002](./docs/decisions/DR-0002-autocompact-profiles.md).

When auto-compact does fire, the `PreCompact` hook rewinds the latch and leaves one notice for
the first turn of the new context.

### Config format

```json
{
  "profile": "auto",
  "urgent_from": 90,
  "bands": [
    { "at": 20, "message": "context {used_percent}% used ({used_tokens} / {window_tokens} tokens)." },
    { "at": 90, "message": "context {used_percent}% used, {available_tokens} tokens left. Wrap up and write the handoff." }
  ]
}
```

- `profile` — `auto` (default, chosen by detection), `autocompact-on`, or `autocompact-off`.
  Ignored when `bands` is present.
- `bands[].at` — the threshold, in percent. Any number of bands, in any order.
- `bands[].message` — what the session is told. `{used_tokens}` (tokens used),
  `{used_percent}` (usage percent), `{available_tokens}` (tokens left),
  `{available_percent}` (percent left) and `{window_tokens}` (window size) are substituted.
  A misspelled placeholder is left as literal text rather than breaking the session.
- `urgent_from` — bands at or above this speak immediately from `Stop`, costing one extra
  continuation turn. Milder bands wait for a turn that was going to happen anyway.

### How the context window is resolved

The percentage is only as good as the window it divides by, and the model name — the one
place the `[1m]` suffix survives — is missing from some `SessionStart` payloads (`/clear`
and `claude -p` starts). So the window comes from the first of these that answers:

1. `CLAUDE_CONTEXT_WINDOW_TOKENS` — an explicit override (also handy for testing).
2. The `model` / `to_model` field of `SessionStart` / `PostModelSwitch`, when it is there.
3. The window the same claude process recorded earlier, keyed by `CLAUDE_PID` under
   `$XDG_STATE_HOME/claude-context-notify/by-pid/`. `/clear` keeps the process and only
   changes the session id, so the window carries over. Records of processes that are gone
   are swept away as new ones are written.
4. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — the variable Claude Code itself treats as the context
   window when it cannot derive one from the model name, so a session that sets it is
   measured against the same number the app uses.
5. 200,000 tokens.

## How it works

| Hook | Role | What it does |
|---|---|---|
| `SessionStart`, `PostModelSwitch` | `model` | Records the context window and whether auto-compact is enabled. Only these events spell the model with its `[1m]` suffix. |
| `Stop` | `measure` | Reads usage, moves the latch, queues the message. Speaks only at `urgent_from` and above. |
| `PostToolUse`, `UserPromptSubmit` | `deliver` | Also measures, then speaks whatever was queued. |
| `PreCompact` (matcher `auto`) | `precompact` | Rewinds the latch and queues a notice for the first turn after the compaction. |

Usage is the sum of `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` on
the newest non-sidechain assistant line of the transcript — the prompt length of the last
main-thread request. Measuring on all three events covers the transcript's asynchronous
writes, which sometimes leave `Stop` reading a turn that isn't there yet.

The latch is a single band in `$XDG_STATE_HOME/claude-context-notify/<session_id>.json`.
It speaks when usage rises past a band and silently rewinds when usage falls, so a `/compact`
or `/clear` re-arms the thresholds without emitting a pointless "you went down" notice.

Design rationale:
[DR-0001](./docs/decisions/DR-0001-hook-only-threshold-notification.md) (hook-only design) and
[DR-0002](./docs/decisions/DR-0002-autocompact-profiles.md) (auto-compact profiles).

## License

MIT
