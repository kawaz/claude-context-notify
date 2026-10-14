# claude-context-notify

> English | [日本語](./README-ja.md)

A Claude Code plugin that tells the running session how much of its context window it has used — once per threshold crossed (20 / 40 / 60 / 80 / 90 / 95 / 97% by default).

Built on Claude Code's Mods (a TypeScript hooks module) alone. No proxy, no status line, no external service, no external command.

## What it solves

A long-running session has no idea how much room it has left. It keeps starting large investigations at 94% and gets cut off mid-handoff. Claude Code has the numbers, but nothing puts them in front of the model.

This plugin measures usage after every response of the main conversation and, when a threshold is crossed, adds a row to the conversation that the model reads with its next request (the next tool result, or your next prompt) and that you do not see:

```
[context-notify] Main context usage: 60% (36242 / 60000 tokens)
```

## Requirements

- A Claude Code with Mods.
- On a machine whose Claude Code is managed by an organization (managed settings), Claude Code does not run this plugin's `skill.prompt` hook when you installed the plugin yourself, so `/context-notify:config` gets no report embedded. The notifications and the check tool still work. For the full plugin there, the organization has to list it in its managed settings.

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

Everything you can configure lives in two files in the plugin data directory, so it survives plugin updates: `autocompact-on.json` and `autocompact-off.json`, under `<plugins dir>/data/context-notify-context-notify/` (`<plugins dir>` is normally `~/.claude/plugins`, or `plugins` under `CLAUDE_CONFIG_DIR` when you set it). One command reaches them.

| Command | What it does |
|---|---|
| `/context-notify:config [request]` | Copies the bundled templates on first run, then shows you both paths and the file this session reads, in your language, and offers to edit (or translate the default wording) on request. Given a request, rewrites the lists to match it, validates them, and reports the diff |

Read them, or ask in words:

```bash
/context-notify:config                        # paths and contents, nothing changed
/context-notify:config make the 90% message shorter
/context-notify:config add a 70 threshold and drop 95 and 97
```

After editing, a tool the plugin adds (`mcp__context-notify__check`) verifies both files — the JSON, the schema version, the thresholds (integers 0–100), the presence of messages, and the spelling of every placeholder.

### Adapting to auto-compact

When auto-compact is on, the high bands should be telling you to write a handoff before the conversation is summarised away; when it is off, that wording is just misleading. So on every measurement the plugin asks Claude Code itself whether auto-compact is enabled (the same answer `/context` breaks down) and reads the list that matches.

| Answer | List read |
|---|---|
| Enabled | `autocompact-on.json` (wording that assumes a compaction is coming) |
| Disabled | `autocompact-off.json` |

Without an answer, auto-compact is taken as enabled. To get the same notifications either way, give both files the same contents.

**The plugin does not work out where auto-compact fires.** That point is set by Claude Code's own window setting, so if you want a band just before it, put that percent in `used_percent` yourself.

When auto-compact does fire, usage drops and the latch silently rewinds with it, so the thresholds re-arm and the next crossing is announced as usual.

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

- `version` — the schema version these files are written against. The check says so when it does not match the current one; nothing is migrated or overwritten for you.
- `notifications[].used_percent` — the threshold, in percent (integers 0–100). Any number of entries, in any order (entries are grouped by value; within a value, file order is kept). An entry at `0` is delivered once, on the session's first measurement. Several entries may share a `used_percent`; their messages are joined with newlines and delivered as the single notice for that crossing.
- `notifications[].message` — what the session is told. `{used_tokens}` (tokens used), `{used_percent}` (usage percent), `{available_tokens}` (tokens left), `{available_percent}` (percent left) and `{window_tokens}` (window size) are substituted. Only the `{name}` form is a placeholder; any other brace is left as it is. A misspelled placeholder is left as literal text rather than breaking the session.

When a file cannot be read, or has no usable entry, the bundled template is used.

## How it works

| Hook | What it does |
|---|---|
| `turn.step` (after each response) | Measures usage, moves the latch, and, when the latch just moved up into a band, appends that band's notice to the conversation. |
| `session.start` | Creates the two files from the templates when absent, sweeps old latches, and registers the check tool. |
| When `/context-notify:config` expands | Embeds both paths, the list in use, the check's verdict and that list's contents in the command's prompt. |

Usage and window are the figures Claude Code shows in its status line (`$.session.usage()`'s `context.tokens` / `window` / `percent`): the input side of the last response (uncached + cache written + cache read) over the model's window. The window is Claude Code's own, so a `[1m]` model is measured correctly, after `/clear` too.

A subagent's responses are not measured: the usage is the main context's, and the notice goes to the main conversation only.

The notice is a row in the conversation, so it never wakes an extra turn; the model reads it with whatever request comes next. A crossing in a response that calls no tool is read at the start of the next turn. When another plugin refuses the row, the latch stays where it was and the next response tries again.

The latch is a single band per session in the plugin's own store. It speaks when usage rises past a band and silently rewinds when usage falls, so a `/compact` or `/clear` re-arms the thresholds without emitting a pointless "you went down" notice. A resumed session keeps its latch, so it does not repeat a notice it already gave. A session's latch is removed after 30 days without a measurement (a session that stays in one band still records that it was measured, once a day).

Design rationale: [DR-0003](./docs/decisions/DR-0003-mods-implementation.md).

## Development

```bash
just lint   # claude plugin validate, tsc, JSON, command frontmatter
just test   # claude plugin test (tests/*.test.ts)
```

The type definitions are written by Claude Code into `.claude-plugin/types/` (not tracked) when it loads the mod. If they are missing, start `claude --plugin-dir .` interactively once and they are written.

## License

MIT
