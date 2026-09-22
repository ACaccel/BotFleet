#!/usr/bin/env bash
# Bootstrap an isolated migration runtime without changing shell startup files.
set -euo pipefail
umask 077

fail() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash bootstrap.sh --env NAME [--prefix ABSOLUTE_PATH] [--runtime FILE] [--apply]

Reads source package versions from runtime.conf (default: beside this script).
Installs Miniforge under $HOME/miniforge3 unless --prefix is supplied.
Default: print the plan. Add --apply to install into the dedicated environment.
Requires Linux, Bash, coreutils, tar, and curl or wget for downloads.
The pinned official Miniforge installer and its SHA256 are downloaded over HTTPS.
Advanced: --installer FILE --installer-sha256 HEX64 --miniforge-version X.Y.Z-N
No sudo, shell startup changes, or service startup occurs.
HELP
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prefix="$HOME/miniforge3" env_name='' runtime="$script_dir/runtime.conf"
miniforge_version='' installer_sha256='' installer=''
apply=0
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --apply) apply=1; shift; continue ;;
    --prefix|--env|--runtime|--miniforge-version|--installer-sha256|--installer)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail "Missing value for $1"
      case "$1" in
        --prefix) prefix=$2 ;;
        --env) env_name=$2 ;;
        --runtime) runtime=$2 ;;
        --miniforge-version) miniforge_version=$2 ;;
        --installer-sha256) installer_sha256=$2 ;;
        --installer) installer=$2 ;;
      esac
      shift 2 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# Parse data, never shell code, including runtime files received with a backup.
[[ -f "$runtime" && -r "$runtime" ]] || fail 'Runtime file is missing or unreadable; use --runtime FILE'
declare -A versions=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^(MONGODB_VERSION|MONGO_TOOLS_VERSION|NODE_VERSION|NPM_VERSION|MONGOSH_VERSION)=([0-9]+\.[0-9]+\.[0-9]+)$ ]] || fail 'Invalid runtime entry'
  key=${BASH_REMATCH[1]}
  [[ -z "${versions[$key]+present}" ]] || fail "Duplicate runtime entry: $key"
  versions[$key]=${BASH_REMATCH[2]}
done < "$runtime"
for key in MONGODB_VERSION MONGO_TOOLS_VERSION NODE_VERSION NPM_VERSION MONGOSH_VERSION; do
  [[ -n "${versions[$key]:-}" ]] || fail "Missing runtime entry: $key"
