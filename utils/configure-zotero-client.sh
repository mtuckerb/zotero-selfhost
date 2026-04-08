#!/usr/bin/env bash
#
# Point an installed Zotero 7 / 8 desktop client at a self-hosted server.
#
# Zotero 6+ honors two runtime preference overrides for the sync URLs:
#   extensions.zotero.api.url       (overrides ZOTERO_CONFIG.API_URL)
#   extensions.zotero.streaming.url (overrides ZOTERO_CONFIG.STREAMING_URL)
#
# These are read by syncRunner.js, syncAPIClient.js, retractions.js, and
# streamer.js — i.e., the entire sync code path. No omni.ja repack is
# needed; we just write to the profile's user.js file (which Zotero
# evaluates at startup as user pref overrides).
#
# Usage:
#   ./configure-zotero-client.sh <hostname> [profile-dir]
#
# Examples:
#   ./configure-zotero-client.sh zotero.example.com
#   ./configure-zotero-client.sh zotero.example.com ~/.zotero/zotero/abc123.default
#
# After running:
#   1. Restart Zotero (close it completely and reopen)
#   2. Edit → Preferences → Sync → log in with your username + API key
#      (the API key is the value of services.zotero-selfhost.webLibrary.apiKey
#       in your flake config, or look it up with
#       `mysql -u zotero zotero_master -e "SELECT \`key\` FROM \`keys\` WHERE userID=1"`)
#   3. Click "Set Up Syncing"
#
# This script is idempotent — running it twice with the same hostname
# is a no-op. Running it with a different hostname rewrites the values.
# Reverting to upstream Zotero requires either re-running with hostname
# `api.zotero.org` (and removing the streaming.url line) or deleting the
# self-host pref lines from user.js manually.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  cat >&2 <<USAGE
Usage: $0 <hostname> [profile-dir]
Example: $0 zotero.example.com
USAGE
  exit 2
fi

HOST="$1"
PROFILE_DIR="${2:-}"

# Auto-detect Zotero profile directory if not given.
detect_profile() {
  local roots=()
  case "$(uname -s)" in
    Linux)   roots+=( "$HOME/.zotero/zotero" "$HOME/snap/zotero/common/.zotero/zotero" ) ;;
    Darwin)  roots+=( "$HOME/Library/Application Support/Zotero/Profiles" ) ;;
    MINGW*|MSYS*|CYGWIN*) roots+=( "$APPDATA/Zotero/Zotero/Profiles" ) ;;
  esac
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    # Pick the *.default* dir (Zotero defaults the suffix per platform)
    for d in "$root"/*.default*; do
      [ -d "$d" ] && { echo "$d"; return 0; }
    done
  done
  return 1
}

if [ -z "$PROFILE_DIR" ]; then
  if PROFILE_DIR="$(detect_profile)"; then
    echo "Auto-detected Zotero profile: $PROFILE_DIR"
  else
    cat >&2 <<MSG
ERROR: could not find a Zotero profile directory.

Open Zotero once to create the default profile, or pass the path
explicitly as the second argument:

  Linux:    ~/.zotero/zotero/<random>.default
  macOS:    ~/Library/Application Support/Zotero/Profiles/<random>.default
  Windows:  %APPDATA%\\Zotero\\Zotero\\Profiles\\<random>.default

You can find the actual path in Zotero via Help → Open Profile Directory.
MSG
    exit 1
  fi
fi

if [ ! -d "$PROFILE_DIR" ]; then
  echo "ERROR: not a directory: $PROFILE_DIR" >&2
  exit 1
fi

USER_JS="$PROFILE_DIR/user.js"

API_URL="https://${HOST}/"
STREAMING_URL="wss://${HOST}/stream/"

# Idempotent: remove any previous self-host markers, then append fresh ones.
if [ -f "$USER_JS" ]; then
  cp -p "$USER_JS" "$USER_JS.zotero-selfhost.bak"
  # Drop any prior self-host block
  sed -i.tmp '/^\/\/ BEGIN zotero-selfhost$/,/^\/\/ END zotero-selfhost$/d' "$USER_JS"
  rm -f "$USER_JS.tmp"
fi

cat >> "$USER_JS" <<EOF
// BEGIN zotero-selfhost
// Added by configure-zotero-client.sh. To revert, delete the lines
// between BEGIN and END markers, or rerun the script with the upstream
// hostname \`api.zotero.org\` (and then manually clear streaming.url).
user_pref("extensions.zotero.api.url",       "${API_URL}");
user_pref("extensions.zotero.streaming.url", "${STREAMING_URL}");
// END zotero-selfhost
EOF

cat <<MSG
Wrote prefs to $USER_JS:
  extensions.zotero.api.url       = ${API_URL}
  extensions.zotero.streaming.url = ${STREAMING_URL}

Backup saved to $USER_JS.zotero-selfhost.bak

Next steps:
  1. Quit Zotero completely (not just close window — File → Quit)
  2. Reopen Zotero
  3. Edit → Preferences → Sync → enter your username and API key
     (the API key is the value of services.zotero-selfhost.webLibrary.apiKey,
      or look it up with the SQL: SELECT \`key\` FROM zotero_master.\`keys\` WHERE userID=1)
  4. Click "Set Up Syncing"

To verify the override is in effect, open the Tools → Developer → Run JavaScript
console and run:
  Zotero.Prefs.get('api.url')
  Zotero.Prefs.get('streaming.url')

Both should return your self-host URLs.
MSG
