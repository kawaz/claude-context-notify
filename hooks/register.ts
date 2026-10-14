// Tell the running session how much of its context window it has used, once
// per threshold crossed. Measures each response of the main loop and hands the
// notice to the model with its next request; the decisions themselves are in
// notify.ts.

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
  const pending = 'pending' in raw && typeof raw.pending === 'string' ? raw.pending : undefined
  return pending === undefined ? { band, updatedAt } : { band, updatedAt, pending }
}

async function isAutoCompactEnabled($: $): Promise<boolean> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  // Without a breakdown there is nothing to go by; auto compact is Claude
  // Code's default, so the list written for it is the safer guess.
  return context.breakdown?.isAutoCompactEnabled ?? true
}

/**
 * Measure, move the latch, and keep the notice of a band just reached as
 * pending until a request carries it. A newer band's notice replaces an
 * undelivered one; a fall drops it with the band it was about.
 */
async function measure($: $): Promise<void> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const { tokens, window, percent } = context
  // Before the first response of a live window (a fresh session, one just
  // compacted) there is nothing to measure; leave the latch where it is.
  if (tokens === undefined || percent === undefined) return

  const name = listFor(context.breakdown?.isAutoCompactEnabled ?? true)
  const bands = resolveBands((await loadList($, name)).entries)
  if (bands.size === 0) return

  const key = latchKey(await $.session.id())
  const now = await $.clock.now()
  const held = await readLatch($, key)
  const step = advance(held?.band, { tokens, window, percent }, bands)
  if (step === undefined) {
    // Same band: the latch stands, but the sweep goes by `updatedAt`, so a
    // session that stays in one band must still be seen as alive.
    if (held !== undefined && needsTouch(held, now)) await $.store.set(key, { ...held, updatedAt: now })
    return
  }
  const next: LatchRecord =
    step.message === undefined ? { band: step.band, updatedAt: now } : { band: step.band, updatedAt: now, pending: step.message }
  await $.store.set(key, next)
}

/** The notice waiting for the model, taken off the latch so no other request carries it again. */
async function takePending($: $): Promise<string | undefined> {
  const key = latchKey(await $.session.id())
  const held = await readLatch($, key)
  if (held?.pending === undefined) return undefined
  await $.store.set(key, { band: held.band, updatedAt: held.updatedAt } satisfies LatchRecord)
  return PREFIX + held.pending
}

/** Put back a notice whose request did not go out, unless a newer measurement replaced it. */
async function returnPending($: $, notice: string): Promise<void> {
  const key = latchKey(await $.session.id())
  const held = await readLatch($, key)
  if (held === undefined || held.pending !== undefined) return
  await $.store.set(key, { ...held, pending: notice.slice(PREFIX.length) } satisfies LatchRecord)
}

// Measurements and deliveries happen concurrently (parallel tool calls finish
// together, a response is measured while its tools already run).
// They go one at a time so two of them never both read the same latch: no
// band is reached twice, no notice is handed out twice.
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

  // A failed measurement or delivery must not cost the event anything: each
  // hook below falls back to what the hooks beneath it answered (`next`
  // replays it).
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    // A subagent's request: its usage is not the main context's.
    if (e.agentId === undefined && r.usage !== null) await oneAtATime(() => measure($))
    return r
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // Design rationale: the notice is delivered through two doors that share
  // takePending. A request to the model either starts a turn or follows tool
  // results; the engine has no single door that adds context to every request.
  // prompt.attachment comes closest, but no attachment is raised on every
  // request, and what a hook writes into one is not kept in the transcript.
  on('prompt.submit', async ($, e, next) => {
    // A slash command may not reach the model; its notice waits for a prompt that does.
    if (e.command !== undefined) return next(e)
    const notice = await oneAtATime(() => takePending($))
    if (notice === undefined) return next(e)
    const r = await next({ ...e, context: [...(e.context ?? []), notice] })
    if (r.drop !== undefined) await oneAtATime(() => returnPending($, notice))
    return r
  }).catch(($, e, next) => next(e))

  // The notice rides on the tool's result as context: the model reads it as
  // one reminder after the result. A subagent's call is left alone (the
  // notice would reach the subagent), as is a refused or failed call, whose
  // result takes no context.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || r.deny !== undefined || r.isError === true) return r
    const notice = await oneAtATime(() => takePending($))
    return notice === undefined ? r : { ...r, context: [...(r.context ?? []), notice] }
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
