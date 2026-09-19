# DR-0001: context 使用率の通知は hook だけで組み立てる

- Status: Active
- Date: 2026-09-10

## Context

長く回っているセッションほど、あと何割 context が残っているかを本人 (= 動いている
Claude 自身) が把握できていない。使用率が閾値を跨いだ時点で、そのセッションへ
「今どのくらい使っているか、そろそろ何をすべきか」を注入したい。

配布可能であることを最優先にする。特定環境の proxy や別ツールに依存すると、
その環境の外では動かない。

一次調査は llm-gateway リポの
`docs/research/2026-09-10-context-usage-notification.md` (実機確定、Claude Code v2.1.267)。

## Decision

### 1. hook だけで完結させる (statusline / 外部 proxy を使わない)

必要な部品は 3 つとも hook の届く範囲に揃っている:

| 部品 | 取得元 |
|---|---|
| 使用量 | `transcript_path` の最後の非 sidechain assistant 行の `usage` 3 欄の和 |
| window | `SessionStart` の `model` / `PostModelSwitch` の `to_model` (`[1m]` 付き) |
| 注入 | hook stdout の `hookSpecificOutput.additionalContext` |

**statusline は不採用**。`context_window.used_percentage` を完成品で持っていて数値は
最も正確だが、plugin の `settings.json` は `agent` と `subagentStatusLine` の 2 key しか
サポートしないため **plugin として配れない**。ユーザ自身の statusline を奪うことにもなる。

**外部 proxy 経由も不採用**。`anthropic-beta` ヘッダから window を確実に判定できる利点は
あるが、その proxy を持たない環境では何も動かない。

### 2. `Stop` と `PostToolUse` で測り、跨いでいればその場で喋る

配線する測定 event は `Stop` と `PostToolUse` の 2 つ。どちらの役も同じで、使用量を測って
latch を動かし、**帯を上に跨いだならその場で `additionalContext` を出す**。

2 event で測るのは transcript の遅延を吸収するため。公式 docs が `transcript_path` を
"written asynchronously, may lag" と明記しており、実際 `Stop` 時点でそのターンの
assistant 行がまだ無いことがある (1 往復 `claude -p` の 4 回中 3 回が空振り)。
Stop が空振りしても次のターンの `PostToolUse` が拾う。多重に走っても無害
(`band == prev` で黙る)。

**キューを持たず即時に出す。** `Stop` から喋ると継続ターンが 1 本起きるが、そのターンが
読む prefix は既に prompt cache に載っているため、跨ぎ 1 回あたりのコストは cache read と
数十 token の write に収まる (実測)。この値段なら「どうせ起きる次のターンに相乗りさせる」
機構を持つ意味が無く、帯ごとの出し分けも要らない。無限ループは `stop_hook_active` で
止まる (継続ターンの `Stop` には必ず `true` が来るので、その回は測るだけで喋らない)。

**`UserPromptSubmit` は使わない。** 外部注入・別セッションからのメッセージのような起点の
ターンでは発火しない経路があり、配達をこれに依存すると通知が落ちる。即時に出す設計では
そもそも配達役が要らない。

**`decision: "block"` ではなく `additionalContext` を使う**。届き方も継続ターンの起き方も
同じだが、`block` は「turn を止めて理由を伝える」意味論で hook error 相当の扱いと
隣接する。使用率の報告はエラーではない。加えて blocking Stop hook は
「block 直後のターンで reasoning を失わせ prompt cache を外す」不具合を持っていた経緯が
あり (v2.1.259 で修正)、副作用を持ちうる経路だった裏づけになる。

### 3. compact 専用の通知は持たない

`PreCompact` は配線しない。compact で使用量が下がれば、下がった時に黙って latch を戻す
既定の規則 (下記 5) がそのまま効き、次に帯を跨いだ時に通常の通知が出る。compact が
起きたこと自体は本人が読む文脈からも分かるので、専用の文面を積むためだけに event を
1 つ増やす理由が無い。

### 4. window は model 名・プロセス単位の記録・env の 3 系統から解決する

model 名から取れるのは `SessionStart` / `PostModelSwitch` の model 欄だけ。transcript の
`message.model` も upstream へ出るリクエストの `model` も `[1m]` を落として
`claude-opus-5` になる。`model` 役の hook がこれを state に書き、測定側が読む。

ただし **model 欄は必ず来るわけではない**。`/clear` の SessionStart (`source: "clear"`)
と `claude -p` の起動では payload に `model` が無い (実測、v2.1.272。`compact` 由来は
`mainLoopModel` を渡すので有る)。model 欄だけに頼ると 1M セッションが 200k 換算になり、
使用率が実際の 5 倍で通知される。

解決の優先順位:

