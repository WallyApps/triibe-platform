#!/bin/bash
# Cloudflare Tunnel setup for Triibe Platform.
# Routes https://ops.triibetalents.com → http://localhost:4744 via cloudflared.
# Runs as a launchd service so the tunnel auto-starts on Mac boot.

set -e

DOMAIN="triibetalents.com"
SUBDOMAIN="ops"
HOSTNAME="${SUBDOMAIN}.${DOMAIN}"
TUNNEL_NAME="triibe"
LOCAL_PORT=4744
CF_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CF_DIR/config.yml"
PLIST="$HOME/Library/LaunchAgents/com.triibe.tunnel.plist"

echo "🌥  Cloudflare Tunnel setup for $HOSTNAME"
echo "----"

# Step 1: ensure user logged in (cert.pem exists)
if [ ! -f "$CF_DIR/cert.pem" ]; then
  echo "⚠  You need to log in to Cloudflare first."
  echo ""
  echo "  Run this command, then re-run setup-tunnel.sh:"
  echo "    cloudflared tunnel login"
  echo ""
  echo "  A browser will open. Select '$DOMAIN' from your zones."
  exit 1
fi
echo "✓ Found cert.pem — logged in to Cloudflare"

# Step 2: create the tunnel (or reuse if exists)
EXISTING_TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2 == n { print $1 }' || true)
if [ -z "$EXISTING_TUNNEL_ID" ]; then
  echo "→ Creating tunnel '$TUNNEL_NAME'…"
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID=$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$2 == n { print $1 }')
else
  echo "✓ Tunnel '$TUNNEL_NAME' already exists ($EXISTING_TUNNEL_ID)"
  TUNNEL_ID="$EXISTING_TUNNEL_ID"
fi

# Step 3: route DNS
echo "→ Routing DNS: $HOSTNAME → tunnel $TUNNEL_ID"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>&1 | tail -3 || true

# Step 4: write config.yml
cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CF_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$LOCAL_PORT
  - service: http_status:404
EOF
echo "✓ Wrote config: $CONFIG_FILE"

# Step 5: launchd plist so the tunnel runs on boot
CLOUDFLARED_BIN=$(which cloudflared)
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.triibe.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED_BIN</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>$CONFIG_FILE</string>
    <string>run</string>
    <string>$TUNNEL_NAME</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/triibe-tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/triibe-tunnel.err.log</string>
</dict>
</plist>
EOF
echo "✓ Wrote launchd plist: $PLIST"

# Step 6: (re)load the launchd service
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✓ Loaded launchd service com.triibe.tunnel"

echo ""
echo "----"
echo "🎉 Done. Give it 10 seconds, then test:"
echo "    curl -sI https://$HOSTNAME"
echo ""
echo "On your iPhone:"
echo "    Open Safari → https://$HOSTNAME"
echo "    Share → Add to Home Screen"
echo ""
echo "Logs: tail -f ~/Library/Logs/triibe-tunnel.log"
