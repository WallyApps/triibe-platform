#!/usr/bin/env bash
# Install the Triibe Platform server + WhatsApp daemon as launchd services.
# After running this once, both processes:
#   - Start automatically when you log in
#   - Restart if they crash
#   - Survive Terminal being closed
#   - Survive a Mac reboot
#
# To uninstall later: ./tools/uninstall-services.sh
set -euo pipefail

PLATFORM_DIR="/Users/rileywallack/triibe-platform"
NODE_BIN="$(command -v node)"
LOG_DIR="$HOME/Library/Logs"
PLIST_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$LOG_DIR" "$PLIST_DIR"

# Resolve PATH so launchd processes can find node + homebrew
PATH_LINE="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ---- Platform server (port 4744) ----
SERVER_LABEL="com.triibe.platform.server"
SERVER_PLIST="$PLIST_DIR/$SERVER_LABEL.plist"
cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--no-warnings</string>
    <string>$PLATFORM_DIR/server/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH_LINE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/triibe-server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/triibe-server.err.log</string>
  <key>WorkingDirectory</key><string>$PLATFORM_DIR</string>
</dict>
</plist>
EOF

# ---- WhatsApp daemon (port 4745) ----
WA_LABEL="com.triibe.platform.whatsapp"
WA_PLIST="$PLIST_DIR/$WA_LABEL.plist"
cat > "$WA_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WA_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PLATFORM_DIR/whatsapp-daemon/daemon.cjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH_LINE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/triibe-wa.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/triibe-wa.err.log</string>
  <key>WorkingDirectory</key><string>$PLATFORM_DIR</string>
</dict>
</plist>
EOF

echo "✓ Wrote $SERVER_PLIST"
echo "✓ Wrote $WA_PLIST"

# Unload any previous version first (ignore errors if not loaded)
launchctl unload "$SERVER_PLIST" 2>/dev/null || true
launchctl unload "$WA_PLIST" 2>/dev/null || true

# Stop any manually-started instances on the same ports so launchd takes over cleanly
lsof -ti :4744 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
lsof -ti :4745 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
sleep 1

launchctl load "$SERVER_PLIST"
launchctl load "$WA_PLIST"

sleep 3
echo
echo "=== Status ==="
launchctl list | grep triibe || echo "  (no triibe services listed yet — may take a moment)"
echo
echo "=== Quick health checks ==="
echo -n "Platform server (:4744) : "
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4744/api/health || echo "no response"
echo -n "WhatsApp daemon (:4745) : "
curl -s http://localhost:4745/status 2>/dev/null || echo "no response yet (WA daemon takes ~10s to spin up Chromium)"
echo
echo "✓ Installed. Both will run in the background forever."
echo "  Logs: $LOG_DIR/triibe-server.log, triibe-server.err.log, triibe-wa.log, triibe-wa.err.log"
echo "  To uninstall later: ./tools/uninstall-services.sh"
