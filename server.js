// Tiny local YouTube → MP3 server. No npm dependencies; uses yt-dlp + ffmpeg.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT) || 5317;
const HOST = "127.0.0.1";
const ROOT = __dirname;
const WORK = path.join(ROOT, ".jobs");
const YTDLP = fs.existsSync(path.join(ROOT, ".venv/bin/yt-dlp"))
  ? path.join(ROOT, ".venv/bin/yt-dlp")
  : "yt-dlp";
const KEEP_MS = 30 * 60 * 1000;

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const jobs = new Map();

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
]);

function cleanUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !YT_HOSTS.has(u.hostname.toLowerCase())) return null;
  return u.toString();
}

// Pull the 11-character video id out of any common YouTube link shape.
function videoId(url) {
  const u = new URL(url);
  if (u.hostname === "youtu.be") return u.pathname.slice(1, 12);
  if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
  const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

// oEmbed answers in ~150ms, so the title and thumbnail show up long before yt-dlp is ready.
async function quickInfo(url, vid) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title, uploader: j.author_name, thumbnail: vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : j.thumbnail_url };
  } catch {
    return null;
  }
}

async function fetchCover(vid, dest) {
  if (!vid) return null;
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  } catch {
    return null;
  }
}

// Overall progress: connecting to YouTube fills the first slice (it has no real signal,
// so it eases toward CONNECT_SHARE); the rest tracks how much audio ffmpeg has encoded.
const CONNECT_SHARE = 12;

