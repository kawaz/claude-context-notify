# claude-context-notify justfile
# canonical task runner は kawaz/bump-semver に準拠。
# このリポは plugin (hook script + 1 command) なので lint は JSON 妥当性 + python 構文 + frontmatter。

set shell := ["bash", "-euo", "pipefail", "-c"]

set script-interpreter := ["bash", "-euo", "pipefail"]

set positional-arguments

default: list

# show the recipe list
list:
    @just --list --unsorted

# JSON 妥当性 (plugin.json / marketplace.json / hooks.json / 既定 config)
[private]
lint-json:
    for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json hooks/hooks.json templates/config.json; do \
      jq empty "$f" && echo "ok: $f"; \
    done

# hook script の python 構文チェック
[private]
lint-py:
    for f in bin/*.py; do python3 -m py_compile "$f" && echo "ok: $f"; done

# commands/*.md に frontmatter (--- 開始) があるか
[private]
lint-commands:
    for f in commands/*.md; do head -1 "$f" | grep -qx -- '---' && echo "ok: $f" || { echo "NG frontmatter: $f"; exit 1; }; done

# 全 lint
lint: lint-json lint-py lint-commands

# ctx-notify.py の振る舞いテスト (= fixture transcript に対する latch マトリクス)
test: lint
    @bash test/run.sh

# CI entry (= 翻訳ペア freshness も含む)
ci: lint test check-outdated-translations

# translation pair freshness (bump-semver vcs outdated) — README の ja/en ペア
[private]
check-outdated-translations:
    if command -v bump-semver >/dev/null 2>&1; then \
      bump-semver vcs outdated 'glob:**/*-ja.md' '$1/$2.md'; \
    else echo "(skip: bump-semver not found)"; fi

# bump plugin version + release commit
# 版の正本は plugin manifest 2 つ (VERSION ファイルは持たない)。
# 2 file を同時に渡すことで、bump も get も両者の一致を検査する
# (食い違えば "version mismatch" で exit 1 = 片方だけ古い状態を commit できない)。
bump-version level="patch":
    bump-semver "$1" .claude-plugin/plugin.json .claude-plugin/marketplace.json --write --quiet
    bump-semver vcs commit -m "Release v$(bump-semver get .claude-plugin/plugin.json .claude-plugin/marketplace.json)" .claude-plugin/plugin.json .claude-plugin/marketplace.json

# fail with a sync→promote→push hint when the current bookmark / branch
# is not the default (DR-0038 adoption pattern, see bump-semver docs/decisions/DR-0038).
[private]
[script]
check-on-default-branch:
    if ! bump-semver vcs is on-default-branch; then
        bn=$(bump-semver vcs get default-branch)
        printf >&2 "⚠ default branch (%s) に合流してから push してください\n  1. just sync         # %s@origin に rebase\n  2. just promote      # %s bookmark を current commit に forward\n  3. %s ワークスペースに移動して just push\n" "$bn" "$bn" "$bn" "$bn"
        exit 1
    fi

# 現在の worktree を default branch (= origin/<default>) に rebase (DR-0038)
sync:
    bump-semver vcs sync --onto $(bump-semver vcs get default-branch)@origin

# default branch を現在の commit に forward (DR-0038、push しない)
promote:
    bump-semver vcs promote

# push with gates (= check-on-default-branch を最初に置いて、worktree 違いなら lint 等を回さず即終了)
push: check-on-default-branch ci
    bump-semver vcs push --branch main --jj-bookmark-auto-advance
    @just _local-plugin-update

# push 直後にこのマシンの plugin cache を新版へ (適用は各セッションで /reload-plugins)
[private]
_local-plugin-update:
    -claude plugin marketplace update context-notify
    -claude plugin update context-notify@context-notify
    @echo ""
    @echo "[hint] /reload-plugins to apply in this session without restart"
