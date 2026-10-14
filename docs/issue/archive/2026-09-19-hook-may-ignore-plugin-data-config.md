---
title: hook が CLAUDE_PLUGIN_DATA 未到達時に setup の config 変更を無視する可能性
status: resolved
category: bug
created: 2026-09-19T17:31:37+09:00
last_read:
open_entered: 2026-09-19T17:31:37+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-19T17:49:28+09:00
discard_reason:
pending_reason:
close_reason: ["done:該当せず。claude v2.1.272 は CLAUDE_PLUGIN_ROOT を付ける同じ分岐で CLAUDE_PLUGIN_DATA も plugin hook に渡す（届かないのは settings.json 直書き hook と skill hook のみ）。fa130b5 以降は hook/command とも同じ data dir 解決 (CLAUDE_PLUGIN_DATA → XDG fallback) を通る"]
blocked_by:
origin: sandbox-jev
---

# hook が CLAUDE_PLUGIN_DATA 未到達時に setup の config 変更を無視する可能性

## 概要

hooks.json の `measure` / `model` は data dir を引数で渡さず環境変数
`CLAUDE_PLUGIN_DATA` だけに頼っている一方、commands/setup.md の `config` /
`check` は `"/Users/kawaz/.claude-personal/plugins/data/local-issue-local-issue"`
を引数で明示している。

`CLAUDE_PLUGIN_DATA` が hook プロセスに渡ることは claude-plugin-reference でも
spec 記載のみで実機検証の印が無く、plugins/data/ 配下に hook が書いた痕跡を持つ
plugin も見当たらない。

渡っていない場合、hook は `~/.config/claude-context-notify/config.json` に
フォールバックして雛形を生成し、setup skill で編集した data 側の config.json
(bands / profile) は黙って無視される (= ユーザの設定変更が効かない)。

## 背景

観測: sandbox-jev セッション 2026-09-19 で data dir を渡さずに
`ctx-notify.py config` を実行したところ XDG 側に雛形が新規作成された
(hook と同じ経路)。

提案 (フラグ止まり、裏取りして採否を決めて):

- (a) hooks.json でも
  `"/Users/kawaz/.claude-personal/plugins/data/local-issue-local-issue"`
  を引数で渡して環境変数依存を無くす
- (b) `measure` が実際に読んだ config のパスを state か stderr に残して
  観測可能にする
- (c) `check` は `CLAUDE_PLUGIN_DATA` 不在時に警告する

実機で `CLAUDE_PLUGIN_DATA` が渡っていれば (a) は不要だが、reference に
[実機検証済] を付けられる。

## 受け入れ条件

- [ ] hook プロセスに `CLAUDE_PLUGIN_DATA` が実際に渡っているか実機検証する
- [ ] 渡っていない場合、hooks.json への data dir 明示引数化などの対処を決定する
- [ ] setup 側で編集した config が hook 側で確実に読まれることを確認する

## 追記 (2026-09-19、0.6.1 で再確認)

0.6.x で設定は `${CLAUDE_PLUGIN_DATA}/autocompact-{on,off}.json` に変わったが、hooks.json の `measure` / `model` が data dir を引数で渡さず環境変数に頼る構造は同じ。加えて、`ctx-notify.py config` / `check` を data dir 無しで実行すると `~/.config/claude-context-notify/` に雛形 2 ファイルを**生成する**副作用がある (統括が 2 回踏んで手で削除)。hook が環境変数を得られない場合、同じ経路で XDG 側に雛形が生成され、data 側の設定が黙って無視される。

## 解消 (2026-10-14)

Claude Mods での再実装 (DR-0003) で、data dir は mod が `$.plugin.root` から組み立てるようになり、環境変数に頼る経路と XDG への fallback (雛形を生成する副作用を含む) は無くなった。
