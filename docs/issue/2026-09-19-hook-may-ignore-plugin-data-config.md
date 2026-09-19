
## 追記 (2026-09-19、0.6.1 で再確認)

0.6.x で設定は `${CLAUDE_PLUGIN_DATA}/autocompact-{on,off}.json` に変わったが、hooks.json の `measure` / `model` が data dir を引数で渡さず環境変数に頼る構造は同じ。加えて、`ctx-notify.py config` / `check` を data dir 無しで実行すると `~/.config/claude-context-notify/` に雛形 2 ファイルを**生成する**副作用がある (統括が 2 回踏んで手で削除)。hook が環境変数を得られない場合、同じ経路で XDG 側に雛形が生成され、data 側の設定が黙って無視される。
