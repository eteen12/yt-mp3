#!/usr/bin/env bash
# Puts the app on your personal Vercel. The page is served by Vercel; conversions run on
# this computer (YouTube blocks Vercel's servers) through a Cloudflare tunnel.
# Keep this running while people use the link. Ctrl+C stops sharing.
set -e
cd "$(dirname "$0")"
SCOPE=ethan-63958029   # personal Vercel account (not North Group)

if ! curl -s -o /dev/null localhost:5317; then
  ./start.sh > server.log 2>&1 &
  SERVER_PID=$!
  sleep 1.5
fi

TUNNEL_LOG=$(mktemp)
cloudflared tunnel --no-autoupdate --url http://localhost:5317 > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID ${SERVER_PID:-} 2>/dev/null; rm -f "$TUNNEL_LOG"' EXIT

echo "Opening tunnel…"
for _ in $(seq 60); do
  TUNNEL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
  [ -n "$TUNNEL" ] && break
  sleep 0.5
done
[ -z "$TUNNEL" ] && { echo "The tunnel didn't start:"; cat "$TUNNEL_LOG"; exit 1; }
# Wait until the tunnel actually answers.
for _ in $(seq 40); do curl -s -o /dev/null -m 3 "$TUNNEL/" && break; sleep 1; done

cp public/index.html deploy/index.html
cat > deploy/vercel.json <<JSON
{ "rewrites": [{ "source": "/api/:path*", "destination": "$TUNNEL/api/:path*" }] }
JSON

echo "Deploying to Vercel…"
(cd deploy && vercel deploy --prod --yes --scope "$SCOPE" > /dev/null 2>&1) || { echo "Vercel deploy failed."; exit 1; }

echo
echo "  Share this link:  https://ethan-yt-mp3.vercel.app"
echo "  Keep this window open while it's being used. Ctrl+C to stop."
wait $TUNNEL_PID
