# 退避した Decision Records

後続の DR に置き換えられた DR。各ファイルの `Status: Superseded by DR-NNNN` が正本で、現役の文書からはここも各ファイルも名指ししない (置き換え先を指す)。

| DR | 説明 | 置き換え先 |
|---|---|---|
| [DR-0001](DR-0001-hook-only-threshold-notification.md) | context 使用率の通知を command hook だけで組み立てる (transcript から使用量、model 名から window、latch はファイル) | [DR-0003](../DR-0003-mods-implementation.md) |
| [DR-0002](DR-0002-autocompact-notification-lists.md) | 通知リスト 2 ファイルを auto compact の有効 / 無効で選ぶ (有効 / 無効は env と settings ファイルから推定) | [DR-0003](../DR-0003-mods-implementation.md) |
