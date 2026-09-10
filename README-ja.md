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

`/context-notify:config` が設定ファイルのパスを表示し、初回は同梱テンプレをそこに複製する。
置き場は plugin data dir なので、plugin を更新しても消えない。

```json
{
  "urgent_from": 90,
  "bands": [
    { "at": 20, "message": "現在のメインコンテキスト使用量: {pct}% ({used} / {win} tokens)" },
    { "at": 90, "message": "ctx {pct}%。新しい作業に着手せず引き継ぎを始めてください。" }
  ]
}
```

- `bands[].at` — 閾値 (%)。個数も順序も自由
- `bands[].message` — 注入する文面。`{pct}` / `{used}` / `{win}` が展開される
- `urgent_from` — この帯以上は `Stop` から即時に喋る (継続ターンが 1 本増える)。
  それ未満の帯は「どうせ起きる次のターン」に相乗りする

`CLAUDE_CONTEXT_WINDOW_TOKENS` で window を上書きできる (動作確認用)。

## 仕組み

| hook | 役割 | 何をするか |
|---|---|---|
| `SessionStart`, `PostModelSwitch` | `model` | window を記録する。model 名を `[1m]` 付きで持つのはこの 2 event だけ |
| `Stop` | `measure` | 使用量を測り、latch を動かし、文面を積む。`urgent_from` 以上の時だけ喋る |
| `PostToolUse`, `UserPromptSubmit` | `deliver` | 同じく測ったうえで、積まれた文面を配る |

使用量は transcript の最新の非 sidechain assistant 行の
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` の和 = 直近の
メインスレッドのリクエストで送った prompt 長。3 event すべてで測るのは、transcript の
書き込みが非同期で、`Stop` の時点ではそのターンの行がまだ無いことがあるため。

latch は `$XDG_STATE_HOME/claude-context-notify/<session_id>.json` に band を 1 個持つだけ。
**上がった時だけ喋り、下がった時は黙って戻す**ので、`/compact` や `/clear` の後に閾値が
再武装され、かつ「下がりました」という無意味な通知も出ない。

設計判断の記録: [docs/decisions/DR-0001](./docs/decisions/DR-0001-hook-only-threshold-notification.md)。

## ライセンス

MIT
