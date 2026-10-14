# DR-0003: context 使用率の閾値通知を Claude Mods の hooks module で組み立てる

- Status: Active
- Date: 2026-10-14
- 実測環境: Claude Code 2.1.299 / macOS 25.5.0

## Context

長く回っているセッションほど、あと何割 context が残っているかを本人 (= 動いている Claude 自身) が把握できていない。使用率が閾値を跨いだ時点で、そのセッションへ「今どのくらい使っているか、そろそろ何をすべきか」を注入したい。配布できること (plugin 1 つで完結し、特定環境の proxy や別ツールに依存しないこと) を最優先にする。

auto compact が有効なセッションでは、高い帯の文面は「自分で畳め」ではなく「compact される前提で引き継ぎを書き出せ」であるべきで、無効なセッションでは compact 前提の文面が誤解を招く。plugin が知る必要があるのは有効か無効かだけで、auto compact が何 % で走るかは Claude Code 側の window 設定で決まる。その手前のどこに帯を置くかは利用者が決める。

Claude Code の plugin は Claude Mods (TypeScript の function hook、`hooks/hooks.json` の `modules`) を持てる。Mods 化の前提を 2.1.299 の隔離環境で実測した:

| 確かめたこと | 結果 |
|---|---|
| 使用量の取り方 | `turn.step` (model への 1 リクエスト) の `next(e)` が返った時点で、`$.session.usage()` の `context.tokens / window / percent` はその応答の値になっている。transcript の書き込みを待つ遅れが無い。subagent のリクエストには `e.agentId` が付く |
| window | `context.window` は model 名に `[1m]` が無い経路 (`/clear` 後、`-p` 起動) でも正しい window を返す |
| auto compact の有効 / 無効 | `$.session.usage({ breakdown: "summary" })` の `context.breakdown.isAutoCompactEnabled` が Claude Code 自身の判定を返す。数 ms で済む |
| `$.state` | `/clear` でも resume でも消える |
| `$.store` | session と reload を跨いで残る。plugin 専用の KV、全体で JSON 4 MiB まで |
| data dir | `$.plugin.root` が `<plugins>/cache/<marketplace>/<plugin>/<version>` のとき、`<plugins>/data/<plugin>-<marketplace>` が command hook に渡る `CLAUDE_PLUGIN_DATA` と一致する。`--plugin-dir` で読んだ時は root がこの形にならない |
| tool の結果への注入 | `tool.call` で `next(e)` の結果の `context` に足した文字列は、command hook の `additionalContext` と同じ reminder (transcript では `hook_additional_context`、`hookName: tool.call`) として model に届く |
| 会話への行の追加 | `$.session.append` で足した `type: "user"` の text の行は、transcript に `isMeta: true` の user 行として残り、画面には出ない。tool を呼ぶ応答の後に足すと tool の結果の直後に並び、次の tool の結果のリクエストで model が読む。tool を呼ばない応答の後に足すと、次のユーザ入力のリクエストで読む。継続ターンは起きない |
| ターンの始まりへの注入 | `prompt.submit` で `next({ ...e, context })` として足した文字列は、prompt の直後の reminder (`prompt.submit hook additional context: …`) として model に届き、transcript には `hook_additional_context` として残る。ユーザの発言にはならない。`prompt.submit` はユーザ入力に限らずターンを始める入力 (task-notification、別セッションからのメッセージ等) で発火する |
| 毎リクエストの attachment | `prompt.attachment` は attachment が作られる時だけ発火する。2 回目以降のリクエストで付いたのは `total_tokens_reminder` だけで、これは機能の設定次第で付かない。hook が書き換えた text は model に届くが transcript には残らない |
| subagent 内の tool 呼び出し | subagent の tool 呼び出しでも同じ module の `tool.call` が走り、`e.agentId` が付く (Bash も `SubagentHandback` も)。そこで返した通知は subagent に届く (`classic.PostToolUse` の `additionalContext` で確認した) |
| 並列の tool 呼び出し | 1 つの応答で並列に呼んだ tool の `tool.call` は並行に終わる (3 本が 12 ms 以内に settle) |
| command への注入 | plugin の `.md` (prompt 型) command では、`command.run` で `next(e)` の後に足した `context` は捨てられる (debug log: `a hook's own answer after next() dropped`)。`skill.prompt` で返した `text` は model が読む prompt そのものになる |
| model が呼べる tool | `$.tool.register` で `mcp__<plugin>__<name>` を足し、`tool.call` hook が `{ result }` を返せば、command の `allowed-tools` に書いて `-p` でも呼べる |
| npm パッケージ | hooks module が import できるのは自分のファイル (相対パス) と `claude-code` だけ。パッケージ名の import は `claude plugin validate` が拒む |
| テスト | `claude plugin test` で `tests/*.test.ts` が engine 上で走る。`../hooks/*.ts` の純粋関数を直接呼べ、hook も `$.turn.step(...)` / `$.tool.call(...)` 等で起こして、`$` の下 (`fs.*` / `session.usage` / `session.id` / `turn.step` / `session.append` / `tool.call` / `mock.store` / `mock.clock` / `mock.env`) をテストが答えられる |
| 組織管理下 | `claude plugin validate` の注記: managed settings のある機械では、利用者が自分で入れた plugin の `classic.*` / `skill.prompt` hook は走らない (組織が managed settings に載せた plugin だけが走らせる)。`turn.step` / `tool.call` / `session.start` と `$.session.append` はこの注記の対象に入らない |

