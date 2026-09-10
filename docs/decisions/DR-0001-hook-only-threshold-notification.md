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

### 2. 測定は 3 event、話すのは 2 event

`Stop` / `PostToolUse` / `UserPromptSubmit` の **3 event すべてで測る**。
公式 docs が `transcript_path` を "written asynchronously, may lag" と明記しており、
実際 `Stop` 時点でそのターンの assistant 行がまだ無いことがある (1 往復 `claude -p` の
4 回中 3 回が空振り)。3 event で測れば、Stop が空振りしても次のターン頭が拾う。
measure は state を進めるだけなので多重に走っても無害 (`band == prev` で黙る)。

話すのは `PostToolUse` / `UserPromptSubmit` だけ。跨ぎを state の `pending` に積んでおき、
次にモデルが動くときに配ることで、**通知のためだけのリクエストを 1 本も増やさない**。

起点別の実測では、`UserPromptSubmit` と `Stop` は TUI の入力・外部注入・別セッションからの
メッセージ・background task 完了・cron・wakeup のどの起点でも必ず発火する。
取りこぼすのは `PostToolUse` (tool を使わないターン) だけなので、穴は無い。

### 3. urgent 帯 (既定 90% 以上) だけ Stop から即時に出す

この場合だけ継続ターンが 1 本増えるが、残り 10% を切ってから次のターンまで黙っている
ほうが害が大きい。無限ループは `stop_hook_active` で止まる (継続ターンの `Stop` には
必ず `true` が来る)。

**`decision: "block"` ではなく `additionalContext` を使う**。届き方も継続ターンの起き方も
同じだが、`block` は「turn を止めて理由を伝える」意味論で hook error 相当の扱いと
隣接する。使用率の報告はエラーではない。加えて blocking Stop hook は
「block 直後のターンで reasoning を失わせ prompt cache を外す」不具合を持っていた経緯が
あり (v2.1.259 で修正)、副作用を持ちうる経路だった裏づけになる。

### 4. window は `SessionStart` / `PostModelSwitch` からしか取れない

transcript の `message.model` も upstream へ出るリクエストの `model` も `[1m]` を
落として `claude-opus-5` になる。`[1m]` を保っているのはこの 2 event の model 欄だけ。
`model` 役の hook がこれを state に書き、測定側が読む。

3 段のフォールバック: `CLAUDE_CONTEXT_WINDOW_TOKENS` env → state の記録値 → 200,000。
公式が「`model` 欄は always ではない」と書いており、実際 `claude -p` では来なかったため
既定値を残す。

### 5. latch は band を 1 個だけ持ち、上がった時だけ喋る

`$XDG_STATE_HOME/claude-context-notify/<session_id>.json` に `band` (latch) と
`pending` (未配達の文面) を持つ。

**下がったら黙って latch を戻す。** compact / clear で使用量は下がるので、
「一度 80% を撃ったら二度と撃たない」にすると compact 後に鳴らなくなる。逆に
下がったことを喋ると compact 直後に無意味な通知が出る。`PreCompact` / `PostCompact` で
明示リセットもできるが、この規則だけで両方を吸収できるので配線しない。

2 段飛んだとき (20% → 45%) は到達した最上位の band だけを撃つ。

### 6. 閾値と文面はユーザ設定

`${CLAUDE_PLUGIN_DATA}/config.json` (plugin update で保持される) に置き、無ければ
同梱の `templates/config.json` を既定として読む。形式は JSON — python 標準ライブラリ
だけで読め、`jq` で lint できる。

編集の入口は 2 本に分ける。`/context-notify:config` は**ユーザ専用**
(`disable-model-invocation: true`) で、初回の複製とパス表示だけを担い編集はしない。
`/context-notify:setup [自由文]` は**モデルが編集する**入口で、要望どおりに書き換えてから
検証する (組み込みの `statusline-setup` / `update-config` と同じ「設定をエージェントに
編集させる」型)。

**検証はモデルの目視ではなく `ctx-notify.py check` が機械的に行う** — JSON の妥当性、
閾値が 1〜100 の整数で昇順・重複なし、各帯に文面がある、プレースホルダの綴りが
`{pct}` / `{used}` / `{window}` のいずれか。散文で「確認せよ」と書くより、
非ゼロ終了で押し返せるほうが確実。

なお **綴りを間違えたプレースホルダは hook 側では例外にしない** (そのまま文字として
残す)。設定ミスでセッションの hook が毎回落ちるほうが害が大きい。

## Alternatives Considered

- **statusline から `used_percentage` を読む**: 数値は最も正確 (window も完成品) だが
  plugin で配れない (上記 1)
- **`Stop` だけで測る**: transcript の遅延で取りこぼす (上記 2)
- **通知専用のターンを起こす**: 毎回リクエストが 1 本増える。urgent 帯以外は
  「どうせ起きるターン」に相乗りさせれば足りる
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
