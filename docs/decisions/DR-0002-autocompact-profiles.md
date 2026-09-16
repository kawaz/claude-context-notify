# DR-0002: auto compact は有効 / 無効だけ見てテンプレを使い分ける

- Status: Active
- Date: 2026-09-11
- 実測環境: Claude Code v2.1.268 / macOS 25.5.0

## Context

auto compact が有効なセッションでは、高い帯の文面は「自分で畳め」ではなく
「compact される前提で引き継ぎを書き出せ」であるべきで、無効なセッションでは
compact 前提の文面が誤解を招く。どちらの前提で動いているかだけを plugin が知る。

**発火点そのものは plugin の責務ではない。** この plugin の責務は「使用率が指定 %
を越えたら文面を差し込む」ことに閉じる。auto compact が何 % で走るかは Claude Code
側の window 設定で決まり、その手前のどこに帯を置くかは利用者が `at` で決める。

## 検出できるもの (すべて実測)

| 経路 | 読み方 | 実測 |
|---|---|---|
| `autoCompactEnabled` | `$CLAUDE_CONFIG_DIR/.claude.json` の真偽値。既定 `true` | `false` にすると `/context` から "Autocompact buffer" 行が消える |
| `DISABLE_AUTO_COMPACT` env | 値があれば無効 | 同上。hook の env にそのまま現れる |
| `DISABLE_COMPACT` env | 値があれば無効 (手動 `/compact` も無効になる) | バイナリの記述。env 経路は上と同じ |

`autoCompactEnabled` は **settings.json ではなくグローバル設定 `.claude.json`** に載る
(バイナリ内の既定値テーブルに `autoCompactEnabled:!0` があり、実ファイルでも同じ場所)。

### config dir の在り処

**`CLAUDE_CONFIG_DIR` は、ユーザ自身が export したときしか hook に届かない**
(実測: `HOME` を差し替えて未設定で起動すると、hook の env に現れない)。
未設定のほうが普通なので、これだけに頼ると `.claude.json` を読み損なう。

代わりに **`CLAUDE_ENV_FILE` から割り出す**。この変数は `SessionStart` hook に渡され、
値は `<config dir>/session-env/<session_id>/sessionstart-hook-0.sh` の形をしている
(実測: `CLAUDE_CONFIG_DIR=/tmp/acprobe/cfg` のとき
`/tmp/acprobe/cfg/session-env/.../sessionstart-hook-0.sh`、未設定なら
`/tmp/fakehome/.claude/session-env/...`)。検出は `SessionStart` で走るので、
ちょうど手に入る場所にある。

したがって **`CLAUDE_ENV_FILE` 由来 > `CLAUDE_CONFIG_DIR` > `$HOME/.claude`** の順に解決する。
`CLAUDE_ENV_FILE` は `Stop` hook には渡らない (実測) が、検出は `SessionStart` で
一度きりなので問題にならない。

## Decision

### 1. 検出は `SessionStart` / `PostModelSwitch` で一度だけ行い state に持つ

window を記録する `model` 役に相乗りさせ、`autocompact: {enabled, reason}` として
state に置く。読むのは JSON ファイル 1 個と env 2 本だけで、プロセス走査は行わない。

### 2. profile で帯を切り替える

`templates/autocompact-off.json` と `templates/autocompact-on.json` を持ち、
設定の `profile` が `auto` (既定) なら検出結果で選ぶ:

| 検出 | 選ぶ profile |
|---|---|
| 有効 | `autocompact-on` |
| 無効 | `autocompact-off` |

帯の位置 (`at`) は両 profile で同じ (20/40/60/80/90/95/97)。違うのは文面だけで、
on 側は「発火点は Claude Code 側の設定で決まるので、その手前の % に `at` を置け」と
最初の帯で案内し、高い帯では compact される前提の指示を出す。`urgent_from` は
on 側 80 / off 側 90。

**設定に `bands` があればそれが最優先** (profile より上)。ユーザが自分で書いた帯を
検出結果で上書きしない。

### 3. `PreCompact` (matcher `auto`) で latch を戻し、compact 後に 1 度だけ知らせる

compact の**最中**に喋っても、それを読むターンごと要約される。そこで PreCompact では
state を巻き戻して通知を積むだけにし、**新しい context の最初のターン**で配る。

積み先は `pending` (帯の通知) とは別の `notice` にする。PreCompact 直後の測定は
まだ古い使用量を読むことがあり、同じ場所に積むと帯の通知に上書きされて消えるため
(テストで再現させたうえで分離した)。

## Consequences

- どの % で auto compact が走るかは plugin からは分からない。on 側の帯は固定 % なので、
  発火点の手前で鳴らしたいユーザは自分で `at` を調整する
- セッション中に `/autocompact` や設定変更で有効 / 無効が変わっても追従しない
  (通知 hook が無く、検出は `SessionStart` / `PostModelSwitch` の一度きり)
- `PreCompact` の **auto matcher が実際に発火するところは未実測** (再現に ~87k
  tokens 以上の消費が要る)。同じ hook を `manual` matcher で発火させ、stdin に
  `trigger: "manual"` が来ることと配線の正しさは確認済み

## 関連

- [DR-0001](./DR-0001-hook-only-threshold-notification.md) — hook だけで組み立てる判断
- https://code.claude.com/docs/en/settings — settings の優先順位 (compact 関連キーの記載は無い)