function startJob(url) {
  const id = crypto.randomBytes(8).toString("hex");
  const dir = path.join(WORK, id);
  fs.mkdirSync(dir);
  const vid = videoId(url);
  const job = {
    id, dir, status: "working", phase: "connecting", started: Date.now(),
    encoded: 0, meta: vid ? { id: vid, thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` } : null,
    file: path.join(dir, "audio.mp3"), name: "audio.mp3", error: null, procs: [],
  };
  jobs.set(id, job);

  quickInfo(url, vid).then((info) => {
    if (info) job.meta = { ...job.meta, ...info, ...pick(job.meta, "duration") };
  });

  const metaFile = path.join(dir, "meta.json");
  const ytdlp = spawn(YTDLP, [
    "--js-runtimes", "node",
    "--no-playlist", "--progress", "--newline",
    "-f", "bestaudio/best",
    "--match-filter", "!is_live",
    "--print-to-file", "before_dl:%(.{title,uploader,duration,id})j", metaFile,
    "--progress-template", "download:PROG %(progress._percent_str)s",
    "-o", "-",
    "--", url,
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  job.procs.push(ytdlp);

  let ytErr = "";
  ytdlp.stderr.on("data", (c) => {
    ytErr += c;
    if (job.phase === "connecting" && /PROG /.test(c)) {
      job.phase = "converting";
      try {
        const m = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        job.meta = { ...job.meta, ...m, title: job.meta?.title || m.title, uploader: job.meta?.uploader || m.uploader };
      } catch {}
    }
  });
  ytdlp.on("error", () => fail(job, "The converter isn't installed. Run ./start.sh to set it up."));

  // Start ffmpeg once the cover art is fetched (yt-dlp is still connecting, so nothing is lost).
  const cover = fetchCover(vid, path.join(dir, "cover.jpg"));
  Promise.all([cover, sleep(250)]).then(([coverPath]) => {
    if (job.status !== "working") return;
    const tags = job.meta || {};
    const args = ["-v", "error", "-y", "-i", "pipe:0"];
    if (coverPath) args.push("-i", coverPath, "-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic");
    else args.push("-vn");
    args.push("-c:a", "libmp3lame", "-q:a", "0", "-id3v2_version", "3");
    if (tags.title) args.push("-metadata", `title=${tags.title}`);
    if (tags.uploader) args.push("-metadata", `artist=${tags.uploader}`);
    args.push("-progress", "pipe:1", "-nostats", job.file);

    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    job.procs.push(ff);
    ytdlp.stdout.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    let ffErr = "";
    ff.stderr.on("data", (c) => { ffErr += c; });
    ff.stdout.on("data", (c) => {
      const m = String(c).match(/out_time_us=(\d+)/g);
      if (m) job.encoded = Number(m.pop().split("=")[1]) / 1e6;
    });

    const done = Promise.all([exitCode(ytdlp), exitCode(ff)]);
    done.then(([ytCode, ffCode]) => {
      if (job.status !== "working") return;
      if (ytCode !== 0) return fail(job, friendlyError(ytErr));
      if (!fs.existsSync(metaFile)) return fail(job, "Live streams can't be converted. Try again after the stream ends.");
      if (ffCode !== 0 || !fs.existsSync(job.file)) return fail(job, "The audio couldn't be converted to MP3. Try again.");
      job.name = safeName(job.meta?.title || "audio") + ".mp3";
      job.status = "done";
      job.phase = "done";
    });
  });

  setTimeout(() => {
    job.procs.forEach((p) => p.kill());
    fs.rmSync(dir, { recursive: true, force: true });
    jobs.delete(id);
  }, KEEP_MS).unref();
  return job;
}

function progressOf(job) {
  if (job.status === "done") return 100;
  if (job.phase === "connecting") {
    const t = (Date.now() - job.started) / 1000;
    return CONNECT_SHARE * (1 - Math.exp(-t / 1.4));
  }
  const total = job.meta?.duration;
  if (!total) return CONNECT_SHARE;
  return Math.min(99, CONNECT_SHARE + (100 - CONNECT_SHARE) * (job.encoded / total));
}

function exitCode(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (o, k) => (o && o[k] != null ? { [k]: o[k] } : {});
const safeName = (s) => s.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 150) || "audio";

function fail(job, message) {
  if (job.status !== "working") return;
  job.status = "error";
  job.error = message;
  job.procs.forEach((p) => p.kill());
}

function friendlyError(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes("private video")) return "This video is private, so it can't be converted.";
  if (s.includes("confirm your age") || s.includes("age-restricted")) return "This video is age-restricted, so it can't be converted.";
  if (s.includes("unavailable") || s.includes("not available")) return "That video is unavailable. Check the link and try again.";
  if (s.includes("incomplete youtube id") || s.includes("is not a valid url") || s.includes("unsupported url")) return "That link doesn't point to a video. Copy the link from the video page.";
  if (s.includes("unable to download") || s.includes("network")) return "YouTube didn't respond. Check your connection and try again.";
  const last = stderr.trim().split("\n").filter((l) => l.startsWith("ERROR")).pop();
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, "") : "The conversion stopped unexpectedly. Try again.";
}

function publicJob(j) {
  const out = {
    id: j.id, status: j.status, phase: j.phase, percent: Math.round(progressOf(j) * 10) / 10,
    encoded: Math.round(j.encoded * 10) / 10, meta: j.meta, error: j.error,
  };
  if (j.status === "done") {
    const size = fs.statSync(j.file).size;
    out.size = size;
    if (j.meta?.duration) out.kbps = Math.round((size * 8) / j.meta.duration / 1000);
  }
  return out;
}

function send(res, code, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(code, {
    "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(ROOT, "public/index.html")).pipe(res);
  }

  if (req.method === "POST" && pathname === "/api/convert") {
    const { url } = await readJson(req);
    const clean = cleanUrl(url);
    if (!clean) return send(res, 400, { error: "That isn't a YouTube link. Paste a link from youtube.com or youtu.be." });
    return send(res, 200, publicJob(startJob(clean)));
  }

  let m;
  if (req.method === "GET" && (m = pathname.match(/^\/api\/job\/([a-f0-9]{16})$/))) {
    const job = jobs.get(m[1]);
    return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: "This conversion has expired. Paste the link again." });
  }

  if (req.method === "GET" && (m = pathname.match(/^\/api\/file\/([a-f0-9]{16})$/))) {
    const job = jobs.get(m[1]);
    if (!job || job.status !== "done") return send(res, 404, "This file has expired. Paste the link again.");
    const name = job.name;
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const size = fs.statSync(job.file).size;
    // ?play=1 serves it for the in-page player (with seeking); otherwise it's a download.
    const disposition = searchParams.get("play") ? "inline" : "attachment";
    const headers = {
      "Content-Type": "audio/mpeg",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return send(res, 416, "", { "Content-Range": `bytes */${size}` });
      res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
      return fs.createReadStream(job.file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    return fs.createReadStream(job.file).pipe(res);
  }

  send(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`YouTube → MP3 is running at http://localhost:${PORT}`);
});
