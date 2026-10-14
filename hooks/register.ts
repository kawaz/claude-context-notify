// Tell the running session how much of its context window it has used, once
// per threshold crossed. Measures at PostToolUse and Stop; the decisions
// themselves are in notify.ts.

import type { EngineInterface, Register } from 'claude-code'
import {
  LATCH_PREFIX,
  LIST_NAMES,
  type LatchRecord,
  type ListFile,
  type ListName,
  type ListReading,
  advance,
  dataDir,
  isStale,
  latchKey,
  listFor,
  needsTouch,
  readList,
  report,
  resolveBands,
} from './notify'

const PREFIX = '[context-notify] '
const CONFIG_SKILL = 'context-notify:config'
const CHECK_TOOL = 'check'

type $ = EngineInterface

/** A list's file before it is read. */
type Located = Omit<ListFile, 'text'>

async function home($: $): Promise<string | undefined> {
  return dataDir($.plugin.root, $.plugin.name, {
    cacheDir: await $.env.get('CLAUDE_CODE_PLUGIN_CACHE_DIR'),
    configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
    home: await $.env.get('HOME'),
  })
}

const templatePath = ($: $, name: ListName): string => `${$.plugin.root}/templates/${name}.json`

/**
 * The user's copy of a list, created from the bundled template when absent.
 *
 * An existing file is never touched. When the data dir cannot be written, the
 * bundled template is read instead so the session keeps working.
 */
async function ensureList($: $, dir: string | undefined, name: ListName): Promise<Located> {
  const bundled = { name, path: templatePath($, name), isCreated: false }
  if (dir === undefined) return bundled
  const path = `${dir}/${name}.json`
  try {
    if (await $.fs.exists(path)) return { name, path, isCreated: false }
    await $.fs.write(path, await $.fs.read(bundled.path))
    return { name, path, isCreated: true }
  } catch {
    return bundled
  }
}

async function ensureLists($: $): Promise<Located[]> {
  const dir = await home($)
  return Promise.all(LIST_NAMES.map((name) => ensureList($, dir, name)))
}

async function readText($: $, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

/** The list a hook goes by: the user's, or the bundled template when the user's has no usable line. */
async function loadList($: $, name: ListName): Promise<ListReading> {
  const dir = await home($)
  const own = dir === undefined ? undefined : readList(await readText($, `${dir}/${name}.json`), name)
  if (own !== undefined && own.entries.length > 0) return own
  return readList(await readText($, templatePath($, name)), name)
}

/**
 * The latch this session last left, or undefined before its first measurement.
 *
 * The store is outside data (another version of this plugin, a hand edit), so
 * this is a parse boundary: anything not shaped as a LatchRecord reads as no
 * latch.
 *
 * Design rationale: checked by hand rather than through a schema library. A
 * hooks module imports only its own files and "claude-code", so a library
 * would have to be vendored: third-party code, its license and its updates,
 * for the two small shapes this plugin parses (this one and readList's).
 */
async function readLatch($: $, key: string): Promise<LatchRecord | undefined> {
  const raw = await $.store.get(key)
  if (typeof raw !== 'object' || raw === null || !('band' in raw) || !('updatedAt' in raw)) return undefined
  const { band, updatedAt } = raw
  if (typeof band !== 'number' || typeof updatedAt !== 'number') return undefined
  return { band, updatedAt }
}

async function isAutoCompactEnabled($: $): Promise<boolean> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  // Without a breakdown there is nothing to go by; auto compact is Claude
  // Code's default, so the list written for it is the safer guess.
  return context.breakdown?.isAutoCompactEnabled ?? true
}

/**
 * Measure, move the latch, and return what to say, if anything.
 *
 * `maySpeak` is false on a Stop that the plugin's own notice caused: measuring
 * again is fine, speaking again would loop.
 */
async function measure($: $, sessionId: string, maySpeak: boolean): Promise<string | undefined> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const { tokens, window, percent } = context
  // Before the first response of a live window (a fresh session, one just
  // compacted) there is nothing to measure; leave the latch where it is.
  if (tokens === undefined || percent === undefined) return undefined

  const name = listFor(context.breakdown?.isAutoCompactEnabled ?? true)
  const bands = resolveBands((await loadList($, name)).entries)
  if (bands.size === 0) return undefined

  const key = latchKey(sessionId)
  const now = await $.clock.now()
  const held = await readLatch($, key)
  const step = advance(held?.band, { tokens, window, percent }, bands, maySpeak)
  if (step === undefined) {
    // Same band: the latch stands, but the sweep goes by `updatedAt`, so a
    // session that stays in one band must still be seen as alive.
    if (held !== undefined && needsTouch(held, now)) await $.store.set(key, { ...held, updatedAt: now })
    return undefined
  }
  await $.store.set(key, { band: step.band, updatedAt: now } satisfies LatchRecord)
  return step.message
}

// PostToolUse fires per tool and may run concurrently for parallel tool calls.
// Measurements go one at a time so two of them never both read the old latch
// and both speak the same band.
let queue: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Remove the latches of sessions no measurement has touched for LATCH_TTL_MS. */
async function sweepLatches($: $): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(LATCH_PREFIX)) continue
    const latch = await readLatch($, key)
    if (latch === undefined || isStale(latch, now)) await $.store.delete(key)
  }
}

/** Both lists as they stand now, created from the templates where absent. */
async function listFiles($: $): Promise<ListFile[]> {
  return Promise.all((await ensureLists($)).map(async (l) => ({ ...l, text: await readText($, l.path) })))
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool
      .register({
        name: CHECK_TOOL,
        description:
          'Validate both context-notify notification lists. Returns their paths, which one this session uses, and every problem found (or that both are valid). Takes no input.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
      .catch(() => undefined)
    // Both lists are laid down even though only one is read, so the user finds
    // the other one waiting to be edited before a session of that kind starts.
    await ensureLists($).catch(() => undefined)
    await sweepLatches($).catch(() => undefined)
    return started
  })

  // A failed measurement must not cost the event anything: each hook below
  // falls back to what the hooks beneath it answered (`next` replays it).
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    // A subagent's tool call: the usage is the main thread's, and a notice
    // here would reach the subagent instead of the session it belongs to.
    if (e.agent_id !== undefined) return r
    const notice = await oneAtATime(() => measure($, e.session_id, true))
    return notice === undefined ? r : { ...r, additionalContext: [...(r.additionalContext ?? []), PREFIX + notice] }
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id !== undefined) return r
    const notice = await oneAtATime(() => measure($, e.session_id, !e.stop_hook_active))
    return notice === undefined ? r : { ...r, additionalContext: [...(r.additionalContext ?? []), PREFIX + notice] }
  }).catch(($, e, next) => next(e))

  // /context-notify:config reads the lists' report at the moment it is invoked.
  on('skill.prompt', { skill: CONFIG_SKILL }, async ($, e, next) => {
    const r = await next(e)
    const { text } = report(await listFiles($), await isAutoCompactEnabled($), true)
    return { text: `${r.text}\n\n<context-notify-report>\n${text}\n</context-notify-report>\n` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__context-notify__check' }, async ($) => {
    const { ok, text } = report(await listFiles($), await isAutoCompactEnabled($), false)
    return { result: ok ? text : `${text}\n\n直して、問題が無くなるまで check を繰り返してください。` }
  }).catch(() => ({ result: 'context-notify: 検証そのものに失敗しました (claude --debug の log を参照)' }))
}
