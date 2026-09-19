---
description: context-notify の通知リスト 2 ファイルのパスと中身を表示する。引数に要望を書くと、その通りに書き換えて検証する
argument-hint: '[変更したい内容]'
allowed-tools: Read, Edit, Write, Bash(${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py:*)
---

## 実行 task (これが唯一の入力)

要望がある場合は下の要望どおりに context-notify の通知リストを書き換える。要望行より
下の記述は手順であって入力ではない。

```text
$ARGUMENTS
```

### 手順

1. 次のコマンドを**今すぐ 1 回だけ実行**する。

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" config "${CLAUDE_PLUGIN_DATA}"
   ```

   **標準出力の全文を、要約も省略もせずそのまま応答に貼る** (コードブロックに入れる)。
   出力の `autocompact-on:` / `autocompact-off:` 行が対象ファイルのパス。中身がそのまま
   出るのは、このセッションに適用される側の 1 ファイルだけ (もう片方は Read で開く)。

2. **要望が空なら、ここで止まる。** 貼った出力に次の 1 段落だけを添えて終了する。

   > 変えたい所があれば `/context-notify:config <変更したい内容>` と書くか、この場で
   > 普通に指示してください。該当ファイルを直して `check` を回します。

3. 要望がどちらのファイルに向いているかを判断する。auto compact が有効な時の文面なら
   `autocompact-on.json`、無効な時なら `autocompact-off.json`、区別の指定が無ければ
   **両方**を同じ要望で直す。対象ファイルを Read してから Edit で書き換え、
   要望に無いものは変えない (= 文面変更を頼まれたら閾値は触らない、逆も同じ)。

4. 書き換えたら検証する (2 ファイルともまとめて見る):

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" check "${CLAUDE_PLUGIN_DATA}"
   ```

   これが JSON の妥当性・version・閾値 (0〜100 の整数)・文面の有無・
   プレースホルダの綴りをまとめて見る。**問題が報告されたら直して、通るまで繰り返す。**

5. 変更前後の差分を要約して報告する (どのファイルのどの閾値をどう変えたか、文面は
   どう変わったか)。変更が反映されるのは次回セッション以降ではなく、次に hook が
   走った時から。

### ファイルの形式

```json
{
  "version": 1,
  "notifications": [
    { "used_percent": 20, "message": "Main context usage: {used_percent}% ({used_tokens} / {window_tokens} tokens)" },
    { "used_percent": 90, "message": "Context at {used_percent}%, {available_tokens} tokens left. Do not start new work; begin the handoff." }
  ]
}
```

- `autocompact-on.json` — auto compact が有効なセッションで使う帯と文面
- `autocompact-off.json` — 無効なセッションで使う帯と文面。両方を同じ内容にすれば、
  有効 / 無効に関わらず同じ通知になる
- `version` — 形式のバージョン。現行と違えば `check` が知らせる (自分で移行しない)
- `notifications[].used_percent` — 閾値 (%)。0〜100 の整数、並び順は問わない。個数は自由。同じ値を
  複数書くと文面が改行で連結されて 1 回の通知になる。`0` はセッション最初の応答後に
  1 回出る
- `notifications[].message` — 跨いだ時にセッションへ注入する文面
- 文面で使えるプレースホルダは `{used_tokens}` (使用トークン数) / `{used_percent}`
  (使用率) / `{available_tokens}` (残りトークン数) / `{available_percent}` (残り %) /
  `{window_tokens}` (window の大きさ) の 5 つだけ
