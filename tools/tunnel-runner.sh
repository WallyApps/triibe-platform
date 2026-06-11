#!/bin/bash
# Wrapper: runs cloudflared quick-tunnel, parses the public URL from its log,
# saves it to config/tunnel.json so the platform UI can surface it.
LOG="$HOME/Library/Logs/triibe-tunnel.log"
URL_FILE="/Users/rileywallack/triibe-platform/config/tunnel.json"
mkdir -p $(dirname "$URL_FILE")

# Run cloudflared in foreground, capture stdout/stderr to the log
/opt/homebrew/bin/cloudflared tunnel --url http://localhost:4744 --no-autoupdate 2>&1 | tee "$LOG" | while read -r line; do
  # When the public URL line appears, persist it
  if echo "$line" | grep -q 'trycloudflare.com'; then
    URL=$(echo "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com')
    if [ -n "$URL" ]; then
      printf '{"url":"%s","started_at":"%s"}' "$URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$URL_FILE"
      echo "[tunnel] PUBLIC URL: $URL  (saved to $URL_FILE)"
    fi
  fi
done
