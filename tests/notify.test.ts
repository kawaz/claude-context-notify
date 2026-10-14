// The decisions in hooks/notify.ts, driven directly. The wording of
// templates/*.json is the user's to change, so every list here is a fixture.

import { describe, expect, test } from 'claude-code/testing'
import {
  type Usage,
  advance,
  bandOf,
  dataDir,
  isStale,
  LATCH_TOUCH_MS,
  LATCH_TTL_MS,
  needsTouch,
  listFor,
  placeholderNames,
  readList,
  render,
  report,
  resolveBands,
  verdict,
} from '../hooks/notify'

const usage = (tokens: number, window = 50_000): Usage => ({
  tokens,
  window,
  percent: Math.round((tokens * 100) / window),
})

const BANDS = resolveBands(
  [20, 40, 60, 80, 90, 95, 97].map((at) => ({ usedPercent: at, message: 'ctx {used_percent}% ({used_tokens} / {window_tokens} tokens)' })),
)

describe('resolveBands / bandOf', () => {
  test('entries sharing a threshold join with newlines, in file order', () => {
    const bands = resolveBands([
      { usedPercent: 50, message: 'FIRST' },
      { usedPercent: 20, message: 'LOW' },
      { usedPercent: 50, message: 'SECOND' },
    ])
    expect([...bands.entries()]).toEqual([
      [50, 'FIRST\nSECOND'],
      [20, 'LOW'],
    ])
  })

  test('the band is the highest threshold reached, 0 below all of them', () => {
    expect(bandOf(66, BANDS)).toBe(60)
    expect(bandOf(97, BANDS)).toBe(97)
    expect(bandOf(100, BANDS)).toBe(97)
    expect(bandOf(10, BANDS)).toBe(0)
  })
})

describe('advance (the latch)', () => {
  test('first measurement speaks the band it lands in', () => {
    expect(advance(undefined, usage(33_000), BANDS, true)).toEqual({
      band: 60,
      message: 'ctx 66% (33000 / 50000 tokens)',
    })
  })

  test('the same band stays silent and leaves the latch alone', () => {
    expect(advance(60, usage(33_000), BANDS, true)).toBeUndefined()
  })

  test('rising speaks only the highest band reached', () => {
    expect(advance(20, usage(48_600), BANDS, true)).toEqual({ band: 97, message: 'ctx 97% (48600 / 50000 tokens)' })
  })

  test('falling moves the latch back without a word', () => {
    expect(advance(97, usage(5_000), BANDS, true)).toEqual({ band: 0 })
  })

  test('rising again after a fall speaks again', () => {
    expect(advance(0, usage(33_000), BANDS, true)?.message).toBe('ctx 66% (33000 / 50000 tokens)')
  })

  test('a continuation turn the notice caused moves the latch but does not speak', () => {
    expect(advance(undefined, usage(48_600), BANDS, false)).toEqual({ band: 97 })
    expect(advance(97, usage(48_600), BANDS, true)).toBeUndefined()
  })

  test('a 0 threshold is crossed by the first measurement only', () => {
    const bands = resolveBands([
      { usedPercent: 0, message: 'ZERO {used_percent}%' },
      { usedPercent: 60, message: 'SIXTY' },
    ])
    expect(advance(undefined, usage(5_000), bands, true)).toEqual({ band: 0, message: 'ZERO 10%' })
    expect(advance(0, usage(5_000), bands, true)).toBeUndefined()
    expect(advance(0, usage(33_000), bands, true)).toEqual({ band: 60, message: 'SIXTY' })
    expect(advance(60, usage(5_000), bands, true)).toEqual({ band: 0 })
    expect(advance(0, usage(6_000), bands, true)).toBeUndefined()
  })
})

describe('render', () => {
  test('the five placeholders', () => {
    expect(
      render('{used_tokens} {used_percent}% left {available_tokens} / {available_percent}% of {window_tokens}', usage(33_000)),
    ).toBe('33000 66% left 17000 / 34% of 50000')
  })

  test('available_percent complements the rounded used_percent', () => {
    expect(render('{used_percent}+{available_percent}', usage(33_333))).toBe('67+33')
  })

  test('an unknown or misspelt placeholder stays as literal text', () => {
    expect(render('TYPO {pcnt}% {used_percent}%', usage(33_000))).toBe('TYPO {pcnt}% 66%')
    expect(render('OLD {pct}% {used} {window}', usage(33_000))).toBe('OLD {pct}% {used} {window}')
  })

  test('only {identifier} is a placeholder; any other brace is text', () => {
    expect(render('{{used_percent}} {used_tokens:,} {used_tokens!s} {0} { used_percent } { {used_percent}', usage(33_000))).toBe(
      '{66} {used_tokens:,} {used_tokens!s} {0} { used_percent } { 66',
    )
  })

  test('token counts are plain integers', () => {
    expect(render('{used_tokens} / {window_tokens}', usage(195_077, 1_000_000))).toBe('195077 / 1000000')
  })

  test('placeholderNames takes only {identifier}', () => {
    expect(placeholderNames('{a} {{b}} {c:,} {d!s} {0} {_e1}')).toEqual(['a', 'b', '_e1'])
  })
})

