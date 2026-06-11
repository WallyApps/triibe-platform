#!/usr/bin/env bash
# Stop + remove the Triibe Platform + WhatsApp daemon launchd services.
set -euo pipefail

PLIST_DIR="$HOME/Library/LaunchAgents"

for label in com.triibe.platform.server com.triibe.platform.whatsapp; do
  PLIST="$PLIST_DIR/$label.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ Removed $label"
  fi
done

echo "✓ Uninstalled. Services are stopped + won't auto-start anymore."
echo "  (Log files at ~/Library/Logs/triibe-*.log are kept — delete manually if you want.)"
