// The hooks in hooks/register.ts, run by the engine. Beneath the plugin the
// test answers what a session would: the files (in memory), the store, the
// clock, the environment and `$.session.usage()`.

import type { On, PromptSubmitCommand, PromptSubmitResult, SessionContextBreakdown, ToolCallResult } from 'claude-code'
import { describe, type Engine, expect, type MockClock, mock, test } from 'claude-code/testing'

const CONFIG_DIR = '/cfg'
const DATA = `${CONFIG_DIR}/plugins/data/context-notify-inline`
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

const list = (...lines: Array<[number, string]>): string =>
  JSON.stringify({ version: 1, notifications: lines.map(([at, message]) => ({ used_percent: at, message })) })

const ON_LIST = list([20, 'ON {used_percent}%'], [60, 'ON {used_percent}% ({used_tokens} / {window_tokens} tokens)'])
const OFF_LIST = list([20, 'OFF {used_percent}%'], [60, 'OFF {used_percent}%'])

type World = {
  clock: MockClock
  sessionId: string
  outcome: ToolCallResult
  /** A prompt with this text is dropped beneath the plugin, as a settings hook's block would. */
  blocked?: string
  files: Map<string, string>
  usage: { tokens?: number; window: number; percent?: number; autoCompact?: boolean; fails?: boolean }
}

function breakdown(isAutoCompactEnabled: boolean): SessionContextBreakdown {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 50_000,
    rawMaxTokens: 50_000,
    autocompactSource: 'model-default',
    percentage: 0,
    gridRows: [],
    model: 'test',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled,
    apiUsage: null,
  }
}

/** What lies beneath the plugin. Templates are served from the plugin's own folder, as fixtures. */
function world(on: On, store: Readonly<Record<string, unknown>> = {}, files: Record<string, string> = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: NOW }),
    sessionId: 's1',
    outcome: { result: 'ran', context: ['FROM BELOW'] },
    files: new Map(Object.entries(files)),
    usage: { tokens: 33_000, window: 50_000, percent: 66, autoCompact: true },
  }
  mock.store(on, store)
  mock.env(on, { CLAUDE_CONFIG_DIR: CONFIG_DIR, HOME: '/home/u' })
  const template = (path: string): string | undefined =>
    path.endsWith('/templates/autocompact-on.json') ? ON_LIST : path.endsWith('/templates/autocompact-off.json') ? OFF_LIST : undefined
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path) ?? template(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) || template(e.path) !== undefined }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.usage', ($, e) => {
    const { tokens, window, percent, autoCompact, fails } = w.usage
    if (fails === true) return { deny: 'usage unavailable' }
    const withBreakdown = e.breakdown !== undefined && autoCompact !== undefined
    return {
      value: {
        startedAt: 0,
        rateLimits: [],
        context: { tokens, window, percent, ...(withBreakdown ? { breakdown: breakdown(autoCompact) } : {}) },
      },
    }
  })
  on('session.id', () => ({ value: w.sessionId }))
  on('tool.call', () => w.outcome)
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'test' },
    }
  })
  on('prompt.submit', ($, e) =>
    e.text === w.blocked ? { drop: 'blocked beneath' } : { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) },
  )
  return w
}

const BASH = { tool: 'Bash', command: 'true' } as const
const STEP = { turnId: 't1', index: 0, model: 'test', messageCount: 1 }

/** One main-loop response, read to its end: what the plugin measures. */
async function respond($: Engine, agentId?: string): Promise<void> {
  const stream = $.turn.step(agentId === undefined ? STEP : { ...STEP, agentId })
  for await (const _chunk of stream) {
    // The fixture streams no chunks; the result is what is measured.
  }
}

/** A prompt from the person: what reaches the model beside it. */
async function submit($: Engine, text: string, command?: PromptSubmitCommand): Promise<PromptSubmitResult> {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...(command === undefined ? {} : { command }) })
}

/** A response, then a tool call it asked for: what the tool's result carries. */
async function respondThenCall($: Engine): Promise<readonly string[] | undefined> {
  await respond($)
  return (await $.tool.call(BASH)).context
}

