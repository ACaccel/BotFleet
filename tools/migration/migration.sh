#!/usr/bin/env bash
# Bootstrap must remain usable before Node or project dependencies exist.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == bootstrap ]]; then
  shift
  exec bash "$SCRIPT_DIR/bootstrap.sh" "$@"
fi
command -v node >/dev/null || { echo 'ERROR: Node missing; run migration.sh bootstrap --help first.' >&2; exit 1; }
exec node "$SCRIPT_DIR/cli.mjs" "$@"
