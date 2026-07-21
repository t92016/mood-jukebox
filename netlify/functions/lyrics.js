// ============================================================
// 歌詞查詢代理（多源 fallback + 容錯）
// 主源：LRCLIB（https://lrclib.net/）— 免費、開源、支援時間戳
// 備援：lyrics.ovh（https://lyrics.ovh/）— 社群熱推、免費 RESTful
// 策略：先試 "歌手+歌名"，若失敗再試只用 "歌名"
// ============================================================

const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const OVH_BASE = "https://api.lyrics.ovh/v1";

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
      headers: { "User-Agent": "MoodJukebox/1.0 (https://mood-jukebox.netlify.app)" },
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
      headers: { "Accept": "application/json" },
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

export default async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let song = "";
  let artist = "";
  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      song = String(url.searchParams.get("song") ?? "").trim();
      artist = String(url.searchParams.get("artist") ?? "").trim();
    } else {
      const body = await req.json();
      song = String(body.song ?? "").trim();
      artist = String(body.artist ?? "").trim();
    }
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!song || !artist) {
    return Response.json({ error: "song and artist are required" }, { status: 400 });
  }

  let result = null;

  // 策略 1：LRCLIB 用 "歌手 歌名"
  result = await searchLRCLIB(`${artist} ${song}`);
  if (result) return Response.json(result);

  // 策略 2：lyrics.ovh 用 "歌手 / 歌名"
  result = await searchOVH(artist, song);
  if (result) return Response.json(result);

  // 策略 3：LRCLIB 只用 "歌名"（歌手可能錯誤）
  result = await searchLRCLIB(song);
  if (result) return Response.json(result);

  // 策略 4：lyrics.ovh 只用 "歌名 / 歌手"（互換嘗試）
  result = await searchOVH(song, artist);
  if (result) return Response.json(result);

  // 都沒找到
  return Response.json({
    lyrics: "",
    source: null,
    message: "暫未找到這首歌的歌詞，歌詞庫持續擴充中 🎵",
  });
};
