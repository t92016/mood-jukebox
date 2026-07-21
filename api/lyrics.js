// ============================================================
// 歌詞查詢代理（多源 fallback + 容錯）— Vercel Serverless Function
// 主源：LRCLIB（https://lrclib.net/）— 免費、開源、支援時間戳
// 備援：lyrics.ovh（https://lyrics.ovh/）— 社群熱推、免費 RESTful
// 策略：先試 "歌手+歌名"，若失敗再試只用 "歌名"
// ============================================================

const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const OVH_BASE = "https://api.lyrics.ovh/v1";

// Helper: 讀取 JSON body
async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 輔助：統一 fetch 帶超時
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// 輔助：查詢 LRCLIB
async function searchLRCLIB(q) {
  try {
    const res = await fetchWithTimeout(`${LRCLIB_SEARCH}?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": "MoodJukebox/1.0" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      const lyrics = first.plainLyrics ?? "";
      if (lyrics.trim()) {
        return {
          lyrics: lyrics.trim(),
          source: "lrclib",
          title: first.trackName,
          artist: first.artistName,
        };
      }
    }
  } catch (err) {
    console.warn("LRCLIB error:", err.message);
  }
  return null;
}

// 輔助：查詢 lyrics.ovh
async function searchOVH(artist, song) {
  try {
    const res = await fetchWithTimeout(`${OVH_BASE}/${encodeURIComponent(artist)}/${encodeURIComponent(song)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const lyrics = data.lyrics ?? "";
    if (lyrics.trim()) {
      return { lyrics: lyrics.trim(), source: "lyrics.ovh", title: song, artist };
    }
  } catch (err) {
    console.warn("lyrics.ovh error:", err.message);
  }
  return null;
}

export default async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let song = "";
  let artist = "";

  if (req.method === "GET") {
    song = String(req.query.song ?? "").trim();
    artist = String(req.query.artist ?? "").trim();
  } else {
    const body = await readJSON(req);
    song = String(body?.song ?? "").trim();
    artist = String(body?.artist ?? "").trim();
  }

  if (!song || !artist) {
    return res.status(400).json({ error: "song and artist are required" });
  }

  let result = null;

  result = await searchLRCLIB(`${artist} ${song}`);
  if (result) return res.json(result);

  result = await searchOVH(artist, song);
  if (result) return res.json(result);

  result = await searchLRCLIB(song);
  if (result) return res.json(result);

  result = await searchOVH(song, artist);
  if (result) return res.json(result);

  return res.json({
    lyrics: "",
    source: null,
    message: "暫未找到這首歌的歌詞，歌詞庫持續擴充中 🎵",
  });
};