describe('measuring each response, delivering with the next request', () => {
  test('a crossing is delivered with the tool result that follows, after what the hooks beneath said', async ($, on) => {
    world(on)
    expect(await respondThenCall($)).toEqual(['FROM BELOW', '[context-notify] ON 66% (33000 / 50000 tokens)'])
  })

  test('a crossing in a response without tools is delivered with the next prompt', async ($, on) => {
    world(on)
    await respond($)
    expect((await submit($, 'next')).context).toEqual(['[context-notify] ON 66% (33000 / 50000 tokens)'])
  })

  test('a notice is delivered once, through whichever door comes first', async ($, on) => {
    world(on)
    await respond($)
    expect((await submit($, 'next')).context?.length).toBe(1)
    expect((await $.tool.call(BASH)).context).toEqual(['FROM BELOW'])
    expect((await submit($, 'again')).context).toBeUndefined()
  })

  test('nothing is delivered before a response is measured', async ($, on) => {
    world(on)
    expect((await $.tool.call(BASH)).context).toEqual(['FROM BELOW'])
    expect((await submit($, 'first')).context).toBeUndefined()
  })

  test('the same band again is silent', async ($, on) => {
    world(on)
    await respondThenCall($)
    expect(await respondThenCall($)).toEqual(['FROM BELOW'])
  })

  test('the latch is kept per session in the store and read back', async ($, on) => {
    world(on, { 'session:s1': { band: 60, updatedAt: NOW } })
    expect(await respondThenCall($)).toEqual(['FROM BELOW'])
  })

  test('a pending notice survives in the store until a request carries it', async ($, on) => {
    world(on, { 'session:s1': { band: 60, updatedAt: NOW, pending: 'LEFT OVER' } })
    expect((await submit($, 'resumed')).context).toEqual(['[context-notify] LEFT OVER'])
  })

  test('a fall then a rise speaks again; a fall drops an undelivered notice', async ($, on) => {
    const w = world(on)
    await respond($)
    w.usage = { ...w.usage, tokens: 5_000, percent: 10 }
    await respond($)
    expect((await submit($, 'after compact')).context).toBeUndefined()
    w.usage = { ...w.usage, tokens: 33_000, percent: 66 }
    expect(await respondThenCall($)).toEqual(['FROM BELOW', '[context-notify] ON 66% (33000 / 50000 tokens)'])
  })

  test('a newer band replaces an undelivered notice', async ($, on) => {
    const w = world(on)
    w.usage = { ...w.usage, tokens: 15_000, percent: 30 }
    await respond($)
    w.usage = { ...w.usage, tokens: 33_000, percent: 66 }
    await respond($)
    expect((await submit($, 'next')).context).toEqual(['[context-notify] ON 66% (33000 / 50000 tokens)'])
  })

  test("a subagent's response is not measured and its tool calls carry nothing", async ($, on) => {
    world(on)
    await respond($, 'agent-1')
    expect((await submit($, 'next')).context).toBeUndefined()
    await respond($)
    const inSubagent = { ...BASH, agentId: 'agent-1' }
    expect((await $.tool.call(inSubagent)).context).toEqual(['FROM BELOW'])
    expect((await $.tool.call(BASH)).context?.length).toBe(2)
  })

  test('a refused or failed call carries nothing and leaves the notice pending', async ($, on) => {
    const w = world(on)
    await respond($)
    w.outcome = { deny: 'no' }
    expect(await $.tool.call(BASH)).toEqual({ deny: 'no' })
    w.outcome = { result: 'boom', isError: true }
    expect((await $.tool.call(BASH)).context).toBeUndefined()
    w.outcome = { result: 'ran' }
    expect((await $.tool.call(BASH)).context).toEqual(['[context-notify] ON 66% (33000 / 50000 tokens)'])
  })

  test('a slash command does not take the notice', async ($, on) => {
    world(on)
    await respond($)
    expect((await submit($, '/cost', { name: 'cost', args: '' })).context).toBeUndefined()
    expect((await submit($, 'next')).context?.length).toBe(1)
  })

  test('a dropped prompt gives the notice back', async ($, on) => {
    const w = world(on)
    w.blocked = 'blocked'
    await respond($)
    expect(await submit($, 'blocked')).toEqual({ drop: 'blocked beneath' })
    expect((await submit($, 'next')).context?.length).toBe(1)
  })

  test('nothing to measure yet leaves the latch where it is', async ($, on) => {
    const w = world(on)
    w.usage = { window: 50_000, autoCompact: true }
    expect(await respondThenCall($)).toEqual(['FROM BELOW'])
    w.usage = { tokens: 33_000, window: 50_000, percent: 66, autoCompact: true }
    expect((await respondThenCall($))?.length).toBe(2)
  })

  test('a failed measurement passes the response and the call through untouched', async ($, on) => {
    const w = world(on)
    w.usage = { ...w.usage, fails: true }
    expect(await respondThenCall($)).toEqual(['FROM BELOW'])
  })

  test('parallel tool calls deliver a notice once', async ($, on) => {
    world(on)
    await respond($)
    const rs = await Promise.all([$.tool.call(BASH), $.tool.call(BASH), $.tool.call(BASH)])
    expect(rs.map((r) => r.context?.length).sort()).toEqual([1, 1, 2])
  })
})