done
mongodb_version=${versions[MONGODB_VERSION]}
mongo_tools_version=${versions[MONGO_TOOLS_VERSION]}
node_version=${versions[NODE_VERSION]}
npm_version=${versions[NPM_VERSION]}
mongosh_version=${versions[MONGOSH_VERSION]}
if [[ -z "$miniforge_version" ]]; then
  [[ -r "$script_dir/bootstrap-runtime.conf" ]] || fail 'Missing bootstrap-runtime.conf'
  release_entry=$(< "$script_dir/bootstrap-runtime.conf")
  [[ "$release_entry" =~ ^MINIFORGE_VERSION=([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)$ ]] || fail 'Invalid bootstrap-runtime.conf'
  miniforge_version=${BASH_REMATCH[1]}
fi

[[ "$prefix" == /* && "$prefix" != / && "$prefix" != *$'\n'* ]] || fail '--prefix must be an absolute non-root path'
[[ "$env_name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ && "$env_name" != base ]] || fail '--env must name a dedicated environment (not base)'
for version in "$mongodb_version" "$mongo_tools_version" "$node_version" "$mongosh_version"; do
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Exact X.Y.Z versions are required'
done
[[ "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'NPM_VERSION must pin an exact version (X.Y.Z)'
[[ "$miniforge_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]] || fail '--miniforge-version must pin a release (X.Y.Z-N)'
[[ -z "$installer_sha256" || "$installer_sha256" =~ ^[a-fA-F0-9]{64}$ ]] || fail '--installer-sha256 must be a trusted SHA256 checksum'
for command in uname realpath sha256sum mktemp rm mkdir dirname tar bash; do
  command -v "$command" >/dev/null || fail "Missing prerequisite: $command"
done
[[ "$(uname -s)" == Linux ]] || fail 'Only Linux is supported'
architecture=$(uname -m)
case "$architecture" in x86_64|aarch64) ;; *) fail "Unsupported architecture: $architecture" ;; esac
prefix=$(realpath -m -- "$prefix")
[[ "$prefix" != / ]] || fail 'Refusing the filesystem root'
conda="$prefix/bin/conda"
environment="$prefix/envs/$env_name"
if [[ -e "$prefix" ]]; then
  [[ -x "$conda" && -f "$prefix/conda-meta/history" ]] || fail 'Existing prefix is not a conda installation'
fi
if [[ -e "$environment" ]]; then
  [[ -f "$environment/conda-meta/history" ]] || fail 'Existing environment path is not a conda environment'
fi
if [[ -n "$installer" ]]; then
  [[ -f "$installer" && -r "$installer" ]] || fail 'Local installer is not a readable file'
  installer=$(realpath -- "$installer")
fi
if [[ ! -x "$conda" && ( -z "$installer" || -z "$installer_sha256" ) ]]; then
  command -v curl >/dev/null || command -v wget >/dev/null || fail 'Install curl or wget, or supply --installer with --installer-sha256'
fi

packages=("mongodb=$mongodb_version" "mongo-tools=$mongo_tools_version" "nodejs=$node_version"
  tmux rsync git python compilers make pkg-config cairo pango libjpeg-turbo giflib librsvg curl)
asset="Miniforge3-$miniforge_version-Linux-$architecture.sh"
url="https://github.com/conda-forge/miniforge/releases/download/$miniforge_version/$asset"
action=create
[[ ! -f "$environment/conda-meta/history" ]] || action=install
printf 'Conda prefix: %s\nEnvironment: %s\nMiniforge release: %s\n' "$prefix" "$environment" "$miniforge_version"
printf 'Conda %s packages:' "$action"
printf ' %s' "${packages[@]}"
printf '\nNpm tools: npm@%s mongosh@%s\n' "$npm_version" "$mongosh_version"
if (( ! apply )); then
  printf 'Plan only. Rerun with --apply to install. Existing environments will be updated.\n'
  exit 0
fi

temporary=''
cleanup() { [[ -z "$temporary" ]] || rm -rf -- "$temporary"; }
trap cleanup EXIT
download() {
  if command -v curl >/dev/null; then
    curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --output "$2" "$1"
  else
    wget --https-only --tries=3 --output-document="$2" "$1"
  fi
}
if [[ ! -x "$conda" ]]; then
  temporary=$(mktemp -d)
  if [[ -z "$installer_sha256" ]]; then
    download "$url.sha256" "$temporary/installer.sha256"
    checksum_entry=$(< "$temporary/installer.sha256")
    [[ "$checksum_entry" =~ ^([a-fA-F0-9]{64})[[:blank:]]+\*?([^[:space:]]+)$ ]] || fail 'Invalid official installer checksum'
    installer_sha256=${BASH_REMATCH[1]}
    checksum_asset=${BASH_REMATCH[2]}
    # Official release checksums may prefix the asset basename with ./.
    [[ "${checksum_asset#./}" == "$asset" ]] || fail 'Official installer checksum names a different asset'
  fi
  if [[ -z "$installer" ]]; then
    installer="$temporary/miniforge.sh"
    download "$url" "$installer"
  fi
  actual_sha256=$(sha256sum -- "$installer")
  actual_sha256=${actual_sha256%% *}
  [[ "${actual_sha256,,}" == "${installer_sha256,,}" ]] || fail 'Installer checksum mismatch'
  mkdir -p -- "$(dirname -- "$prefix")"
  bash "$installer" -b -p "$prefix"
  [[ -x "$conda" && -f "$prefix/conda-meta/history" ]] || fail 'Miniforge installation is incomplete'
fi

# Explicit paths keep user conda envs_dirs and npm prefix settings out of scope.
conda_arguments=("$action" --prefix "$environment" --override-channels --channel conda-forge --strict-channel-priority "${packages[@]}")
"$conda" "${conda_arguments[@]}" --dry-run
"$conda" "${conda_arguments[@]}" --yes
"$conda" run --prefix "$environment" --no-capture-output npm install --global --prefix "$environment" \
  "npm@$npm_version" "mongosh@$mongosh_version"

# Check installed metadata and executable health, including reused environments.
"$conda" run --prefix "$environment" --no-capture-output python -c '
import glob, json, os, sys
root, mongo, tools, node = sys.argv[1:]
installed = {}
for filename in glob.glob(os.path.join(root, "conda-meta", "*.json")):
    with open(filename, encoding="utf-8") as handle:
        package = json.load(handle)
    installed[package["name"]] = package["version"]
for name, expected in [("mongodb", mongo), ("mongo-tools", tools), ("nodejs", node)]:
    if installed.get(name) != expected:
        raise SystemExit("Version verification failed: " + name)
' "$environment" "$mongodb_version" "$mongo_tools_version" "$node_version"
for binary in mongod mongodump mongorestore git; do
  "$conda" run --prefix "$environment" --no-capture-output "$environment/bin/$binary" --version
done
for specification in "node:$node_version" "npm:$npm_version" "mongosh:$mongosh_version"; do
  binary=${specification%%:*}
  expected=${specification#*:}
  actual=$("$conda" run --prefix "$environment" "$environment/bin/$binary" --version)
  actual=${actual#v}
  [[ "$actual" == "$expected" ]] || fail "Version verification failed: $binary"
done
printf 'Runtime verified. Activate with:\n'
printf '  source %q\n  conda activate %q\n' "$prefix/etc/profile.d/conda.sh" "$environment"
