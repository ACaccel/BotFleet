#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project_prefix="${BOTFLEET_CONDA_PREFIX:-$project_root/.conda}"
if [[ "$project_prefix" != /* ]]; then
  echo 'BOTFLEET_CONDA_PREFIX must be an absolute path.' >&2
  exit 1
fi
if [[ -f "$project_root/.deploy/current.json" || -e "$project_root/.deploy/transaction.json" || -e "$project_root/.deploy/lock" ]]; then
  echo 'Finish or recover pending deployments and undeploy managed bots before updating the runtime.' >&2
  exit 1
fi
conda_command="${CONDA_EXE:-$(command -v conda || true)}"
if [[ -z "$conda_command" || ! -x "$conda_command" ]]; then
  echo 'Conda is required. Set CONDA_EXE to the Conda executable and retry.' >&2
  exit 1
fi
if [[ -d "$project_prefix/conda-meta" ]]; then
  "$conda_command" env update --prefix "$project_prefix" --file "$project_root/environment.yml" --prune
else
  "$conda_command" env create --prefix "$project_prefix" --file "$project_root/environment.yml" --yes
fi
export PATH="$project_prefix/bin:$PATH"
export CONDA_PREFIX="$project_prefix"
unset NODE_PATH npm_config_prefix NPM_CONFIG_PREFIX
cd "$project_root"
"$project_prefix/bin/node" "$project_prefix/lib/node_modules/npm/bin/npm-cli.js" install --global --prefix "$project_prefix" npm@10.9.2 --no-audit --no-fund
# A clean install rebuilds native dependencies for the selected runtime.
"$project_prefix/bin/node" scripts/runtime.mjs exec npm ci
"$project_prefix/bin/node" scripts/runtime.mjs exec node -e 'require("canvas").createCanvas(1, 1).toBuffer()'