## Decision

### 1. 実装は hooks module 1 本

`hooks/hooks.json` は `{ "modules": ["./register.ts"] }` だけにする。`hooks/register.ts` が hook の配線と `$` を通した入出力を持ち、判定 (通知リストの読み取り、帯の解決、latch の移動、文面の展開、data dir の組み立て) は `$` に触れない `hooks/notify.ts` に置く。依存は Claude Code 本体だけで、外部コマンドを起動しない。

**statusline は使わない。** `context_window.used_percentage` を完成品で持つが、plugin の `settings.json` で配れず、利用者自身の statusline を奪う。**外部 proxy も使わない。** その proxy を持たない環境では何も動かない。

### 2. main loop の応答ごとに測り、跨いだらその場で会話に 1 行足す

`turn.step` で `next(e)` (model の応答) が返った後に `$.session.usage()` を呼び、帯を上に跨いだら `$.session.append({ message: { type: "user", content: [{ type: "text", text }] } })` で `[context-notify] <文面>` の 1 行を会話に足す。人には見えず model が読む行として保存され、以後のリクエストに乗る。

- 閾値の判定は `context.percent` (engine が四捨五入した整数) で行う。`tokens` か `percent` が無い時 (live window の最初の応答の前、compact 直後) は何もしない。latch も動かさない
- window は `context.window` をそのまま使う
- `e.agentId` がある (subagent の loop の) 応答は測らない。測る値は main の context のもので、通知を足すのも main の会話だけ
- append が `{ deny }` (他の plugin が拒んだ) の時は latch を動かさない。次の応答で同じ帯をもう一度足しにいく。latch だけ進めて文面を捨てると、その帯は二度と知らされない
- 計測は module 内で 1 本ずつ直列に走らせる。並行した計測が同じ latch を読んで同じ帯を 2 回足さないため
- hook は registration の `.catch` を持つ。計測が失敗しても応答には何も足さず、下の hook の答えをそのまま返す

**応答の終わりに継続ターンを起こさない。** 足した行は次に起きるリクエストで読まれる。tool を呼ばない応答で帯を跨いだ分は、次のターンの始まりで読まれる。

**`UserPromptSubmit` は使わない。** 外部注入や別セッションからのメッセージが起点のターンでは発火しない経路があり、通知をこれに依存すると落ちる。

**compact 専用の通知は持たない。** compact で使用量が下がれば下記 3 の規則で latch が黙って戻り、次に帯を跨いだ時に通常の通知が出る。

### 3. latch は `$.store` に session 別に 1 個持ち、上がった時だけ喋る

キー `session:<session id>`、値 `{ band, updatedAt }` (`updatedAt` は `$.clock.now()` の ms)。

- latch が無ければ -1 から始める。latch が無い = このセッションでまだ測っていない、なので `used_percent: 0` の帯は最初の計測で 1 回だけ跨ぐ
- 帯 = 到達した閾値のうち最も高いもの (どの閾値にも届かなければ 0)。帯が latch と同じなら何もしない
- 上がって閾値に入った時だけ喋る。2 段飛んだ時 (20% → 45%) は到達した最上位の帯だけを喋る
- **下がった時は黙って latch を戻す。** compact / clear で使用量は下がる。「一度撃ったら二度と撃たない」にすると compact 後に鳴らなくなり、下がったことを喋ると compact 直後に無意味な通知が出る
- `updatedAt` は最後に計測した時刻を表す。帯が変わった時に書き、帯が同じままでも前回の `updatedAt` から 1 日以上経っていれば書き直す (計測のたびに store へ書かないため)
- `session.start` で、`updatedAt` が 30 日より前のキー (と形の読めないキー) を消す。`$.store` は全体で 4 MiB までなので、終わった session の latch を溜め続けない。30 日以上計測の無かった session を後で resume すると、latch が消えていて通知済みの閾値をもう一度喋る

