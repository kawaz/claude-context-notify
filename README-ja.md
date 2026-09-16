# claude-context-notify

> [English](./README.md) | 日本語

動いているセッション自身に、context window をどれだけ使ったかを知らせる Claude Code
plugin。閾値 (既定 20 / 40 / 60 / 80 / 90 / 95 / 97%) を跨いだ時だけ喋る。

hook だけで完結する。proxy も statusline も外部サービスも要らず、依存は `python3` のみ。

## 何を解決するか

長く回っているセッションは、あと何割残っているかを知らない。94% から大きな調査を始めて、
引き継ぎの途中で切れる。数字自体は transcript と `SessionStart` の payload に存在するのに、
それをモデルの目の前に置く仕組みが無い。

この plugin はターンごとに使用量を測り、閾値を跨いだ時にモデルが実際に読む形で注入する:

```
<system-reminder>
PostToolUse:Bash hook additional context: [context-notify] 現在のメインコンテキスト使用量: 60% (36,242 / 60,000 tokens)
</system-reminder>
```

## 導入

```bash
/plugin marketplace add kawaz/claude-context-notify
/plugin install context-notify@context-notify
/reload-plugins
```

設定を見る (初回は作成される):

```bash
/context-notify:config
```

## 閾値と文面のカスタマイズ

command は 2 本ある。設定ファイルはどちらも plugin data dir に置かれ、plugin を更新しても消えない。

| command | 誰が使うか | 何をするか |
|---|---|---|
| `/context-notify:config` | **ユーザ専用** (モデルは自動で呼ばない) | 初回はテンプレを複製し、パスと現在の閾値・文面を表示する。**編集はしない** |
| `/context-notify:setup [要望]` | モデルに編集させる | 自由文の要望どおりに設定を書き換え、妥当性を検証して差分を報告する |

自分でファイルを開いて直したいなら `config`、言葉で頼みたいなら `setup`:

```bash
/context-notify:setup 90% の文面をもっと短く
/context-notify:setup 閾値に 70 を足して、95 と 97 は消して
/context-notify:setup            # 引数なし = 現在値を見せて「何を変えますか」と聞く
```

`setup` は書き換えたあとに `ctx-notify.py check` を回し、JSON の妥当性・閾値
(1〜100 の整数、昇順、重複なし)・文面の有無・プレースホルダの綴りを機械的に検査する。

### auto compact を検出して帯を切り替える

auto compact が閾値で走るセッションでは、95% や 97% の帯は撃たれる前に compact が起きて
意味を失う。そこで plugin は起動時に auto compact の設定を調べ、帯を選び分ける。

| 検出結果 | 使う profile |
|---|---|
| 有効で、発火トークン数が確定している | `autocompact-on` (発火の手前で畳むよう促す) |
| 有効だが閾値が定まらない (既定の `auto`) | `autocompact-off` |
| 無効 (`DISABLE_AUTO_COMPACT` / `autoCompactEnabled: false`) | `autocompact-off` |

設定の `profile` に `autocompact-on` / `autocompact-off` を書けば固定できる。
自分で `bands` を書いた場合は profile より優先される。

