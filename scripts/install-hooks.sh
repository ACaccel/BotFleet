#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(git -C "$repo_root" rev-parse --show-toplevel)" != "$repo_root" ]; then
  echo 'Run this installer from the BotFleet repository.' >&2
  exit 1
fi

target="$repo_root/.githooks"
existing=$(git -C "$repo_root" config --get core.hooksPath || true)
if [ -n "$existing" ]; then
  if [ "$existing" = "$target" ]; then
    echo 'BotFleet hooks are already installed.'
    exit 0
  fi
  echo "Existing core.hooksPath is configured: $existing" >&2
  echo 'Review the existing hooks before changing this setting.' >&2
  exit 1
fi

default_hooks=$(git -C "$repo_root" rev-parse --path-format=absolute --git-path hooks)
if [ -d "$default_hooks" ] && find "$default_hooks" -maxdepth 1 ! -type d ! -name '*.sample' | grep -q .; then
  echo "Existing hooks were found in $default_hooks." >&2
  echo 'Review them before installing the BotFleet hooks.' >&2
  exit 1
fi

for hook in pre-commit commit-msg pre-push; do
  if [ ! -x "$target/$hook" ]; then
    echo "Hook is not executable: $target/$hook" >&2
    exit 1
  fi
done

git -C "$repo_root" config --local core.hooksPath "$target"
echo "Installed BotFleet hooks from $target."
