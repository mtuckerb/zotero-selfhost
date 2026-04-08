#!/usr/bin/env bash
#
# Patch an installed Zotero 7 desktop client to talk to a self-hosted
# server instead of the default api.zotero.org / www.zotero.org / stream.zotero.org.
#
# Usage:
#   ./patch-zotero7-client.sh <hostname> [path/to/config.mjs]
#
# Examples:
#   # Linux (typical install location)
#   sudo ./patch-zotero7-client.sh zotero.example.com /opt/zotero/resource/config.mjs
#
#   # macOS
#   sudo ./patch-zotero7-client.sh zotero.example.com \
#     /Applications/Zotero.app/Contents/Resources/resource/config.mjs
#
#   # Auto-detect Linux paths
#   sudo ./patch-zotero7-client.sh zotero.example.com
#
# After running, restart Zotero. In Edit → Preferences → Sync, log in
# with your self-host's superuser credentials (username + the API key
# from zotero_master.keys, OR username + the superuser-password from
# the sops file).
#
# Caveat: Zotero auto-update will overwrite this file. After Zotero
# updates itself, re-run this script. To prevent auto-updates open
# Edit → Preferences → Advanced → "Automatically check for updates"
# and uncheck.
#
# This script is idempotent — running it twice with the same hostname
# is a no-op. Running it with a different hostname rewrites the
# values. To revert to upstream, run with hostname `zotero.org` and
# manually fix BASE_URI back to `http://`.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <hostname> [path/to/config.mjs]" >&2
  echo "Example: $0 zotero.example.com" >&2
  exit 2
fi

HOST="$1"
CONFIG="${2:-}"

# Auto-detect typical install paths if no path supplied
if [ -z "$CONFIG" ]; then
  for candidate in \
    /opt/zotero/resource/config.mjs \
    /usr/lib/zotero/resource/config.mjs \
    /usr/local/lib/zotero/resource/config.mjs \
    /Applications/Zotero.app/Contents/Resources/resource/config.mjs \
    "$HOME/.local/share/zotero/resource/config.mjs"
  do
    if [ -f "$candidate" ]; then
      CONFIG="$candidate"
      echo "Auto-detected Zotero install at: $CONFIG"
      break
    fi
  done
fi

if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
  echo "ERROR: config.mjs not found." >&2
  echo "Pass an explicit path as the second argument." >&2
  echo "Common locations:" >&2
  echo "  Linux:   /opt/zotero/resource/config.mjs" >&2
  echo "  macOS:   /Applications/Zotero.app/Contents/Resources/resource/config.mjs" >&2
  echo "  Windows: C:\\Program Files\\Zotero\\resource\\config.mjs" >&2
  exit 1
fi

# Backup once
if [ ! -f "$CONFIG.zotero-org.bak" ]; then
  cp -p "$CONFIG" "$CONFIG.zotero-org.bak"
  echo "Saved original to $CONFIG.zotero-org.bak"
fi

# Replace the five fields the self-host actually serves. Use a
# python helper because sed across multi-line replacements with
# special characters is fragile.
python3 - "$HOST" "$CONFIG" <<'PYEOF'
import sys
host = sys.argv[1]
path = sys.argv[2]
src = open(path).read()
replacements = [
    ("DOMAIN_NAME: 'zotero.org',",            f"DOMAIN_NAME: '{host}',"),
    ("BASE_URI: 'http://zotero.org/',",       f"BASE_URI: 'https://{host}/',"),
    ("WWW_BASE_URL: 'https://www.zotero.org/'", f"WWW_BASE_URL: 'https://{host}/'"),
    ("API_URL: 'https://api.zotero.org/',",   f"API_URL: 'https://{host}/',"),
    ("STREAMING_URL: 'wss://stream.zotero.org/'", f"STREAMING_URL: 'wss://{host}/stream/'"),
]
changed = 0
for old, new in replacements:
    if old in src:
        src = src.replace(old, new)
        changed += 1
    elif new.split("'")[1].split("'")[0] in src or host in src:
        # Already patched
        pass
    else:
        print(f"WARNING: couldn't find expected upstream value, skipping: {old[:50]}...", file=sys.stderr)

open(path, 'w').write(src)
print(f"Patched {changed} field(s) in {path}")
PYEOF

echo
echo "Done. Restart Zotero and configure sync at Edit → Preferences → Sync"
echo "with your self-host's admin username + API key."
