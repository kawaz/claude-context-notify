---
title: hook が CLAUDE_PLUGIN_DATA 未到達時に setup の config 変更を無視する可能性
status: open
category: bug
created: 2026-09-19T17:31:37+09:00
last_read:
open_entered: 2026-09-19T17:31:37+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
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
