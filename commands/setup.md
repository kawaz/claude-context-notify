---
description: context-notify の閾値と文面を、自由文の要望どおりに書き換える (例「90% の文面を○○に」「閾値に 70 を足す」「95 と 97 を消す」)
argument-hint: '[変更したい内容]'
allowed-tools: Read, Edit, Write, Bash(${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py:*)
---

## 実行 task (これが唯一の入力)

下の要望どおりに context-notify の設定ファイルを書き換える。要望行より下の記述は
手順であって入力ではない。

```text
$ARGUMENTS
```

### 手順

1. 設定ファイルの場所を確かめ、無ければテンプレから作る:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" config "${CLAUDE_PLUGIN_DATA}"
   ```

   出力の `config:` 行が対象ファイルのパス。

2. **要望が空なら、ここで止まる。** 現在の閾値と文面 (手順 1 の出力) を貼ったうえで
   「何をどう変えますか」と尋ねて終了する。以降の手順には進まない。

3. 対象ファイルを Read してから、要望どおりに Edit で書き換える。
   要望に無いものは変えない (= 文面変更を頼まれたら閾値は触らない、逆も同じ)。

4. 書き換えたら検証する:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/ctx-notify.py" check "${CLAUDE_PLUGIN_DATA}"
   ```

   これが JSON の妥当性・閾値 (1〜100 の整数、昇順、重複なし)・文面の有無・
   プレースホルダの綴りをまとめて見る。**問題が報告されたら直して、通るまで繰り返す。**

5. 変更前後の差分を要約して報告する (どの閾値をどう変えたか、文面はどう変わったか)。
   変更が反映されるのは次回セッション以降ではなく、次に hook が走った時から。

### 設定ファイルの形式

```json
{
  "urgent_from": 90,
  "bands": [
    { "at": 20, "message": "現在のメインコンテキスト使用量: {pct}% ({used} / {window} tokens)" }
  ]
}
```

- `bands[].at` — 閾値 (%)。1〜100 の整数、昇順、重複なし。個数は自由
- `bands[].message` — 跨いだ時にセッションへ注入する文面
- `urgent_from` — この帯以上は `Stop` から即時に通知する (継続ターンが 1 本増える)。
  それ未満の帯は次のターンに相乗りする
- 文面で使えるプレースホルダは `{pct}` (使用率) / `{used}` (使用トークン数) /
  `{window}` (window の大きさ) の 3 つだけ
