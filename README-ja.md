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
PostToolUse:Bash hook additional context: [context-notify] Main context usage: 60% (36,242 / 60,000 tokens)
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

利用者が編集するのは plugin data dir に置かれた 2 ファイル
(`autocompact-on.json` / `autocompact-off.json`) だけで、plugin を更新しても消えない。
そこへの入口として command が 2 本ある。

| command | 誰が使うか | 何をするか |
|---|---|---|
| `/context-notify:config` | **ユーザ専用** (モデルは自動で呼ばない) | 初回はテンプレを複製し、2 ファイルのパスとこのセッションが使う通知一覧を表示する。**編集はしない** |
| `/context-notify:setup [要望]` | モデルに編集させる | 自由文の要望どおりにリストを書き換え、妥当性を検証して差分を報告する |

自分でファイルを開いて直したいなら `config`、言葉で頼みたいなら `setup`:

```bash
/context-notify:setup 90% の文面をもっと短く
/context-notify:setup 閾値に 70 を足して、95 と 97 は消して
/context-notify:setup            # 引数なし = 現在値を見せて「何を変えますか」と聞く
```

`setup` は書き換えたあとに `ctx-notify.py check` を回し、2 ファイルとも JSON の妥当性・
version・閾値 (0〜100 の整数、昇順)・文面の有無・プレースホルダの綴りを機械的に検査する。

### auto compact の有効 / 無効でテンプレを切り替える

auto compact が有効なセッションでは、高い帯の文面は「compact される前提で引き継ぎを
書き出せ」であるべきで、無効なセッションでは compact 前提の文面が誤解を招く。そこで
plugin は起動時に auto compact が有効かどうかだけを調べ、読むファイルを選び分ける。

| 検出結果 | 読むファイル |
|---|---|
| 有効 | `autocompact-on.json` (compact される前提の文面) |
| 無効 (`DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT` / `autoCompactEnabled: false`) | `autocompact-off.json` |

有効 / 無効に関わらず同じ通知にしたければ、2 ファイルを同じ内容にする。

**auto compact が何 % で走るかは plugin は見ない。** 発火点は Claude Code 側の window
設定 (`window - buffer`) で決まるので、その手前で鳴らしたければ `used_percent` にその % を書く。
有効 / 無効の判定材料は上記 env の 2 つと `autoCompactEnabled` だけ。後者は Claude Code の
settings 優先順で探す (プロジェクトの `.claude/settings.local.json` → `.claude/settings.json`
→ ユーザの `settings.local.json` → `settings.json`、最後の手段として `.claude.json`)。
設定ファイルの置き場は `CLAUDE_ENV_FILE` から割り出す
(`CLAUDE_CONFIG_DIR` は、ユーザ自身が export した時しか hook に届かないため)。判断の根拠は
[DR-0002](./docs/decisions/DR-0002-autocompact-notification-lists.md)。

auto compact が走ると使用量が下がり、latch も黙って一緒に戻る。閾値が再武装されるので、
次に帯を跨いだ時にいつもどおり通知される。

### ファイルの形式

2 ファイルとも同じ形をしている。

```json
{
  "version": 1,
  "notifications": [
    { "used_percent": 20, "message": "現在のメインコンテキスト使用量: {used_percent}% ({used_tokens} / {window_tokens} tokens)" },
    { "used_percent": 90, "message": "ctx {used_percent}%。残り {available_tokens} tokens。新しい作業に着手せず引き継ぎを始めてください。" }
  ]
}
```

- `version` — このファイルが従う形式のバージョン。現行と違えば `check` が知らせる
  (自動移行も上書きもしない)
- `notifications[].used_percent` — 閾値 (%)。0〜100 の整数、個数は自由、昇順で書く。
  `used_percent: 0` はセッション最初の応答後に 1 回出る。同じ `used_percent`
  を複数書くと、その文面が改行で連結されて 1 回の通知としてまとめて出る
- `notifications[].message` — 注入する文面。`{used_tokens}` (使用トークン数) / `{used_percent}`
  (使用率) / `{available_tokens}` (残りトークン数) / `{available_percent}` (残り %) /
  `{window_tokens}` (window の大きさ) が展開される。綴りを間違えたプレースホルダは、
  セッションを壊さないようそのまま文字として残る

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
| `SessionStart`, `PostModelSwitch` | `model` | window を記録し、auto compact が有効かどうかを調べる。model 名を `[1m]` 付きで持つのはこの 2 event だけ |
| `Stop`, `PostToolUse` | `measure` | 使用量を測り、latch を動かし、帯を上に跨いでいればその場で喋る |

使用量は transcript の最新の非 sidechain assistant 行の
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` の和 = 直近の
メインスレッドのリクエストで送った prompt 長。2 event で測るのは、transcript の
書き込みが非同期で、`Stop` の時点ではそのターンの行がまだ無いことがあるため。

`Stop` から喋ると継続ターンが 1 本起きるが、そこで読まれる prefix は既に prompt cache に
載っているので、跨ぎ 1 回のコストは cache read と数十 token の write に収まる。
この程度なら、どうせ起きるターンまで文面を持ち越す理由が無い。

latch は `$XDG_STATE_HOME/claude-context-notify/<session_id>.json` に band を 1 個持つだけ。
**上がった時だけ喋り、下がった時は黙って戻す**ので、`/compact` や `/clear` の後に閾値が
再武装され、かつ「下がりました」という無意味な通知も出ない。

設計判断の記録:
[DR-0001](./docs/decisions/DR-0001-hook-only-threshold-notification.md) (hook だけで組み立てる)、
[DR-0002](./docs/decisions/DR-0002-autocompact-notification-lists.md) (通知リスト 2 ファイル)。

## ライセンス

MIT
