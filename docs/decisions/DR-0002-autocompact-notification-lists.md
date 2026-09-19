# DR-0002: 利用者設定は data dir の通知リスト 2 ファイル、auto compact の有効 / 無効で選ぶ

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
| `DISABLE_AUTO_COMPACT` env | 値があれば無効 | `/context` から "Autocompact buffer" 行が消える。hook の env にそのまま現れる |
| `DISABLE_COMPACT` env | 値があれば無効 (手動 `/compact` も無効になる) | バイナリの記述。env 経路は上と同じ |
| `autoCompactEnabled` | settings ファイル群 → `.claude.json` の真偽値。既定 `true` | `/config` の Auto-compact トグルは `$CLAUDE_CONFIG_DIR/settings.json` の値を表示する (v2.1.272) |

`autoCompactEnabled` は **settings ファイルに載る**。読む順は Claude Code の settings
優先順そのままで、先に真偽値を持っていたファイルが勝つ:

1. プロジェクトの `.claude/settings.local.json`
2. プロジェクトの `.claude/settings.json`
3. ユーザの `$CLAUDE_CONFIG_DIR/settings.local.json`
4. ユーザの `$CLAUDE_CONFIG_DIR/settings.json`
5. グローバル設定 `$CLAUDE_CONFIG_DIR/.claude.json` (fallback。バイナリの既定値テーブルに
   `autoCompactEnabled:!0` があり、このファイルにもキーが現れる。ただし `/config` で
   トグルしても `null` のままの環境がある)

どこにも真偽値が無ければ既定の有効。env 2 本は settings より上に置く。
`reason` にはどのファイル由来かを載せる (例 `autoCompactEnabled: false (settings.json)`)。
プロジェクト側を見るために hook payload の `cwd` を検出に渡す。

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
state に置く。読むのは JSON ファイル数個と env 2 本だけで、プロセス走査は行わない。

### 2. 利用者が編集するのは通知リスト 2 ファイルだけ

plugin data dir (`${CLAUDE_PLUGIN_DATA}`、無ければ
`$XDG_CONFIG_HOME/claude-context-notify/`) に置く 2 ファイルが利用者設定の全て:

| ファイル | 使われる時 |
|---|---|
| `autocompact-on.json` | auto compact が有効 |
| `autocompact-off.json` | auto compact が無効 |

形式は `{"bands": [{"at": <1〜100 の整数>, "message": "<文面>"}, ...]}` のみ。
どちらのファイルが読まれるかは検出結果だけで決まり、利用者が指定する余地は持たない。
**片方に固定したい利用者は 2 ファイルを同じ内容にすればよい** ので、指定する仕組みを
持つ必要が無い (= 選択肢を 1 つ増やすより、ファイルを 2 つ編集できるほうが単純)。

帯の位置 (`at`) は同梱テンプレでは両者同じ (20/40/60/80/90/95/97 と 20/40/60/80/90)。
違うのは文面で、on 側は高い帯で compact される前提の指示を出す。

無い時は hook 側でも同梱の `templates/<name>.json` を data dir へ複製する
(= 利用者が編集の起点を見つけられる)。**既存ファイルは決して上書きしない。**
data dir が書けない環境では同梱テンプレをそのまま読んで動作を続ける。

## Consequences

- どの % で auto compact が走るかは plugin からは分からない。on 側の帯は固定 % なので、
  発火点の手前で鳴らしたいユーザは自分で `at` を調整する
- 有効時と無効時で同じ文面を使いたい場合、利用者は 2 ファイルを揃える手間を負う
- セッション中に `/autocompact` や設定変更で有効 / 無効が変わっても追従しない
  (通知 hook が無く、検出は `SessionStart` / `PostModelSwitch` の一度きり)

## 関連

- [DR-0001](./DR-0001-hook-only-threshold-notification.md) — hook だけで組み立てる判断
- https://code.claude.com/docs/en/settings — settings の優先順位 (compact 関連キーの記載は無い)
