#!/bin/bash
# Quick Cloudflare Tunnel setup — gives you an instant HTTPS URL so you can
# use the platform on cellular data without buying a domain.
#
# URL looks like: https://something-random-words.trycloudflare.com
# It stays the same while the cloudflared process keeps running. When your Mac
# restarts (or the tunnel crashes), you get a new URL — the platform's status
# bar will show the current one.
#
# When you grab a $10/yr domain, swap in setup-tunnel.sh for a permanent URL.

set -e

PLATFORM_DIR="/Users/rileywallack/triibe-platform"
TUNNEL_URL_FILE="$PLATFORM_DIR/config/tunnel.json"
WRAPPER_SCRIPT="$PLATFORM_DIR/tools/tunnel-runner.sh"
PLIST="$HOME/Library/LaunchAgents/com.triibe.tunnel.plist"
CLOUDFLARED_BIN=$(which cloudflared)

echo "🌥  Quick Cloudflare Tunnel setup (no domain needed)"
echo "----"

# Step 1: write the wrapper that runs cloudflared, captures the URL, saves it
cat > "$WRAPPER_SCRIPT" <<EOF
#!/bin/bash
# Wrapper: runs cloudflared quick-tunnel, parses the public URL from its log,
# saves it to config/tunnel.json so the platform UI can surface it.
LOG="\$HOME/Library/Logs/triibe-tunnel.log"
URL_FILE="$TUNNEL_URL_FILE"
mkdir -p \$(dirname "\$URL_FILE")

# Run cloudflared in foreground, capture stdout/stderr to the log
$CLOUDFLARED_BIN tunnel --url http://localhost:4744 --no-autoupdate 2>&1 | tee "\$LOG" | while read -r line; do
  # When the public URL line appears, persist it
  if echo "\$line" | grep -q 'trycloudflare.com'; then
    URL=\$(echo "\$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com')
    if [ -n "\$URL" ]; then
      printf '{"url":"%s","started_at":"%s"}' "\$URL" "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "\$URL_FILE"
      echo "[tunnel] PUBLIC URL: \$URL  (saved to \$URL_FILE)"
    fi
  fi
done
EOF
chmod +x "$WRAPPER_SCRIPT"
echo "✓ Wrote wrapper script: $WRAPPER_SCRIPT"

# Step 2: launchd plist — runs the wrapper on boot
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.triibe.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WRAPPER_SCRIPT</string>
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

# Step 3: (re)load
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✓ Loaded launchd service com.triibe.tunnel"

echo ""
echo "----"
echo "🎉 Tunnel starting. Give it 5-10 seconds, then run:"
echo "    cat $TUNNEL_URL_FILE"
echo "    (or just open the platform — the URL will appear in the topbar)"
echo ""
echo "On your iPhone:"
echo "    Open Safari → that URL → Share → Add to Home Screen"
echo ""
echo "Logs: tail -f ~/Library/Logs/triibe-tunnel.log"
