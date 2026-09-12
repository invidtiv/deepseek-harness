#!/usr/bin/env bash
# Installs the dsh-ah-bridge plugin into a DSH profile (Linux/macOS harnesses).
#
# Usage:
#   ./install.sh                       # profile "web" under $DSH_HOME (or ~/.dsh)
#   ./install.sh -p cli                # a differently named profile
#   ./install.sh -d /path/to/profile   # explicit profile directory
#
# Idempotent: safe to re-run after upgrading packages/dsh-ah-bridge/index.js.
# The tools mount at the next harness restart (profile start).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/packages/dsh-ah-bridge"
[ -f "$src/index.js" ] || { echo "Bundle is incomplete: missing $src/index.js" >&2; exit 1; }

profile_name="web"
profile_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) profile_name="$2"; shift 2 ;;
    -d) profile_dir="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

dsh_home="${DSH_HOME:-$HOME/.dsh}"
[ -n "$profile_dir" ] || profile_dir="$dsh_home/profiles/$profile_name"
[ -f "$profile_dir/package.json" ] || { echo "Profile directory not found or not a profile: $profile_dir" >&2; exit 1; }
echo "Target profile: $profile_dir"

ws="$profile_dir/pnpm-workspace.yaml"
pj="$profile_dir/package.json"
patch="$profile_dir/cordis.patch.yml"

# 1. copy the plugin package
mkdir -p "$profile_dir/packages"
rm -rf "$profile_dir/packages/dsh-ah-bridge"
cp -R "$src" "$profile_dir/packages/dsh-ah-bridge"
echo "[1/4] copied plugin package"

# 2. workspace membership
if [ -f "$ws" ] && grep -qE '^\s*-\s*packages/\*\s*$' "$ws"; then
  echo "[2/4] pnpm-workspace.yaml already includes packages/*"
elif [ -f "$ws" ] && grep -qE '^packages:\s*$' "$ws"; then
  printf '  - packages/*\n' >> "$ws"
  echo "[2/4] added packages/* to pnpm-workspace.yaml"
else
  echo "[2/4] WARNING: add '  - packages/*' under 'packages:' in $ws manually" >&2
fi

# 3. profile dependency
node -e '
const fs = require("fs");
const p = process.argv[1];
const pj = JSON.parse(fs.readFileSync(p, "utf8"));
pj.dependencies = pj.dependencies || {};
if (pj.dependencies["dsh-ah-bridge"] !== "workspace:*") {
  pj.dependencies["dsh-ah-bridge"] = "workspace:*";
  fs.writeFileSync(p, JSON.stringify(pj, null, 2) + "\n");
  console.log("[3/4] added dsh-ah-bridge dependency to package.json");
} else {
  console.log("[3/4] package.json already declares the dependency");
}
' "$pj"

# 4. composition row
if [ -f "$patch" ] && grep -q 'dsh-ah-bridge' "$patch"; then
  echo "[4/4] cordis.patch.yml already contains the ah-bridge row"
else
  cat >> "$patch" <<'YAML'

- insert:
    - id: ah-bridge
      name: dsh-ah-bridge
YAML
  echo "[4/4] appended the ah-bridge insert row to cordis.patch.yml"
fi

# install
link="$profile_dir/node_modules/dsh-ah-bridge"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$profile_dir" && pnpm install)
  echo "[install] pnpm install complete"
fi
if [ ! -e "$link" ]; then
  mkdir -p "$profile_dir/node_modules"
  cp -R "$src" "$link"
  echo "[install] fallback: copied package directly into node_modules"
fi

# verify
cd "$profile_dir"
if node --input-type=module -e "const m = await import('dsh-ah-bridge'); if (m.name !== 'ah-bridge' || typeof m.apply !== 'function') process.exit(1); console.log('verify: import ok')"; then
  echo "Done. Restart the harness profile to mount the ah-bridge row."
else
  echo "WARNING: import check failed - inspect $link" >&2
  exit 1
fi
