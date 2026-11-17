#!/usr/bin/env bash
set -euo pipefail

: "${BBI_FORK_REPOSITORY:?Set the fork repository as owner/repo}"
upstream_url='https://github.com/baibai-git/ST-BaiBai-Image.git'

git fetch --no-tags "$upstream_url" main
if git merge-base --is-ancestor FETCH_HEAD HEAD; then
  exit 0
fi

if ! git merge --no-ff --no-commit FETCH_HEAD; then
  # Only replace generated artifacts. Source conflicts keep the installed release available.
  git rev-parse --verify MERGE_HEAD >/dev/null
  while IFS= read -r -d '' file; do
    case "$file" in
      dist/index.css|dist/index.js|dist/index.js.map|manifest.json)
        git checkout --theirs -- "$file"
        git add -- "$file"
        ;;
      *)
        printf 'Upstream source conflict in %s\n' "$file" >&2
        exit 1
        ;;
    esac
  done < <(git diff --name-only --diff-filter=U -z)
fi

pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
previous_version="$(git show HEAD:manifest.json | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"
upstream_version="$(node -p 'require("./package.json").version')"
previous_base="${previous_version%-retention.*}"
export BBI_FORK_BUILD=1
if [[ "$previous_version" != "$previous_base" && "$previous_base" == "$upstream_version" ]]; then
  previous_build="${previous_version##*-retention.}"
  BBI_FORK_BUILD="$((previous_build + 1))"
fi
pnpm build
git add -- dist manifest.json
git commit -m 'Merge and build upstream BaiBai Image update'
