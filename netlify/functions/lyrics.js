// ============================================================
// 歌詞查詢代理（多源 fallback）
// 主源：LRCLIB（https://lrclib.net/）— 免費、開源、支援時間戳
// 備援：lyrics.ovh（https://lyrics.ovh/）— 社群推薦度高、免費 RESTful
// ============================================================

const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const OVH_BASE = "https://api.lyrics.ovh/v1";

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

  // ---------- 來源 1：LRCLIB ----------
  try {
    const q = encodeURIComponent(`${artist} ${song}`);
    const res = await fetch(`${LRCLIB_SEARCH}?q=${q}`, {
      headers: { "User-Agent": "MoodJukebox/1.0 (https://mood-jukebox.netlify.app)" },
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        const lyrics = first.plainLyrics ?? "";
        if (lyrics.trim()) {
          return Response.json({
            lyrics: lyrics.trim(),
            source: "lrclib",
            title: first.trackName ?? song,
            artist: first.artistName ?? artist,
          });
        }
      }
    } else {
      console.warn(`LRCLIB error ${res.status}`);
    }
  } catch (err) {
    console.warn("LRCLIB fetch error:", err);
  }

  // ---------- 來源 2：lyrics.ovh（社群熱門備援） ----------
  try {
    const ovhUrl = `${OVH_BASE}/${encodeURIComponent(artist)}/${encodeURIComponent(song)}`;
    const res = await fetch(ovhUrl, { headers: { "Accept": "application/json" } });
    if (res.ok) {
      const data = await res.json();
      const lyrics = data.lyrics ?? "";
      if (lyrics.trim()) {
        return Response.json({
          lyrics: lyrics.trim(),
          source: "lyrics.ovh",
          title: song,
          artist: artist,
        });
      }
    } else {
      console.warn(`lyrics.ovh error ${res.status}`);
    }
  } catch (err) {
    console.warn("lyrics.ovh fetch error:", err);
  }

  // ---------- 都沒找到 ----------
  return Response.json({
    lyrics: "",
    source: null,
    message: "暫未找到這首歌的歌詞，歌詞庫持續擴充中 🎵",
  });
};
