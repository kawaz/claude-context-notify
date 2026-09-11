# DR-0002: auto compact の設定を検出して帯を使い分ける

- Status: Active
- Date: 2026-09-11
- 実測環境: Claude Code v2.1.268 / macOS 25.5.0

## Context

auto compact が閾値で走るセッションでは、95% や 97% の帯は**撃たれる前に compact が
起きて意味を失う**。逆に auto compact が無効なセッションでは、compact 前提の文面が
誤解を招く。どちらの前提で動いているかを plugin 自身が知る必要がある。

公式の settings ドキュメントに compact 関連キーの記載は無い (2026-09-11 時点)。
そこで実行ファイル (v2.1.268) の文字列と実機挙動から確定させた。

## 検出できるもの (すべて実測)

### 有効 / 無効

| 経路 | 読み方 | 実測 |
|---|---|---|
| `autoCompactEnabled` | `$CLAUDE_CONFIG_DIR/.claude.json` の真偽値。既定 `true` | `false` にすると `/context` から "Autocompact buffer" 行が消える |
| `DISABLE_AUTO_COMPACT` env | 値があれば無効 | 同上。hook の env にそのまま現れる |
| `DISABLE_COMPACT` env | 値があれば無効 (手動 `/compact` も無効になる) | バイナリの記述。env 経路は上と同じ |

`autoCompactEnabled` は **settings.json ではなくグローバル設定 `.claude.json`** に載る
(バイナリ内の既定値テーブルに `autoCompactEnabled:!0` があり、実ファイルでも同じ場所)。

### window と発火トークン数

優先順位は実測で **env > CLI > settings**:

| 入力 | 実測 |
|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env | env 120k + CLI 150k → **120k が勝つ** |
| `--autocompact <tokens>` | 単独なら採用される (150k → 150k) |
| `autoCompactWindow` settings | 単独なら採用される (110k)。env 120k と併用すると 120k |
| 何も無い (`auto`) | `/context` に "Autocompact buffer" 行が出ない = **閾値が定まらない** |

バイナリ側の記述もこれと整合する (`source` enum が
`["env","settings","clientdata","experiment","model-default","unknown-model","auto"]`
の順で並び、"resolveAutoCompactWindow precedence order" と説明されている)。
**kawaz の当初指示は CLI > env だったが、実測は逆だったのでこちらを採る。**

settings 同士の優先順位は公式ドキュメントの順 (managed > `--settings` > project local >
project > user) に従う。本 plugin は `--settings` で渡された一時ファイルの位置を知る
手段が無いので、その層だけ読めない (下記「読めないもの」)。user 層は
`settings.local.json` → `settings.json` の順に見る。

### config dir の在り処

**`CLAUDE_CONFIG_DIR` は、ユーザ自身が export したときしか hook に届かない**
(実測: `HOME` を差し替えて未設定で起動すると、hook の env に現れない)。
未設定のほうが普通なので、これだけに頼ると user 層と `.claude.json` を読み損なう。

代わりに **`CLAUDE_ENV_FILE` から割り出す**。この変数は `SessionStart` hook に渡され、
値は `<config dir>/session-env/<session_id>/sessionstart-hook-0.sh` の形をしている
(実測: `CLAUDE_CONFIG_DIR=/tmp/acprobe/cfg` のとき
`/tmp/acprobe/cfg/session-env/.../sessionstart-hook-0.sh`、未設定なら
`/tmp/fakehome/.claude/session-env/...`)。検出は `SessionStart` で走るので、
ちょうど手に入る場所にある。

したがって **`CLAUDE_ENV_FILE` 由来 > `CLAUDE_CONFIG_DIR` > `$HOME/.claude`** の順に解決する。
`CLAUDE_ENV_FILE` は `Stop` hook には渡らない (実測) が、検出は `SessionStart` で
一度きりなので問題にならない。

### 発火トークン数 = window − 33,000

