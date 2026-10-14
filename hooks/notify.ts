// What the hooks decide, kept free of `$` so tests drive it directly: reading
// the two notification lists, resolving their thresholds into bands, moving
// the latch, filling a message, and where the lists live.

export const LIST_VERSION = 1
export const LIST_NAMES = ['autocompact-on', 'autocompact-off'] as const
export type ListName = (typeof LIST_NAMES)[number]

export const PLACEHOLDERS = [
  'used_tokens',
  'used_percent',
  'available_tokens',
  'available_percent',
  'window_tokens',
] as const

/** One line of a notification list a hook can use. */
export type Entry = { usedPercent: number; message: string }

/** A notification list as read: what a hook can use, and what a person should fix. */
export type ListReading = { entries: Entry[]; problems: string[] }

/** The bands of a list: threshold to the message spoken on crossing it. */
export type Bands = ReadonlyMap<number, string>

/** The context window's fill, as `$.session.usage()` reports it once measured. */
export type Usage = { tokens: number; window: number; percent: number }

/** What a session keeps between measurements, under `latchKey(sessionId)` in `$.store`. */
export type LatchRecord = { band: number; updatedAt: number }

/** A latch no measurement has touched this long belongs to a session nobody will resume. */
export const LATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/**
 * How stale `updatedAt` may get before a measurement that leaves the band
 * alone still rewrites it. It keeps a live session's latch clear of the sweep
 * without writing the store on every tool call.
 */
export const LATCH_TOUCH_MS = 24 * 60 * 60 * 1000
export const LATCH_PREFIX = 'session:'
export const latchKey = (sessionId: string): string => `${LATCH_PREFIX}${sessionId}`

/** Which of the two lists a session uses. */
export function listFor(isAutoCompactEnabled: boolean): ListName {
  return isAutoCompactEnabled ? 'autocompact-on' : 'autocompact-off'
}

/**
 * Read a notification list from its file text.
 *
 * Both readers are served at once: `entries` is what a hook keeps using
 * whatever else is wrong (a stale `version`, a typo in one line), and
 * `problems` is what `check` reports. A broken list must not break the session,
 * so `entries` is never stricter than it has to be.
 *
 * Design rationale: the shape is checked by hand rather than through a schema
 * library. A hooks module imports only its own files and "claude-code"
 * (`claude plugin validate` refuses a package name), so a library would have
 * to be vendored into this repository: some 85 KB of third-party code, its
 * license and its updates, for the two small shapes this plugin reads (this
 * list and `LatchRecord`). The checks live in this one function and in
 * `readLatch`, the two places outside data enters.
 */
