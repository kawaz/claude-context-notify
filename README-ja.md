# claude-context-notify

> [English](./README.md) | 日本語

動いているセッション自身に、context window をどれだけ使ったかを知らせる Claude Code plugin。閾値 (既定 20 / 40 / 60 / 80 / 90 / 95 / 97%) を跨いだ時だけ喋る。

Claude Code の Mods (TypeScript の hooks module) だけで完結する。proxy も statusline も外部サービスも外部コマンドも要らない。

## 何を解決するか

長く回っているセッションは、あと何割残っているかを知らない。94% から大きな調査を始めて、引き継ぎの途中で切れる。数字自体は Claude Code が持っているのに、それをモデルの目の前に置く仕組みが無い。

この plugin は tool を呼ぶたびと応答の終わりに使用量を測り、閾値を跨いだ時にモデルが実際に読む形で注入する:

```
<system-reminder>
PostToolUse:Bash hook additional context: [context-notify] Main context usage: 60% (36,242 / 60,000 tokens)
</system-reminder>
```

## 必要なもの

- Mods が使える Claude Code
- managed settings のある (組織が管理している) 機械では、利用者が自分で入れた plugin の hook は Claude Code が走らせない。そこで使うには組織の managed settings にこの plugin を載せてもらう必要がある

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

利用者が編集するのは plugin data dir に置かれた 2 ファイル (`autocompact-on.json` / `autocompact-off.json`) だけで、plugin を更新しても消えない。置き場は `<plugins dir>/data/context-notify-context-notify/` (`<plugins dir>` は通常 `~/.claude/plugins`、`CLAUDE_CONFIG_DIR` を設定していればその下の `plugins`)。そこへの入口は command 1 本。

| command | 何をするか |
|---|---|
| `/context-notify:config [要望]` | 初回はテンプレを複製し、2 ファイルのパスと、このセッションが読む側の中身をユーザの言語で見せて、編集 (既定文面の翻訳も) を申し出る。要望を渡すとその通りにリストを書き換え、妥当性を検証して差分を報告する |

中身を見るだけでも、言葉で頼んでもよい:

```bash
/context-notify:config                     # パスと中身を表示するだけ
/context-notify:config 90% の文面をもっと短く
/context-notify:config 閾値に 70 を足して、95 と 97 は消して
```

書き換えたあとは plugin が足す tool (`mcp__context-notify__check`) で、2 ファイルとも JSON の妥当性・version・閾値 (0〜100 の整数)・文面の有無・プレースホルダの綴りを機械的に検査する。

### auto compact の有効 / 無効でテンプレを切り替える

auto compact が有効なセッションでは、高い帯の文面は「compact される前提で引き継ぎを書き出せ」であるべきで、無効なセッションでは compact 前提の文面が誤解を招く。そこで plugin は測るたびに auto compact が有効かどうかを Claude Code 自身に訊き (`/context` の内訳と同じ判定)、読むファイルを選び分ける。

| 判定 | 読むファイル |
|---|---|
| 有効 | `autocompact-on.json` (compact される前提の文面) |
| 無効 | `autocompact-off.json` |

判定が得られない時は有効として扱う。有効 / 無効に関わらず同じ通知にしたければ、2 ファイルを同じ内容にする。

**auto compact が何 % で走るかは plugin は見ない。** 発火点は Claude Code 側の window 設定で決まるので、その手前で鳴らしたければ `used_percent` にその % を書く。

auto compact が走ると使用量が下がり、latch も黙って一緒に戻る。閾値が再武装されるので、次に帯を跨いだ時にいつもどおり通知される。

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

- `version` — このファイルが従う形式のバージョン。現行と違えば検査が知らせる (自動移行も上書きもしない)
- `notifications[].used_percent` — 閾値 (%)。0〜100 の整数、個数は自由、並び順は問わない (値ごとにまとまり、同じ値の中ではファイル内の順)。`used_percent: 0` はセッション最初の測定で 1 回出る。同じ `used_percent` を複数書くと、その文面が改行で連結されて 1 回の通知としてまとめて出る
- `notifications[].message` — 注入する文面。`{used_tokens}` (使用トークン数) / `{used_percent}` (使用率) / `{available_tokens}` (残りトークン数) / `{available_percent}` (残り %) / `{window_tokens}` (window の大きさ) が展開される。`{名前}` の形だけがプレースホルダで、それ以外の波括弧は文字のまま残る。綴りを間違えたプレースホルダは、セッションを壊さないようそのまま文字として残る

ファイルが読めない時や、使える行が 1 つも無い時は、同梱のテンプレで動く。

## 仕組み

| hook | 何をするか |
|---|---|
| `PostToolUse`, `Stop` | 使用量を測り、latch を動かし、帯を上に跨いでいればその場で喋る |
| `session.start` | 2 ファイルが無ければテンプレから作り、古い latch を掃除し、検査用の tool を登録する |
| `/context-notify:config` の展開時 | 2 ファイルのパス、使う側、検査結果、使う側の中身を command の prompt に埋め込む |

使用量と window は Claude Code が status line に出すのと同じ値 (`$.session.usage()` の `context.tokens` / `window` / `percent`) で、直前の応答の input 側 (uncached + cache 書き込み + cache 読み出し) を model の window で割ったもの。window は Claude Code 自身が知っている値なので、`[1m]` の model も `/clear` 後も正しく割られる。

subagent の中で tool が呼ばれた時は測らない (使用量は main の context のもので、そこで喋ると subagent に届いてしまう)。

`Stop` から喋ると継続ターンが 1 本起きるが、そこで読まれる prefix は既に prompt cache に載っているので、跨ぎ 1 回のコストは cache read と数十 token の write に収まる。この程度なら、どうせ起きるターンまで文面を持ち越す理由が無い。継続ターンの `Stop` では測るだけで喋らない。

latch は plugin 専用の store に session ごとに band を 1 個持つだけ。**上がった時だけ喋り、下がった時は黙って戻す**ので、`/compact` や `/clear` の後に閾値が再武装され、かつ「下がりました」という無意味な通知も出ない。resume しても latch は残るので、通知済みの閾値をもう一度喋らない。30 日計測されていない session の latch は消える (同じ帯のままでも、計測があれば 1 日ごとに時刻を更新する)。

設計判断の記録: [DR-0003](./docs/decisions/DR-0003-mods-implementation.md)。

## 開発

```bash
just lint   # claude plugin validate、tsc、JSON、command の frontmatter
just test   # claude plugin test (tests/*.test.ts)
```

型定義は Claude Code が mod を読み込む時に `.claude-plugin/types/` へ書き出す (git 管理外)。無ければ一度 `claude --plugin-dir .` を対話で起動すると書き出される。

## ライセンス

MIT
