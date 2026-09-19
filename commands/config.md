---
description: context-notify の通知リスト 2 ファイルの場所と、現在の閾値・文面を表示する (無ければテンプレから作成)
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

> 閾値や文面を変えるには、上に出ているパスのファイルをエディタで開いて編集してください。

通知リストは 2 ファイルある。auto compact が有効なセッションでは
`autocompact-on.json`、無効なセッションでは `autocompact-off.json` が使われる
(出力にはどちらが選ばれるかも含まれる)。両方を同じ内容にすれば、有効 / 無効に
関わらず同じ通知になる。

形式は `version` (形式のバージョン) と `bands` (`at` = 閾値 %、`message` = 文面) のみ。
同じ `at` を複数書くと、その文面は改行で連結されて 1 回の通知になる。文面では `{used_tokens}` /
`{used_percent}` / `{available_tokens}` / `{available_percent}` / `{window_tokens}`
が使える。
