#!/usr/bin/env bash
set -euo pipefail

RELEASE_REPOSITORY="morrisdevstudio/morriscode-releases"
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/morriscode"
ARGS="--port 10369 --host 127.0.0.1 --no-https --no-browser"
HEALTH_PORT=10369
NO_AUTO_UPDATE=0
NO_SERVICE=0
NO_START=0
BUNDLE=""
MANIFEST=""
SIGNATURE=""
PUBLIC_KEY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --signature) SIGNATURE="$2"; shift 2 ;;
    --public-key) PUBLIC_KEY="$2"; shift 2 ;;
    --args) ARGS="$2"; shift 2 ;;
    --health-port) HEALTH_PORT="$2"; shift 2 ;;
    --no-auto-update) NO_AUTO_UPDATE=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help)
      echo "Usage: install.sh [--root DIR] [--bundle FILE --manifest FILE --signature FILE --public-key FILE] [--no-auto-update] [--no-service]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required. Install it from https://nodejs.org and run this installer again." >&2
  exit 1
fi
NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Node.js 24 or newer is required (found $(node -v))." >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

if [ -n "$BUNDLE" ]; then
  if [ -z "$MANIFEST" ] || [ -z "$SIGNATURE" ] || [ -z "$PUBLIC_KEY" ]; then
    echo "A local install needs --manifest, --signature and --public-key." >&2
    exit 1
  fi
  ASSET="$BUNDLE"
  VERIFY_SCRIPT="$(dirname "$0")/release/verify-release.mjs"
  LAUNCHER_SOURCE="$(dirname "$0")/launcher.mjs"
else
    curl -fLsS -H 'User-Agent: MorrisCode-Installer' -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$RELEASE_REPOSITORY/releases/latest" -o "$TEMP_DIR/release.json"
  VERSION=$(node -e 'process.stdout.write(require(process.argv[1]).tag_name.replace(/^v/, ""))' "$TEMP_DIR/release.json")
  node -e 'const r=require(process.argv[1]); for (const a of r.assets) console.log(a.name+"\t"+a.browser_download_url)' "$TEMP_DIR/release.json" > "$TEMP_DIR/assets.txt"
  for name in manifest.json manifest.json.sig release-public-key.pem launcher.mjs verify-release.mjs "morriscode-$VERSION-linux-x64.tar.gz"; do
    url=$(awk -F '\t' -v name="$name" '$1 == name { print $2; exit }' "$TEMP_DIR/assets.txt")
    if [ -z "$url" ]; then echo "Release asset missing: $name" >&2; exit 1; fi
    curl -fLsS -H 'User-Agent: MorrisCode-Installer' "$url" -o "$TEMP_DIR/$name"
  done
  ASSET="$TEMP_DIR/morriscode-$VERSION-linux-x64.tar.gz"
  MANIFEST="$TEMP_DIR/manifest.json"
  SIGNATURE="$TEMP_DIR/manifest.json.sig"
  PUBLIC_KEY="$TEMP_DIR/release-public-key.pem"
  VERIFY_SCRIPT="$TEMP_DIR/verify-release.mjs"
  LAUNCHER_SOURCE="$TEMP_DIR/launcher.mjs"
fi

VERIFIED=$(node "$VERIFY_SCRIPT" --manifest "$MANIFEST" --signature "$SIGNATURE" --public-key "$PUBLIC_KEY" --platform linux --arch x64 --asset "$ASSET")
VERSION=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$VERIFIED")

if tar -tzf "$ASSET" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "The release archive contains an unsafe path." >&2
  exit 1
fi

mkdir -p "$ROOT/releases"
RELEASE_DIR="$ROOT/releases/$VERSION"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$ASSET" -C "$RELEASE_DIR" --no-same-owner --no-same-permissions
if [ ! -f "$RELEASE_DIR/dist/cli/index.js" ]; then
  echo "The extracted release has no CLI entry point." >&2
  exit 1
fi
while IFS= read -r link; do
  target=$(readlink -f "$link" 2>/dev/null || true)
  case "$target" in
    "$RELEASE_DIR"/*) ;;
    *) echo "The release archive contains a link escaping its directory." >&2; exit 1 ;;
  esac
done < <(find "$RELEASE_DIR" -type l)

cp "$LAUNCHER_SOURCE" "$ROOT/launcher.mjs"
node -e '
const fs = require("node:fs")
const [out, root, port, args, auto] = process.argv.slice(1)
fs.writeFileSync(out, JSON.stringify({
  args: args.split(/\s+/).filter(Boolean),
  cwd: root,
  healthPort: Number(port),
  healthScheme: "http",
  autoUpdate: auto === "true",
}, null, 2))
' "$ROOT/launcher.json" "$ROOT" "$HEALTH_PORT" "$ARGS" "$([ "$NO_AUTO_UPDATE" -eq 1 ] && echo false || echo true)"

CURRENT="$ROOT/current.json"
node -e '
const fs = require("node:fs")
const [path, version] = process.argv.slice(1)
let previous
try {
  const existing = JSON.parse(fs.readFileSync(path, "utf-8"))
  previous = { version: existing.version, dir: existing.dir }
} catch {}
fs.writeFileSync(path, JSON.stringify({
  schemaVersion: 1,
  version,
  dir: `releases/${version}`,
  ...(previous ? { previous } : {}),
  updatedAt: new Date().toISOString(),
}, null, 2))
' "$CURRENT" "$VERSION"

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/morriscode" <<EOF
#!/bin/sh
exec "$(command -v node)" "$ROOT/launcher.mjs" "\$@"
EOF
chmod 755 "$HOME/.local/bin/morriscode"

if [ "$NO_SERVICE" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  AUTO_ENV=""
  if [ "$NO_AUTO_UPDATE" -eq 1 ]; then AUTO_ENV="Environment=MORRISCODE_AUTO_UPDATE_DEFAULT=false"; fi
  cat > "$UNIT_DIR/morriscode.service" <<EOF
[Unit]
Description=MorrisCode
After=default.target

[Service]
Type=simple
ExecStart=$(command -v node) $ROOT/launcher.mjs
Restart=always
RestartSec=5
Environment=MORRISCODE_RELEASE_ROOT=$ROOT
$AUTO_ENV

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  if [ "$NO_START" -eq 0 ]; then systemctl --user enable --now morriscode.service; fi
fi

echo "MorrisCode $VERSION installed in $RELEASE_DIR"
echo "Configuration and history were not modified."
