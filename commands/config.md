---
description: context-notify の設定ファイルの場所と現在の閾値・文面を表示する (無ければテンプレから作成)
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py:*)
---

## 実行 task (これが唯一の入力)

次のコマンドを**今すぐ 1 回だけ実行**する。

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" config "${CLAUDE_PLUGIN_DATA}"
```

**標準出力の全文を、要約も省略もせずそのまま応答に貼る** (コードブロックに入れる)。
これがこのコマンドの成果物なので、貼らずに終わってはいけない。

貼った後に、次の 1 行だけを添える (設定ファイルは自分で編集しない):

> 閾値や文面を変えるには、上の `config:` のパスをエディタで開いて編集してください。

設定ファイルの形式は `bands` (`at` = 閾値 %、`message` = 文面) の配列と、
`urgent_from` (この帯以上は `Stop` から即時に通知する下限) の 2 つ。
文面では `{pct}` / `{used}` / `{win}` が使える。