1. `CLAUDE_CONTEXT_WINDOW_TOKENS` env (明示上書き)
2. payload の `model` / `to_model` の `[1m]`
3. **同じ claude プロセスが直前に記録した window**。`/clear` は同一プロセス内で
   session_id だけを差し替えるので、hook の env に届く `CLAUDE_PID` をキーに
   `<state dir>/by-pid/<pid>.json` へ window を控えておけば引き継げる。書き込みのついでに
   生存していない pid の記録を掃除する。`CLAUDE_PID` が無い環境ではこの段を飛ばす
4. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` env。Claude Code 本体が「model 名から window を
   判定できない場合に context window とみなす」変数なので、これを設定したセッションは
   本体と同じ数値で測ることになる
5. 200,000 (既定)

測定側 (`window_for()`) も同じ順序で解決する。3 はファイル 1 本の read、4 は env の
read だけなので、event ごとに走らせても問題にならない。

### 5. latch は band を 1 個だけ持ち、上がった時だけ喋る

`$XDG_STATE_HOME/claude-context-notify/<session_id>.json` に `band` (latch) を持つ
(検出した auto compact の有無も同じファイル)。

**下がったら黙って latch を戻す。** compact / clear で使用量は下がるので、
「一度 80% を撃ったら二度と撃たない」にすると compact 後に鳴らなくなる。逆に
下がったことを喋ると compact 直後に無意味な通知が出る。`PreCompact` / `PostCompact` で
明示リセットもできるが、この規則だけで両方を吸収できるので配線しない。

2 段飛んだとき (20% → 45%) は到達した最上位の band だけを撃つ。

### 6. 閾値と文面はユーザ設定

`${CLAUDE_PLUGIN_DATA}` (plugin update で保持される) に置く通知リスト 2 ファイルが
正本で、無ければ同梱の `templates/<name>.json` を複製する (構成は DR-0002)。形式は
JSON — python 標準ライブラリだけで読め、`jq` で lint できる。

編集の入口は 2 本に分ける。`/context-notify:config` は**ユーザ専用**
(`disable-model-invocation: true`) で、初回の複製とパス表示だけを担い編集はしない。
`/context-notify:setup [自由文]` は**モデルが編集する**入口で、要望どおりに書き換えてから
検証する (組み込みの `statusline-setup` / `update-config` と同じ「設定をエージェントに
編集させる」型)。

**検証はモデルの目視ではなく `ctx-notify.py check` が機械的に行う** — JSON の妥当性、
閾値が 1〜100 の整数で昇順・重複なし、各帯に文面がある、プレースホルダの綴りが
`{used_tokens}` / `{used_percent}` / `{available_tokens}` / `{available_percent}` /
`{window_tokens}` のいずれか。散文で「確認せよ」と書くより、
非ゼロ終了で押し返せるほうが確実。

なお **綴りを間違えたプレースホルダは hook 側では例外にしない** (そのまま文字として
残す)。設定ミスでセッションの hook が毎回落ちるほうが害が大きい。

## Alternatives Considered

- **statusline から `used_percentage` を読む**: 数値は最も正確 (window も完成品) だが
  plugin で配れない (上記 1)
- **`Stop` だけで測る**: transcript の遅延で取りこぼす (上記 2)
- **`pending` キューに積んで次のターンに相乗りさせる**: 継続ターンを 1 本節約するための
  機構だが、その 1 本は cache read + 数十 token でしかない (上記 2)。通知が遅れるうえ、
  配達役の event を配線し続ける必要がある
- **帯の高さで即時 / 相乗りを出し分ける (`urgent_from`)**: 相乗りが要らないなら
  出し分けも要らない。閾値が 1 個増えるだけ設定が難しくなる
- **`UserPromptSubmit` を配達に使う**: 外部注入や別セッションからのメッセージが起点の
  ターンでは発火しない経路がある (上記 2)
- **`PreCompact` で compact を知らせる**: latch の巻き戻しだけで足りる (上記 3)
- **latch を「一度撃ったら二度と撃たない」にする**: compact 後に鳴らなくなる (上記 5)
- **設定を TOML にする**: `tomllib` は読み取り専用で 3.11+ 必須。JSON なら書き戻しも
  lint も標準の範囲で済む

## Consequences

- 依存は python3 のみ。proxy / 外部サービス / statusline を要求しない
- 使用量は構造上 **1 リクエスト遅れ**の値になる (直前のリクエストで送った prompt 長)。
  閾値通知の用途では実害が無い
- 1M window では ~96.7% で auto-compact が走る (v2.1.247 以降) ため、既定の 97% 帯は
  auto-compact とほぼ同着になる。本人が自分で畳むための実効的な最終警告は 95% 帯
- hook 1 回あたり ~76 ms (大半が python の起動時間)。`PostToolUse` ごとに走らせても
  体感には出ない

## 関連

- llm-gateway `docs/research/2026-09-10-context-usage-notification.md` — 実機調査の一次記録
- https://code.claude.com/docs/en/hooks — hook event の一次情報 (2026-09-10 取得)