export function readList(text: string, name: ListName): ListReading {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { entries: [], problems: [`JSON として読めません (${e instanceof Error ? e.message : 'parse error'})`] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { entries: [], problems: ['ファイル全体を JSON オブジェクトにしてください'] }
  }

  const problems: string[] = []
  const version = 'version' in raw ? raw.version : undefined
  if (version !== LIST_VERSION) {
    problems.push(
      `version が古い (ファイル: ${version === undefined ? 'なし' : JSON.stringify(version)} / 現在: ${LIST_VERSION})。` +
        `テンプレ templates/${name}.json を参考に書き直してください`,
    )
  }

  const found = 'notifications' in raw ? raw.notifications : undefined
  if (!Array.isArray(found) || found.length === 0) {
    return { entries: [], problems: [...problems, 'notifications は 1 件以上の配列にしてください'] }
  }
  // Array.isArray narrows to any[]; give the elements back their unknown type.
  const items: readonly unknown[] = found

  const entries: Entry[] = []
  for (const [i, item] of items.entries()) {
    const where = `notifications[${i}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`${where}: オブジェクトにしてください`)
      continue
    }
    const at = 'used_percent' in item ? item.used_percent : undefined
    const message = 'message' in item ? item.message : undefined

    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at > 100) {
      problems.push(
        `${where}.used_percent は 0〜100 の整数にしてください (現在: ${at === undefined ? 'なし' : JSON.stringify(at)})`,
      )
    }
    if (typeof message !== 'string' || message.trim() === '') {
      problems.push(`${where}.message は空でない文字列にしてください`)
    } else {
      for (const field of placeholderNames(message)) {
        if (!isPlaceholder(field)) {
          problems.push(
            `${where}.message: 未知のプレースホルダ {${field}} ` +
              `(使えるのは ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`,
          )
        }
      }
    }

    // A hook takes any whole-number threshold in range, even one `check`
    // would flag for its spelling ("50", 50.0).
    const usable = typeof at === 'string' && /^\s*\d+\s*$/.test(at) ? Number(at) : at
    if (typeof usable === 'number' && Number.isInteger(usable) && usable >= 0 && usable <= 100 && typeof message === 'string') {
      entries.push({ usedPercent: usable, message })
    }
  }
  return { entries, problems }
}

function isPlaceholder(name: string): boolean {
  return PLACEHOLDERS.some((p) => p === name)
}

/**
 * Turn list entries into bands.
 *
 * Several entries may share a threshold; their messages join with newlines in
 * the order they are written, so crossing the band still speaks exactly once.
 */
export function resolveBands(entries: readonly Entry[]): Bands {
  const bands = new Map<number, string>()
  for (const { usedPercent, message } of entries) {
    const held = bands.get(usedPercent)
    bands.set(usedPercent, held === undefined ? message : `${held}\n${message}`)
  }
  return bands
}

/** The highest threshold at or below `percent`, or 0 when none is. */
export function bandOf(percent: number, bands: Bands): number {
  let hit = 0
  for (const at of bands.keys()) {
    if (percent >= at && at > hit) hit = at
  }
  return hit
}

/** Where the latch goes after a measurement, and what to say about it. */
export type Step = { band: number; message?: string }

/**
 * Move the latch to match `usage`. Returns undefined when it stays put.
 *
 * No latch yet means nothing has been measured in this session, which is what
 * makes a 0 band reachable: it is crossed by the first measurement. Going down
 * means a compact or a clear reset the usage, so the latch moves back without
 * a word. Going up into a band speaks that band, unless `maySpeak` is false (a
 * continuation turn the plugin's own notice caused, where speaking would loop).
 */
export function advance(prev: number | undefined, usage: Usage, bands: Bands, maySpeak: boolean): Step | undefined {
  const from = prev ?? -1
  const band = bandOf(usage.percent, bands)
  if (band === from) return undefined
  const template = bands.get(band)
  if (!maySpeak || band < from || template === undefined) return { band }
  return { band, message: render(template, usage) }
}

const FIELD = /\{\{|\}\}|\{([^{}]*)\}/g

/** The field names in a message, as `{name}` spells them (`{{` and `}}` are literal braces). */
export function placeholderNames(template: string): string[] {
  const names: string[] = []
  for (const m of template.matchAll(FIELD)) {
    const name = m[1]
    if (name !== undefined && name !== '') names.push(name)
  }
  return names
}

/**
 * Fill a band message. A typo in the list must not break the session, so an
 * unknown placeholder stays as literal text.
 *
 * `available_percent` is derived from the rounded `used_percent` so the two
 * always add up to 100 in the same sentence.
 */
export function render(template: string, usage: Usage): string {
  const values: Readonly<Record<string, string>> = {
    used_tokens: grouped(usage.tokens),
    used_percent: String(usage.percent),
    available_tokens: grouped(usage.window - usage.tokens),
    available_percent: String(100 - usage.percent),
    window_tokens: grouped(usage.window),
  }
  return template.replace(FIELD, (whole, name: string | undefined) => {
    if (whole === '{{') return '{'
    if (whole === '}}') return '}'
    return (name !== undefined && Object.hasOwn(values, name) ? values[name] : undefined) ?? whole
  })
}

/** `1234567` as `1,234,567`. */
export function grouped(n: number): string {
  const sign = n < 0 ? '-' : ''
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The environment that decides where plugin data lives outside a marketplace install. */
export type PluginsHome = { cacheDir?: string; configDir?: string; home?: string }

/**
 * The plugin data dir, where the user's lists live and survive plugin updates.
 *
 * An installed plugin runs from `<plugins>/cache/<marketplace>/<plugin>/<version>`
 * and its data dir is `<plugins>/data/<plugin>-<marketplace>`, the directory
 * Claude Code hands command hooks as CLAUDE_PLUGIN_DATA. A plugin loaded with
 * `--plugin-dir` has no marketplace, so its data goes under
 * `<plugins>/data/<plugin>-inline`, `<plugins>` resolved as Claude Code does.
 * Undefined when not even HOME is known: the bundled templates are used as is.
 */
export function dataDir(root: string, plugin: string, env: PluginsHome): string | undefined {
  const installed = /^(.*)\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(root)
  if (installed !== null) {
    const [, plugins, marketplace, name] = installed
    if (plugins !== undefined && marketplace !== undefined && name !== undefined) {
      return `${plugins}/data/${name}-${marketplace}`
    }
  }
  const plugins =
    env.cacheDir ??
    (env.configDir !== undefined ? `${env.configDir}/plugins` : undefined) ??
    (env.home !== undefined ? `${env.home}/.claude/plugins` : undefined)
  return plugins === undefined ? undefined : `${plugins}/data/${plugin}-inline`
}

/** Whether a latch was last moved long enough ago to be swept. */
export function isStale(record: LatchRecord, now: number): boolean {
  return now - record.updatedAt > LATCH_TTL_MS
}

/** Whether a measurement that leaves the band alone should still record that the session is alive. */
export function needsTouch(record: LatchRecord, now: number): boolean {
  return now - record.updatedAt >= LATCH_TOUCH_MS
}

/** `check`'s verdict over both lists: one line when they are fine. */
export function verdict(problems: ReadonlyArray<{ name: ListName; problems: readonly string[] }>): {
  ok: boolean
  text: string
} {
  const lines = problems.flatMap(({ name, problems: ps }) => ps.map((p) => `  - ${name}: ${p}`))
  if (lines.length === 0) return { ok: true, text: '設定は妥当です。' }
  return { ok: false, text: ['設定に問題があります:', ...lines].join('\n') }
}

/** One list file as a session finds it: where it is read from, whether this call created it, and its text. */
export type ListFile = { name: ListName; path: string; isCreated: boolean; text: string }

/**
 * What `/context-notify:config` embeds and what the check tool answers, from
 * the same lists: both paths, whether auto compact is on, the list this
 * session uses, and the verdict over both. With `withContents`, the used
 * list's text follows verbatim: whoever reads it next edits the text they saw.
 */
export function report(lists: readonly ListFile[], isAutoCompactEnabled: boolean, withContents: boolean): {
  ok: boolean
  text: string
} {
  const chosen = listFor(isAutoCompactEnabled)
  const { ok, text } = verdict(lists.map(({ name, text: body }) => ({ name, problems: readList(body, name).problems })))
  const lines = [
    ...lists.map(({ name, path, isCreated }) => `${name}: ${path}${isCreated ? '  (テンプレから作成しました)' : ''}`),
    isAutoCompactEnabled ? 'auto compact: 有効 (発火点は Claude Code 側の window 設定で決まる)' : 'auto compact: 無効',
    `このセッションが使うのは: ${chosen}`,
    '',
    text,
  ]
  const used = lists.find(({ name }) => name === chosen)
  if (withContents && used !== undefined) {
    const body = used.text.replace(/\n+$/, '')
    lines.push('', `--- ${chosen} (${used.path})`, body === '' ? '(読めません)' : body)
  }
  return { ok, text: lines.join('\n') }
}
