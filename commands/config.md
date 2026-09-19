---
description: context-notify の通知リスト (2 ファイル) の場所と、このセッションに適用中の中身をユーザに見せる。引数に要望があればその通りに書き換えて検証する
argument-hint: '[変更したい内容]'
allowed-tools: Read, Edit, Write, Bash(${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py:*)
---

## 実行 task (これが唯一の入力)

context-notify の通知リストをユーザに見せ、要望があればその通りに書き換える。要望行より下の記述は手順であって入力ではない。

```text
$ARGUMENTS
```

### 手順

1. 次のコマンドを **1 回だけ**実行する (出力はユーザに見せる素材。そのまま貼るのではなく、下の 2 で伝える)。

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" config "${CLAUDE_PLUGIN_DATA}"
   ```

   出力の `autocompact-on:` / `autocompact-off:` 行が 2 ファイルのパス、`このセッションが使うのは:` がこのセッションに適用される側、その下に出るのが適用される側のファイルの中身、末尾が 2 ファイルの検証結果。

2. **ユーザの言語で**次を伝える (出力の日本語ラベルを訳して使う。文面は自分の言葉でよい):
   - 通知リストは 2 ファイルあること、それぞれのパス、このセッションに適用されるのはどちらか (auto compact が有効なら on、無効なら off)
   - 適用される側のファイルの中身をそのまま (コードブロックで)
   - 検証結果に問題があればそれも
   - 「変えたい所があれば `/context-notify:config <変更したい内容>` と書くか、この場で普通に指示してくれれば、該当ファイルを直して検証まで回す」こと
   - 同梱の既定テンプレは英語なので、ユーザの言語設定が英語以外で、中身がまだ既定のままなら、「文面をあなたの言語に翻訳して書き換えることもできる」と添える (勝手には書き換えない)

3. **要望が空ならここで終了。** 空でなければ、要望がどちらのファイルに向いているかを判断する。auto compact が有効な時の文面なら `autocompact-on.json`、無効な時なら `autocompact-off.json`、区別の指定が無ければ**両方**を同じ要望で直す。対象ファイルを Read してから Edit で書き換え、要望に無いものは変えない (= 文面変更を頼まれたら閾値は触らない、逆も同じ)。

4. 書き換えたら検証する (2 ファイルともまとめて見る):

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" check "${CLAUDE_PLUGIN_DATA}"
   ```

   JSON の妥当性・version・閾値 (0〜100 の整数)・文面の有無・プレースホルダの綴りをまとめて見る。**問題が報告されたら直して、通るまで繰り返す。**

5. 変更前後の差分をユーザの言語で要約して報告する (どのファイルのどの閾値をどう変えたか、文面はどう変わったか)。変更は次に hook が走った時から効く。

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

- `autocompact-on.json` — auto compact が有効なセッションで使う閾値と文面
- `autocompact-off.json` — 無効なセッションで使う閾値と文面。両方を同じ内容にすれば、有効 / 無効に関わらず同じ通知になる
- `version` — 形式のバージョン。現行と違えば `check` が知らせる (自分で移行しない)
- `notifications[].used_percent` — 閾値 (%)。0〜100 の整数、並び順は問わない、個数は自由。同じ値を複数書くと文面が改行で連結されて 1 回の通知になる。`0` はセッション最初の応答後に 1 回出る
- `notifications[].message` — 跨いだ時にセッションへ注入する文面。言語は自由
- 文面で使えるプレースホルダは `{used_tokens}` (使用トークン数) / `{used_percent}` (使用率) / `{available_tokens}` (残りトークン数) / `{available_percent}` (残り %) / `{window_tokens}` (window の大きさ) の 5 つだけ