describe('readList', () => {
  const list = (body: object): string => JSON.stringify(body)

  test('a valid list has entries and no problems', () => {
    const r = readList(
      list({ version: 1, notifications: [{ used_percent: 60, message: 'a {used_percent}' }, { used_percent: 20, message: 'b' }] }),
      'autocompact-on',
    )
    expect(r.problems).toEqual([])
    expect(r.entries).toEqual([
      { usedPercent: 60, message: 'a {used_percent}' },
      { usedPercent: 20, message: 'b' },
    ])
  })

  test('duplicate thresholds are allowed', () => {
    const r = readList(list({ version: 1, notifications: [{ used_percent: 50, message: 'x' }, { used_percent: 50, message: 'y' }] }), 'autocompact-on')
    expect(r.problems).toEqual([])
  })

  test('a 0 threshold is allowed', () => {
    expect(readList(list({ version: 1, notifications: [{ used_percent: 0, message: 'x' }] }), 'autocompact-on').problems).toEqual([])
  })

  test('a missing or different version is reported, and the entries stay usable', () => {
    const missing = readList(list({ notifications: [{ used_percent: 50, message: 'NOVER' }] }), 'autocompact-off')
    expect(missing.problems).toEqual([
      'version が古い (ファイル: なし / 現在: 1)。テンプレ templates/autocompact-off.json を参考に書き直してください',
    ])
    expect(missing.entries).toEqual([{ usedPercent: 50, message: 'NOVER' }])
    expect(readList(list({ version: 0, notifications: [{ used_percent: 50, message: 'x' }] }), 'autocompact-on').problems[0]).toContain(
      'version が古い (ファイル: 0 / 現在: 1)',
    )
  })

  test('broken JSON and a non-object top level are reported', () => {
    expect(readList('not json', 'autocompact-on').problems[0]).toContain('JSON として読めません')
    expect(readList('[1]', 'autocompact-on').problems).toEqual(['ファイル全体を JSON オブジェクトにしてください'])
  })

  test('notifications must be a non-empty array', () => {
    expect(readList(list({ version: 1 }), 'autocompact-on').problems).toEqual(['notifications は 1 件以上の配列にしてください'])
    expect(readList(list({ version: 1, notifications: [] }), 'autocompact-on').entries).toEqual([])
  })

  test('each line is checked: object, threshold, message, placeholders', () => {
    const r = readList(
      list({
        version: 1,
        notifications: ['x', { message: 'no threshold' }, { used_percent: 101, message: 'a' }, { used_percent: 20, message: ' ' }, { used_percent: 30, message: '{pcnt}' }],
      }),
      'autocompact-on',
    )
    expect(r.problems).toEqual([
      'notifications[0]: オブジェクトにしてください',
      'notifications[1].used_percent は 0〜100 の整数にしてください (現在: なし)',
      'notifications[2].used_percent は 0〜100 の整数にしてください (現在: 101)',
      'notifications[3].message は空でない文字列にしてください',
      'notifications[4].message: 未知のプレースホルダ {pcnt} (使えるのは {used_tokens}, {used_percent}, {available_tokens}, {available_percent}, {window_tokens})',
    ])
    // The hook still uses every line it can: a blank message or an unknown
    // placeholder is the user's text, not a reason to drop the band.
    expect(r.entries).toEqual([
      { usedPercent: 20, message: ' ' },
      { usedPercent: 30, message: '{pcnt}' },
    ])
  })

  test('only an unknown {identifier} is a placeholder problem; other braces are text', () => {
    const r = readList(
      JSON.stringify({ version: 1, notifications: [{ used_percent: 50, message: '{used_tokens:,} {used_tokens!s} {0} { {{x}} }' }] }),
      'autocompact-on',
    )
    expect(r.problems).toEqual([
      'notifications[0].message: 未知のプレースホルダ {x} (使えるのは {used_tokens}, {used_percent}, {available_tokens}, {available_percent}, {window_tokens})',
    ])
  })

  test('a threshold spelt as a string is flagged but still used', () => {
    const r = readList(list({ version: 1, notifications: [{ used_percent: '50', message: 'x' }] }), 'autocompact-on')
    expect(r.problems).toEqual(['notifications[0].used_percent は 0〜100 の整数にしてください (現在: "50")'])
    expect(r.entries).toEqual([{ usedPercent: 50, message: 'x' }])
  })
})

