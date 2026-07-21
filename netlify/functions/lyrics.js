// ============================================================
// 歌詞查詢代理（LRCLIB 免費開源歌詞庫）
// https://lrclib.net/docs
// 無 API Key、支援中文、提供 plainLyrics（靜態文字）
// ============================================================

const LRCLIB_SEARCH = "https://lrclib.net/api/search";

export default async (req) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 解析參數：支援 GET query 或 POST body
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

  try {
    // 用 "歌手 歌名" 搜尋 LRCLIB
    const q = encodeURIComponent(`${artist} ${song}`);
    const res = await fetch(`${LRCLIB_SEARCH}?q=${q}`, {
      headers: { "User-Agent": "MoodJukebox/1.0 (https://mood-jukebox.netlify.app)" },
    });

    if (!res.ok) {
      console.warn(`LRCLIB error ${res.status}`);
      return Response.json({ lyrics: "", source: "lrclib", error: "查詢失敗" });
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      return Response.json({ lyrics: "", source: "lrclib" });
    }

    // 取第一筆結果的 plainLyrics（靜態文字）
    const first = data[0];
    const lyrics = first.plainLyrics ?? "";

    return Response.json({
      lyrics: String(lyrics).trim(),
      source: "lrclib",
      title: first.trackName ?? song,
      artist: first.artistName ?? artist,
    });
  } catch (err) {
    console.error("LRCLIB fetch error:", err);
    return Response.json({ lyrics: "", source: "lrclib", error: "網路錯誤" });
  }
};