**`$.state` は使わない。** `/clear` でも resume でも消えるので、resume した session が通知済みの閾値をもう一度喋ってしまう。

### 4. auto compact の有効 / 無効は engine に訊く

計測のたびに `$.session.usage({ breakdown: "summary" })` を呼び、`context.breakdown.isAutoCompactEnabled` で判定する (使用量も同じ呼び出しから取る)。breakdown が取れない時は有効として扱う (Claude Code の既定が有効なので、そちら向けの文面のほうが外れが少ない)。settings ファイルや env を plugin 側で読んで推測しない。

### 5. 利用者が編集するのは data dir の通知リスト 2 ファイルだけ

| ファイル | 使われる時 |
|---|---|
| `autocompact-on.json` | auto compact が有効 |
| `autocompact-off.json` | auto compact が無効 |

形式は `{"version": <整数>, "notifications": [{"used_percent": <0〜100 の整数>, "message": "<文面>"}, ...]}`。

- `version` は形式そのもののバージョン (現行 1)。一致しなければ check が知らせるが、**自動移行も上書きもしない**。利用者が書いた文面を plugin が書き換えないという性質のほうが、移行の手間より重い。hook は `notifications` を読める範囲で使い続ける
- 同じ `used_percent` を複数書いてよい。その文面はファイル内の順序で改行連結され、帯を跨いだ 1 回の通知としてまとめて出る
- 文面のプレースホルダは `{used_tokens}` / `{used_percent}` / `{available_tokens}` / `{available_percent}` / `{window_tokens}` の 5 つ。`available_percent` は `100 - used_percent`。プレースホルダは `{identifier}` の形だけで、それ以外は文字どおりに残る。**綴りを間違えたプレースホルダは hook では例外にせず、そのまま文字として残す** (設定ミスでセッションの hook が毎回落ちるほうが害が大きい)
- どちらのファイルが読まれるかは判定結果だけで決まり、利用者が指定する余地は持たない。片方に固定したい利用者は 2 ファイルを同じ内容にすればよい
- 同梱テンプレの帯は on が 20/40/60/80/90、off が 20/40/60/80/90/95/97。off 側は auto compact が走らないので、高い帯で引き継ぎの準備と、ユーザに `/compact` を頼むことを促す

置き場は plugin data dir (plugin を更新しても消えない):

- `$.plugin.root` が `<plugins>/cache/<marketplace>/<plugin>/<version>` の形なら `<plugins>/data/<plugin>-<marketplace>`
- 形に合わない時 (`--plugin-dir` で読んだ時) は、`<plugins>` を `CLAUDE_CODE_PLUGIN_CACHE_DIR`、無ければ `<CLAUDE_CONFIG_DIR>/plugins`、無ければ `<HOME>/.claude/plugins` とし、`<plugins>/data/<plugin>-inline`

`session.start` と `/context-notify:config` で、無いファイルを同梱の `templates/<name>.json` から作る。**既存ファイルは決して上書きしない。** 読めない・使える行が 1 つも無い時は同梱テンプレで動く。data dir が書けない環境でも同梱テンプレを読んで動作を続ける。

### 6. 設定の入口は `/context-notify:config` 1 本、検証は tool が機械的に行う

`commands/config.md` は model 向けの手順書のまま残す。引数が無ければ 2 ファイルのパスと、このセッションに適用される側の中身をそのまま見せる (整形一覧を挟まないので、読んだテキストがそのまま編集対象になる)。引数があれば model が要望どおりに書き換えてから検証する。

- 見せる素材は invoke 時に埋め込む。`skill.prompt` を `{ skill: "context-notify:config" }` で hook し、展開された prompt の末尾に `<context-notify-report>` ブロック (2 ファイルのパス、auto compact の有効 / 無効、使う側、2 ファイルの検証結果、使う側の中身) を足す。model が素材を取りに行く往復を挟まない
- 編集後の検証は model の目視ではなく、`$.tool.register` で足す `mcp__context-notify__check` が行う。JSON の妥当性、version、閾値が 0〜100 の整数、各行に文面がある、プレースホルダの綴り。問題を文で返し、model は通るまで直す
- 埋め込む報告と check の答えは同じ純粋関数 (`report`) が作る。違いは使う側の中身を付けるかどうかだけ
- 埋め込みが届かない環境 (下記 Consequences の組織管理下) 向けの別経路は持たない。経路が 2 本あると手順書が分岐して読みにくくなる