describe('verdict', () => {
  test('one line when both lists are fine', () => {
    expect(verdict([{ name: 'autocompact-on', problems: [] }, { name: 'autocompact-off', problems: [] }])).toEqual({
      ok: true,
      text: '設定は妥当です。',
    })
  })

  test('each problem names its list; a fine list is not listed', () => {
    const v = verdict([
      { name: 'autocompact-on', problems: [] },
      { name: 'autocompact-off', problems: ['notifications[0].message: 未知のプレースホルダ {pcnt}'] },
    ])
    expect(v.ok).toBe(false)
    expect(v.text).toBe('設定に問題があります:\n  - autocompact-off: notifications[0].message: 未知のプレースホルダ {pcnt}')
  })
})

describe('where the lists live', () => {
  test('auto compact picks the list', () => {
    expect(listFor(true)).toBe('autocompact-on')
    expect(listFor(false)).toBe('autocompact-off')
  })

  test('an installed plugin uses <plugins>/data/<plugin>-<marketplace>', () => {
    expect(dataDir('/c/plugins/cache/context-notify/context-notify/0.6.1', 'context-notify', { home: '/h' })).toBe(
      '/c/plugins/data/context-notify-context-notify',
    )
    expect(dataDir('/c/plugins/cache/mkt/ctx/1.0.0', 'ctx', {})).toBe('/c/plugins/data/ctx-mkt')
  })

  test('a --plugin-dir plugin falls back to <plugins>/data/<plugin>-inline', () => {
    const root = '/src/claude-context-notify'
    expect(dataDir(root, 'context-notify', { cacheDir: '/pc', configDir: '/cfg', home: '/h' })).toBe('/pc/data/context-notify-inline')
    expect(dataDir(root, 'context-notify', { configDir: '/cfg', home: '/h' })).toBe('/cfg/plugins/data/context-notify-inline')
    expect(dataDir(root, 'context-notify', { home: '/h' })).toBe('/h/.claude/plugins/data/context-notify-inline')
    expect(dataDir(root, 'context-notify', {})).toBeUndefined()
  })

  test('a measurement in the same band touches the latch once a day at most', () => {
    expect(needsTouch({ band: 20, updatedAt: 0 }, LATCH_TOUCH_MS - 1)).toBe(false)
    expect(needsTouch({ band: 20, updatedAt: 0 }, LATCH_TOUCH_MS)).toBe(true)
  })

  test('a latch goes stale after the TTL', () => {
    expect(isStale({ band: 20, updatedAt: 0 }, LATCH_TTL_MS)).toBe(false)
    expect(isStale({ band: 20, updatedAt: 0 }, LATCH_TTL_MS + 1)).toBe(true)
  })
})

describe('report (config embeds it, check answers it)', () => {
  const on = { name: 'autocompact-on' as const, path: '/d/autocompact-on.json', isCreated: true, text: '{"version": 1, "notifications": [{"used_percent": 50, "message": "x"}]}\n' }
  const off = { name: 'autocompact-off' as const, path: '/d/autocompact-off.json', isCreated: false, text: '{"version": 1, "notifications": [{"used_percent": 50, "message": "{pcnt}"}]}' }

  test('paths, the list in use and the verdict over both', () => {
    const r = report([on, off], true, false)
    expect(r.ok).toBe(false)
    expect(r.text).toBe(
      [
        'autocompact-on: /d/autocompact-on.json  (テンプレから作成しました)',
        'autocompact-off: /d/autocompact-off.json',
        'auto compact: 有効 (発火点は Claude Code 側の window 設定で決まる)',
        'このセッションが使うのは: autocompact-on',
        '',
        '設定に問題があります:',
        '  - autocompact-off: notifications[0].message: 未知のプレースホルダ {pcnt} (使えるのは {used_tokens}, {used_percent}, {available_tokens}, {available_percent}, {window_tokens})',
      ].join('\n'),
    )
  })

  test('with contents, the list in use follows verbatim', () => {
    const r = report([on, off], false, true)
    expect(r.text).toContain('このセッションが使うのは: autocompact-off')
    expect(r.text.endsWith(`--- autocompact-off (/d/autocompact-off.json)\n${off.text}`)).toBe(true)
  })
})
