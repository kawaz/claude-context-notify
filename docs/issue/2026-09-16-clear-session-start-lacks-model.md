---
title: /clear 起点のセッションで使用率が実際の5倍 (200k換算) で通知される
status: open
category: bug
created: 2026-09-16T09:29:10+09:00
last_read:
open_entered: 2026-09-16T09:29:10+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# /clear 起点のセッションで使用率が実際の5倍 (200k換算) で通知される

## 概要

`/clear` 起点のセッションで使用率が実際の 5 倍 (200k 換算) で通知される。

## 背景

原因: claude 本体 (v2.1.272 で確認) の `/clear` は SessionStart hook を
`source=clear` で呼ぶが、その呼び出し `bj(session,"clear",{signal,storageV5,credentials})`
は `model` を渡さず payload に `model` フィールドが乗らない (compact 由来は
`{model: options.mainLoopModel}` を渡す。`claude -p` headless 起動でも同様に
`model` 欠落を実測)。

plugin 側は `remember_window()` が model 不在だと `window` を state に書かず、
`window_for()` が `DEFAULT_WINDOW = 200_000` に黙って倒す。

実例: セッション b41368f0 (ccmsg main、SessionStart:clear) で
`45% (90,927 / 200,000 tokens)` と通知されたが実 window は 1M なので約 9%。
state ファイル 36 件中 window 記録があるのは対話 startup の 3 件のみ。

修正候補:

- (a) 同一プロセス内の /clear なので直前セッションの window を引き継ぐ
  (payload に旧 session_id は無いのでプロセス単位 state が要る)
- (b) settings.json の `model` (`opus[1m]` 等) をフォールバックに使う
- (c) window 不明を明示し %表示をやめて used tokens だけ通知する

DR-0001 §4「window は SessionStart / PostModelSwitch からしか取れない」の
前提更新も同時に要る。

## 受け入れ条件

- [ ] `/clear` 起点セッションで window (1M 等) が正しく反映される、または
      window 不明時に誤った %表示をしない
- [ ] DR-0001 §4 の前提が更新される

## TODO

<!-- wip 時のみ -->
