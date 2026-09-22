#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mongo_prefix="${1:-}"
if [[ $# != 1 || "$mongo_prefix" != /* ]]; then
  echo 'Usage: bash scripts/setup-mongo.sh /absolute/mongodb-runtime-prefix' >&2
  exit 1
fi
if [[ -f "$project_root/.deploy/mongodb.json" || -e "$project_root/.deploy/transaction.json" || -e "$project_root/.deploy/lock" ]]; then
  echo 'Finish or recover pending deployments and remove the managed MongoDB service before changing its runtime.' >&2
  exit 1
fi
for process_exe in /proc/[0-9]*/exe; do
  executable="$(readlink "$process_exe" 2>/dev/null || true)"
  if [[ "$executable" == "$mongo_prefix/"* ]]; then
    echo 'Stop processes using this MongoDB runtime before updating it.' >&2
    exit 1
  fi
done
conda_command="${CONDA_EXE:-$(command -v conda || true)}"
if [[ -z "$conda_command" || ! -x "$conda_command" ]]; then
  echo 'Set CONDA_EXE to the Conda executable and retry.' >&2
  exit 1
fi
if [[ -d "$mongo_prefix/conda-meta" ]]; then
  "$conda_command" env update --prefix "$mongo_prefix" --file "$project_root/environments/mongodb.yml" --prune
else
  "$conda_command" env create --prefix "$mongo_prefix" --file "$project_root/environments/mongodb.yml" --yes
fi
export PATH="$mongo_prefix/bin:$PATH"
unset NODE_PATH npm_config_prefix NPM_CONFIG_PREFIX
"$mongo_prefix/bin/node" "$mongo_prefix/lib/node_modules/npm/bin/npm-cli.js" install --global --prefix "$mongo_prefix" mongosh@2.10.0 --no-audit --no-fund
for tool in mongod mongodump mongorestore mongosh; do
  "$mongo_prefix/bin/$tool" --version
done
