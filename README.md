# yt-mp3

Paste a YouTube link, get an MP3. Runs on your own computer.

## Setup

You need [Node](https://nodejs.org), [ffmpeg](https://ffmpeg.org) and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/eteen12/yt-mp3
cd yt-mp3
./start.sh
```

Then open http://localhost:5317.

The first run installs yt-dlp into a local `.venv`. If downloads start failing, delete `.venv` and run `./start.sh` again to get a fresh yt-dlp.
