---
description: context-notify の設定ファイルの場所と現在の閾値・文面を表示する (無ければテンプレから作成)
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py:*)
---

## 実行 task (これが唯一の入力)

次のコマンドを**今すぐ 1 回だけ実行**する。

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" config "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
```

**標準出力の全文を、要約も省略もせずそのまま応答に貼る** (コードブロックに入れる)。
これがこのコマンドの成果物なので、貼らずに終わってはいけない。

貼った後に、次の 1 行だけを添える (設定ファイルは自分で編集しない):

> 閾値や文面を変えるには、上の `config:` のパスをエディタで開いて編集してください。

出力には、auto compact が有効かどうかと、そこから選ばれた profile も含まれる。

設定ファイルの形式は `profile` (`auto` / `autocompact-on` / `autocompact-off`) と
`bands` (`at` = 閾値 %、`message` = 文面)。`bands` を書くと profile より優先される。
文面では `{used_tokens}` / `{used_percent}` / `{available_tokens}` /
`{available_percent}` / `{window_tokens}` が使える。