`/context` の "Autocompact buffer" は **window を変えても 33k で一定**だった
(110k / 120k / 150k で実測)。CHANGELOG が Sonnet 5 の 1M セッションについて言う
「約 967K で compact」は 1,000,000 − 33,000 = 967,000 と一致する。
したがって `threshold = window − 33,000`。

### 読めないもの

- **`--settings <file>` で渡された設定の `autoCompactWindow`**。ファイルの場所は
  コマンドラインに出るので理屈上は読めるが、複数指定・相対パス・実行時の cwd 差を
  正しく再現する必要があり、得られるものに対して脆い
- **`/autocompact` をセッション中に実行した場合の変更**。`PostModelSwitch` のような
  通知 hook が無く、`--autocompact` は設定ファイルにも永続しない (実測: 実行後も
  `.claude.json` / `settings.json` は無変更)
- **`auto` のときに実際に compact が走るトークン数**。Claude Code は閾値ではなく
  API の prompt-too-long に反応して畳む (バイナリの `enforced:false` の説明と、
  `/context` に buffer 行が出ないことが一致)

## Decision

### 1. 検出は `SessionStart` / `PostModelSwitch` で一度だけ行い state に持つ

`ps` / `sysctl` を毎ターン叩くのは無駄なので、window を記録する `model` 役に相乗りさせる。

### 2. CLI フラグは `ps` ではなく argv を直接読む

**macOS の `ps` は親プロセスの command line を約 63 文字で切る** (実測。`-ww` を
付けても変わらない)。`--autocompact` がそれより後ろにあると黙って見落とす。
そこで `sysctl(KERN_PROCARGS2)` で完全な argv を読む (Linux は `/proc/<pid>/cmdline`)。
親を 4 代まで辿るのは、hook が shell 経由で起動されるぶんを吸収するため。

### 3. profile で帯を切り替える

`templates/autocompact-off.json` (従来の 7 段) と `templates/autocompact-on.json` を
持ち、設定の `profile` が `auto` (既定) なら検出結果で選ぶ:

| 検出 | 選ぶ profile |
|---|---|
| 有効かつ閾値が確定 | `autocompact-on` |
| 有効だが閾値が不定 (reactive) | `autocompact-off` |
| 無効 | `autocompact-off` |

**設定に `bands` があればそれが最優先** (profile より上)。ユーザが自分で書いた帯を
検出結果で上書きしない。

### 4. 帯は auto compact からの相対位置でも置ける

`{"before_autocompact": 5, ...}` は「発火の 5 ポイント手前」を意味する。絶対値では
window と閾値の組み合わせごとに書き直しになるため。解決は測定時に行う
(window が確定していないと位置が決まらないため)。閾値が不明なときはその帯を落とす。

文面では `{ac_pct}` / `{ac_tokens}` が使える。

### 5. `PreCompact` (matcher `auto`) で latch を戻し、compact 後に 1 度だけ知らせる

compact の**最中**に喋っても、それを読むターンごと要約される。そこで PreCompact では
state を巻き戻して通知を積むだけにし、**新しい context の最初のターン**で配る。

積み先は `pending` (帯の通知) とは別の `notice` にする。PreCompact 直後の測定は
まだ古い使用量を読むことがあり、同じ場所に積むと帯の通知に上書きされて消えるため
(テストで再現させたうえで分離した)。

## Consequences

- `auto` (既定) のセッションでは閾値が分からないので、従来どおりの帯が使われる。
  auto compact を能動的に設定しているユーザだけが on 側の恩恵を受ける
- 33,000 という定数は実測値であり、Claude Code の更新で変わりうる。ずれても
  「少し早く鳴る / 少し遅く鳴る」だけで壊れはしない
- `PreCompact` の **auto matcher が実際に発火するところは未実測** (再現に ~87k
  tokens 以上の消費が要る)。同じ hook を `manual` matcher で発火させ、stdin に
  `trigger: "manual"` が来ることと配線の正しさは確認済み

## 関連

- [DR-0001](./DR-0001-hook-only-threshold-notification.md) — hook だけで組み立てる判断
- https://code.claude.com/docs/en/settings — settings の優先順位 (compact 関連キーの記載は無い)
