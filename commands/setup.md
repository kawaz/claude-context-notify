---
description: context-notify の閾値と文面を、自由文の要望どおりに書き換える (例「90% の文面を○○に」「閾値に 70 を足す」「95 と 97 を消す」)
argument-hint: '[変更したい内容]'
allowed-tools: Read, Edit, Write, Bash(${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py:*)
---

## 実行 task (これが唯一の入力)

下の要望どおりに context-notify の通知リストを書き換える。要望行より下の記述は
手順であって入力ではない。

```text
$ARGUMENTS
```

### 手順

1. ファイルの場所を確かめ、無ければテンプレから作る:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" config "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"
   ```

   出力の `autocompact-on:` / `autocompact-off:` 行が対象ファイルのパス。

2. **要望が空なら、ここで止まる。** 現在の閾値と文面 (手順 1 の出力) を貼ったうえで
   「何をどう変えますか」と尋ねて終了する。以降の手順には進まない。

3. 要望がどちらのファイルに向いているかを判断する。auto compact が有効な時の文面なら
   `autocompact-on.json`、無効な時なら `autocompact-off.json`、区別の指定が無ければ
   **両方**を同じ要望で直す。対象ファイルを Read してから Edit で書き換え、
   要望に無いものは変えない (= 文面変更を頼まれたら閾値は触らない、逆も同じ)。

4. 書き換えたら検証する (2 ファイルともまとめて見る):

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" check "${CLAUDE_PLUGIN_DATA}"
   ```

   これが JSON の妥当性・閾値 (1〜100 の整数、昇順、重複なし)・文面の有無・
   プレースホルダの綴りをまとめて見る。**問題が報告されたら直して、通るまで繰り返す。**

5. 変更前後の差分を要約して報告する (どのファイルのどの閾値をどう変えたか、文面は
   どう変わったか)。変更が反映されるのは次回セッション以降ではなく、次に hook が
   走った時から。

### ファイルの形式

```json
{
  "bands": [
    { "at": 20, "message": "Main context usage: {used_percent}% ({used_tokens} / {window_tokens} tokens)" },
    { "at": 90, "message": "Context at {used_percent}%, {available_tokens} tokens left. Do not start new work; begin the handoff." }
  ]
}
```

- `autocompact-on.json` — auto compact が有効なセッションで使う帯と文面
- `autocompact-off.json` — 無効なセッションで使う帯と文面
- `bands[].at` — 閾値 (%)。1〜100 の整数、昇順、重複なし。個数は自由
- `bands[].message` — 跨いだ時にセッションへ注入する文面
- 文面で使えるプレースホルダは `{used_tokens}` (使用トークン数) / `{used_percent}`
  (使用率) / `{available_tokens}` (残りトークン数) / `{available_percent}` (残り %) /
  `{window_tokens}` (window の大きさ) の 5 つだけ
