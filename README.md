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

Everything you can configure lives in two files in the plugin data directory, so it survives
plugin updates: `autocompact-on.json` and `autocompact-off.json`. There are two commands for
reaching them.

| Command | Audience | What it does |
|---|---|---|
| `/context-notify:config` | **You only** (the model never invokes it) | Copies the bundled templates on first run, then prints both paths and the notifications this session uses. **Never edits.** |
| `/context-notify:setup [request]` | The model edits for you | Rewrites the lists to match a free-form request, validates them, and reports the diff |

Open the file yourself with `config`, or ask in words with `setup`:

```bash
/context-notify:setup make the 90% message shorter
/context-notify:setup add a 70 threshold and drop 95 and 97
/context-notify:setup            # no argument: shows the current bands and asks what to change
```

After editing, `setup` runs `ctx-notify.py check`, which verifies both files — the JSON, the
schema version, the thresholds (integers 1–100, ascending), the presence of messages, and the
spelling of every placeholder.

### Adapting to auto-compact

When auto-compact is on, the high bands should be telling you to write a handoff before the
conversation is summarised away; when it is off, that wording is just misleading. So the
plugin checks one thing at startup — whether auto-compact is enabled — and reads the list
that matches.

| Detected | List read |
|---|---|
| Enabled | `autocompact-on.json` (wording that assumes a compaction is coming) |
| Disabled (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `autoCompactEnabled: false`) | `autocompact-off.json` |

To get the same notifications either way, give both files the same contents.

**The plugin does not work out where auto-compact fires.** That point is set by Claude Code's
own window setting (`window - buffer`), so if you want a band just before it, put that percent
in `used_percent` yourself. The on/off answer comes from the two environment variables above and from
`autoCompactEnabled`, looked up in Claude Code's own settings order — the project's
`.claude/settings.local.json` and `.claude/settings.json`, then your `settings.local.json` and
`settings.json`, with `.claude.json` as a last resort. The config directory is located from
`CLAUDE_ENV_FILE`, since `CLAUDE_CONFIG_DIR` only reaches hooks when you export it yourself.
The reasoning is recorded in
[DR-0002](./docs/decisions/DR-0002-autocompact-notification-lists.md).

When auto-compact does fire, usage drops and the latch silently rewinds with it, so the
thresholds re-arm and the next crossing is announced as usual.

### List format

Both files have the same shape:

```json
{
  "version": 1,
  "notifications": [
    { "used_percent": 20, "message": "context {used_percent}% used ({used_tokens} / {window_tokens} tokens)." },
    { "used_percent": 90, "message": "context {used_percent}% used, {available_tokens} tokens left. Wrap up and write the handoff." }
  ]
}
```

- `version` — the schema version these files are written against. `check` says so when it
  does not match the current one; nothing is migrated or overwritten for you.
- `notifications[].used_percent` — the threshold, in percent. Any number of entries, in
  ascending order. Several entries may share a `used_percent`; their messages are joined with
  newlines and delivered as the single notice for that crossing.
- `notifications[].message` — what the session is told. `{used_tokens}` (tokens used),
  `{used_percent}` (usage percent), `{available_tokens}` (tokens left),
  `{available_percent}` (percent left) and `{window_tokens}` (window size) are substituted.
  A misspelled placeholder is left as literal text rather than breaking the session.

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
| `Stop`, `PostToolUse` | `measure` | Reads usage, moves the latch, and speaks on the spot when the latch just moved up into a band. |

Usage is the sum of `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` on
the newest non-sidechain assistant line of the transcript — the prompt length of the last
main-thread request. Measuring on both events covers the transcript's asynchronous writes,
which sometimes leave `Stop` reading a turn that isn't there yet.

Speaking from `Stop` wakes one continuation turn, but the prefix it reads is already in the
prompt cache, so the crossing costs a cache read plus a few dozen written tokens. That is
cheap enough that there is no reason to hold a message back for a turn that was going to
happen anyway.

The latch is a single band in `$XDG_STATE_HOME/claude-context-notify/<session_id>.json`.
It speaks when usage rises past a band and silently rewinds when usage falls, so a `/compact`
or `/clear` re-arms the thresholds without emitting a pointless "you went down" notice.

Design rationale:
[DR-0001](./docs/decisions/DR-0001-hook-only-threshold-notification.md) (hook-only design) and
[DR-0002](./docs/decisions/DR-0002-autocompact-notification-lists.md) (the two notification lists).

## License

MIT
