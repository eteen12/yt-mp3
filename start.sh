#!/usr/bin/env bash
# Sets up a current yt-dlp (once), then starts the app at http://localhost:5317
set -e
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: sudo apt install ffmpeg"; exit 1; }
if [ ! -x .venv/bin/yt-dlp ]; then
  uv venv -q .venv && uv pip install -q --python .venv/bin/python -U "yt-dlp[default]"
fi
exec node server.js