describe('which list, and where it lives', () => {
  test('auto compact off reads the off list', async ($, on) => {
    const w = world(on)
    w.usage = { ...w.usage, autoCompact: false }
    expect((await respondThenCall($))?.[1]).toBe('[context-notify] OFF 66%')
  })

  test('no breakdown reads the on list', async ($, on) => {
    const w = world(on)
    w.usage = { tokens: 33_000, window: 50_000, percent: 66 }
    expect((await respondThenCall($))?.[1]).toContain('ON 66%')
  })

  test("the user's list in the data dir wins over the template", async ($, on) => {
    world(on, {}, { [`${DATA}/autocompact-on.json`]: list([50, 'MINE {used_percent}%']) })
    expect((await respondThenCall($))?.[1]).toBe('[context-notify] MINE 66%')
  })

  test('a list with no usable line falls back to the template', async ($, on) => {
    world(on, {}, { [`${DATA}/autocompact-on.json`]: 'not json' })
    expect((await respondThenCall($))?.[1]).toContain('ON 66%')
  })
})

describe('session.start', () => {
  test('lays down both lists from the templates, leaving an existing one alone', async ($, on) => {
    on('tool.register', () => ({ value: { tool: 'mcp__context-notify__check' } }))
    on('session.start', () => ({ cwd: '/w' }))
    const w = world(on, {}, { [`${DATA}/autocompact-on.json`]: 'MINE' })
    await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
    expect(w.files.get(`${DATA}/autocompact-on.json`)).toBe('MINE')
    expect(w.files.get(`${DATA}/autocompact-off.json`)).toBe(OFF_LIST)
  })

  test("sweeps latches older than 30 days and keeps the rest and other keys", async ($, on) => {
    on('tool.register', () => ({ value: { tool: 'mcp__context-notify__check' } }))
    on('session.start', () => ({ cwd: '/w' }))
    const w = world(on, {
      'session:old': { band: 20, updatedAt: NOW - 31 * DAY },
      'session:fresh': { band: 60, updatedAt: NOW - DAY },
      'session:junk': 'x',
      other: 1,
    })
    await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
    // The fresh latch is still there: that session stays silent in its band.
    w.sessionId = 'fresh'
    expect((await respondThenCall($))).toEqual(['FROM BELOW'])
    // The old one is gone: the same usage speaks again.
    w.sessionId = 'old'
    expect((await respondThenCall($))?.length).toBe(2)
  })
})

describe('a session that stays in one band', () => {
  test('keeps its latch through the sweep as long as it is measured', async ($, on) => {
    on('tool.register', () => ({ value: { tool: 'mcp__context-notify__check' } }))
    on('session.start', () => ({ cwd: '/w' }))
    const w = world(on)
    expect((await respondThenCall($))?.length).toBe(2)
    // 20 days in the same band, measured now and then; then 20 more days, so
    // the band last changed 40 days ago but the session was last seen 20 ago.
    await w.clock.advance(20 * DAY)
    expect((await respondThenCall($))).toEqual(['FROM BELOW'])
    await w.clock.advance(20 * DAY)
    await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
    expect((await respondThenCall($))).toEqual(['FROM BELOW'])
  })

  test('an unmeasured latch past the TTL is still swept', async ($, on) => {
    on('tool.register', () => ({ value: { tool: 'mcp__context-notify__check' } }))
    on('session.start', () => ({ cwd: '/w' }))
    const w = world(on)
    await respondThenCall($)
    await w.clock.advance(31 * DAY)
    await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
    expect((await respondThenCall($))?.length).toBe(2)
  })
})

describe('/context-notify:config and its check tool', () => {
  test('the command prompt carries the paths, the chosen list verbatim and the verdict', async ($, on) => {
    on('skill.prompt', () => ({ text: 'STEPS' }))
    world(on)
    const r = await $.skill.prompt({ skill: 'context-notify:config', text: 'STEPS' })
    expect(r.text).toContain('STEPS\n\n<context-notify-report>\n')
    expect(r.text).toContain(`autocompact-on: ${DATA}/autocompact-on.json  (テンプレから作成しました)`)
    expect(r.text).toContain('このセッションが使うのは: autocompact-on')
    expect(r.text).toContain(`--- autocompact-on (${DATA}/autocompact-on.json)\n${ON_LIST}`)
    expect(r.text).toContain('設定は妥当です。')
  })

  test('another skill is left alone', async ($, on) => {
    on('skill.prompt', () => ({ text: 'OTHER' }))
    world(on)
    expect((await $.skill.prompt({ skill: 'commit', text: 'OTHER' })).text).toBe('OTHER')
  })

  test('check reports problems in either list', async ($, on) => {
    world(on, {}, { [`${DATA}/autocompact-off.json`]: list([50, '{pcnt}']) })
    const r = await $.tool.call({ tool: 'mcp__context-notify__check' })
    expect(r.result).toBeDefined()
    expect(JSON.stringify(r.result)).toContain('autocompact-off: notifications[0].message: 未知のプレースホルダ {pcnt}')
  })
})