発火トークン数は `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env → `--autocompact <tokens>` →
`autoCompactWindow` 設定 (managed → project → user) の順に探し、見つかった window から
33,000 を引いた値 (実測した buffer)。設定ファイルの置き場は `CLAUDE_ENV_FILE` から割り出す
(`CLAUDE_CONFIG_DIR` は、ユーザ自身が export した時しか hook に届かないため)。検出の詳細と根拠は
[DR-0002](./docs/decisions/DR-0002-autocompact-detection-and-profiles.md)。

auto compact が走ると `PreCompact` hook が latch を戻し、新しい context の最初のターンで
「要約に置き換わった」ことを 1 度だけ知らせる。

### 設定ファイルの形式

```json
{
  "profile": "auto",
  "urgent_from": 90,
  "bands": [
    { "at": 20, "message": "現在のメインコンテキスト使用量: {pct}% ({used} / {window} tokens)" },
    { "at": 90, "message": "ctx {pct}%。新しい作業に着手せず引き継ぎを始めてください。" },
    { "before_autocompact": 5, "message": "auto compact ({ac_pct}%) まであと 5 ポイント。" }
  ]
}
```

- `profile` — `auto` (既定、検出結果で選ぶ) / `autocompact-on` / `autocompact-off`。
  `bands` を書けばそちらが優先される
- `bands[].at` — 閾値 (%)。個数も順序も自由
- `bands[].before_autocompact` — `at` の代わりに「auto compact 発火の N ポイント手前」で
  置く。発火トークン数が分からないセッションではこの帯は無視される
- `bands[].message` — 注入する文面。`{pct}` (使用率) / `{used}` (使用トークン数) /
  `{window}` (window の大きさ) / `{ac_pct}` (auto compact の発火率) /
  `{ac_tokens}` (同トークン数) が展開される。綴りを間違えたプレースホルダは、
  セッションを壊さないようそのまま文字として残る
- `urgent_from` — この帯以上は `Stop` から即時に喋る (継続ターンが 1 本増える)。
  それ未満の帯は「どうせ起きる次のターン」に相乗りする

### window の決まり方

使用率は割る相手の window 次第で意味が変わる。`[1m]` を保っている唯一の手掛かりである
model 名は、`/clear` や `claude -p` 起点の `SessionStart` payload には載らない。そこで
window は次の順で、最初に答えが出たものを使う。

1. `CLAUDE_CONTEXT_WINDOW_TOKENS` — 明示的な上書き (動作確認にも使える)
2. `SessionStart` / `PostModelSwitch` の `model` / `to_model` 欄 (来ている場合)
3. 同じ claude プロセスが直前に記録した window。`CLAUDE_PID` をキーに
   `$XDG_STATE_HOME/claude-context-notify/by-pid/` へ控えてある。`/clear` はプロセスを
   維持したまま session id だけを差し替えるので、そこから引き継げる。終了したプロセスの
   記録は新しい記録を書くついでに掃除される
4. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — Claude Code 本体が「model 名から window を判定
   できないときに context window とみなす」変数。これを設定したセッションは、本体と
   同じ数値で測られる
5. 200,000 tokens

## 仕組み

| hook | 役割 | 何をするか |
|---|---|---|
| `SessionStart`, `PostModelSwitch` | `model` | window を記録し、auto compact の設定を検出する。model 名を `[1m]` 付きで持つのはこの 2 event だけ |
| `Stop` | `measure` | 使用量を測り、latch を動かし、文面を積む。`urgent_from` 以上の時だけ喋る |
| `PostToolUse`, `UserPromptSubmit` | `deliver` | 同じく測ったうえで、積まれた文面を配る |
| `PreCompact` (matcher `auto`) | `precompact` | latch を 0 に戻し、compact 後の最初のターンに知らせる文面を積む |

使用量は transcript の最新の非 sidechain assistant 行の
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` の和 = 直近の
メインスレッドのリクエストで送った prompt 長。3 event すべてで測るのは、transcript の
書き込みが非同期で、`Stop` の時点ではそのターンの行がまだ無いことがあるため。

latch は `$XDG_STATE_HOME/claude-context-notify/<session_id>.json` に band を 1 個持つだけ。
**上がった時だけ喋り、下がった時は黙って戻す**ので、`/compact` や `/clear` の後に閾値が
再武装され、かつ「下がりました」という無意味な通知も出ない。

設計判断の記録:
[DR-0001](./docs/decisions/DR-0001-hook-only-threshold-notification.md) (hook だけで組み立てる)、
[DR-0002](./docs/decisions/DR-0002-autocompact-detection-and-profiles.md) (auto compact の検出と profile)。

## ライセンス

MIT