### 7. 外から来るデータは境界で手書きの parse を通す

通知リストの JSON と `$.store` の latch 値は、読み込む関数 (`readList` / `readLatch`) の中で型を確かめてから型付きの値にする。それより内側は型付きの値だけを扱う。`as` (`as const` を除く)・`any`・非 null の主張は使わない。

スキーマライブラリは使わない。hooks module はパッケージ名を import できないので、使うには第三者のコード (valibot で約 85 KB) とそのライセンス表記・更新の負担をこのリポに持ち込むことになる。parse する形は小さな 2 つだけで、得るものが釣り合わない。

### 8. テストは `claude plugin test`

判定の純粋関数 (帯の解決、帯の判定、latch の遷移、文面の展開、通知リストの検証、data dir) は `tests/notify.test.ts` で直接呼ぶ。hook の振る舞い (応答で測って 1 回だけ足す、subagent、append の拒否、未計測、並行した計測、リストの選択、テンプレからの作成、latch の掃除、config の埋め込みと check) は `tests/register.test.ts` で engine に hook を起こさせ、`$` の下をテストが答える。

## Alternatives Considered

- **command hook (外部スクリプト) のまま**: 使用量を transcript から読むと、書き込みが非同期なので応答の終わりの時点でそのターンの行がまだ無いことがある。window を model 名の `[1m]` から推すと `/clear` や `-p` の起動で外れ、auto compact の有効 / 無効を settings ファイルから推すと Claude Code 自身の判定とずれうる。Mods なら 3 つとも engine の値をそのまま読める
- **statusline から `used_percentage` を読む**: plugin で配れない (上記 1)
- **`classic.PostToolUse` / `classic.Stop` で測る**: managed settings のある機械では、利用者が入れた plugin の `classic.*` hook が走らない (Context の validate の注記)。`Stop` から喋ると継続ターンが 1 本起きる
- **tool の呼び出しで測り、`tool.call` の `context` だけで配る**: tool を呼ばない応答で跨いだ分が、次に tool を呼ぶまで届かない
- **未配達の通知を latch に持ち、`prompt.submit` と `tool.call` の `context` の 2 口で次のリクエストに添える**: 口が 2 本になり、slash command・drop・拒否された呼び出しの扱いがそれぞれに要る。append なら足す場所は 1 か所で、取り置きも要らない
- **`prompt.attachment` に相乗りする**: 毎リクエスト付く attachment が無く、書き換えた text は transcript に残らない (Context の実測)。validate も組織管理下で走らない hook に挙げる
- **帯の高さで即時 / 相乗りを出し分ける**: 相乗りが要らないなら出し分けも要らない
- **`UserPromptSubmit` で通知を足す**: 外部注入や別セッションからのメッセージが起点のターンでは発火しない経路がある
- **`PreCompact` で compact を知らせる**: latch の巻き戻しだけで足りる
- **latch を `$.state` に置く**: `/clear` と resume で消え、通知済みの閾値を再通知する
- **`command.run` で config の素材を `context` に足す**: prompt 型 command では捨てられる (Context の実測)
- **config の素材を tool で渡す (手順の 1 で model が check を呼ぶ。単独でも、埋め込みが無い時の退避としても)**: invoke のたびに往復が 1 回増え、退避として持つと手順書が分岐する
- **スキーマライブラリを vendoring する**: 上記 7

## Consequences

- 依存は Claude Code の Mods だけ。proxy / 外部サービス / statusline / 外部コマンドを要求しない
- managed settings のある機械では、利用者が自分で入れたこの plugin の `skill.prompt` hook は走らず、`/context-notify:config` に報告が埋め込まれない。通知と check tool は動く。config まで使うには組織が managed settings に載せる必要がある
- 使用量は直前の応答の input 側 (uncached + cache 書き込み + cache 読み出し) で、これから送るリクエストの分は含まない。閾値通知の用途では実害が無い
- 1M window では ~96.7% で auto compact が走るため、既定の 97% 帯は auto compact とほぼ同着になる。本人が自分で畳むための実効的な最終警告は 95% 帯
- どの % で auto compact が走るかは plugin からは見ない。発火点の手前で鳴らしたい利用者は自分で `used_percent` を調整する
- 有効時と無効時で同じ文面を使いたい利用者は、2 ファイルを揃える手間を負う
- 型定義は engine が mod を読み込む時に `.claude-plugin/types/` へ書き出すもの (git 管理外) を使う。`just lint` の型検査はこれが無いと失敗する

## 関連

- Claude Code 同梱の型定義 (`.claude-plugin/types/claude-code/index.d.ts`、engine が書き出す)
