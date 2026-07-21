// ============================================================
// YouTube 搜尋代理（後端防護層）
// 前端 → 本 Function → YouTube Data API v3
// YOUTUBE_API_KEY 只存在 Netlify 環境變數
// ⚠️ 注意配額：search 一次消耗 100 單位（每日免費 10,000）
//    前端會先查 Firestore 快取，只有沒快取才會呼叫這裡
// ============================================================

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let song, artist, mode;
  try {
    const body = await req.json();
    mode = body.mode ?? "play"; // "play" | "browse"
    song = String(body.song ?? "").trim().slice(0, 100);
    artist = String(body.artist ?? "").trim().slice(0, 100);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set");
    return Response.json({ error: "點唱機還沒準備好，請稍後再試" }, { status: 500 });
  }

  // ===== 模式一：browse（只搜歌手，回傳多首歌曲清單） =====
  if (mode === "browse") {
    if (!artist) {
      return Response.json({ error: "artist is required for browse mode" }, { status: 400 });
    }

    const params = new URLSearchParams({
      part: "snippet",
      q: `${artist} 歌曲`,
      type: "video",
      videoCategoryId: "10",
      safeSearch: "strict",
      videoEmbeddable: "true",
      maxResults: "12",
      key: apiKey,
    });

    const ytRes = await fetch(`${SEARCH_URL}?${params}`);
    if (!ytRes.ok) {
      const text = await ytRes.text();
      console.error(`YouTube API error ${ytRes.status}:`, text);
      return Response.json({ error: "搜尋歌手時遇到問題，請稍後再試" }, { status: 502 });
    }

    const data = await ytRes.json();
    const items = (data.items ?? [])
      .filter((i) => i?.id?.videoId && i?.snippet?.title)
      .map((i) => ({
        videoId: i.id.videoId,
        title: i.snippet.title,
      }));

    if (items.length === 0) {
      return Response.json({ error: "找不到這位歌手的歌曲" }, { status: 404 });
    }

    return Response.json({ mode: "browse", artist, items });
  }

  // ===== 模式二：play（搜尋特定歌曲，回傳單一結果） =====
  if (!song || !artist) {
    return Response.json({ error: "song and artist are required" }, { status: 400 });
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: `${artist} ${song} MV`,
    type: "video",
    videoCategoryId: "10",   // 限定音樂分類，提高命中率
    safeSearch: "strict",    // 兒童安全：嚴格過濾不當內容
    videoEmbeddable: "true", // 必須可嵌入，避免拿到不能播的影片
    maxResults: "5",
    key: apiKey,
  });

  const ytRes = await fetch(`${SEARCH_URL}?${params}`);
  if (!ytRes.ok) {
    const text = await ytRes.text();
    console.error(`YouTube API error ${ytRes.status}:`, text);
    return Response.json({ error: "找不到歌曲的影片，請再試一次" }, { status: 502 });
  }

  const data = await ytRes.json();

  // 過濾掉「歌詞版」「Lyrics」等純文字影片，優先找正常 MV
  const lyricKeywords = ["歌詞版", "歌詞", "lyrics", "lyric", "字幕", "純歌詞", "動態歌詞", "static lyrics"];
  const isLyricsVideo = (title) => lyricKeywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()));

  let item = data.items?.find((i) => i?.id?.videoId && i?.snippet?.title && !isLyricsVideo(i.snippet.title));
  // 如果全部都被過濾，就回傳第一筆（不強求）
  if (!item) item = data.items?.[0];

  if (!item?.id?.videoId) {
    return Response.json({ error: "找不到這首歌的影片" }, { status: 404 });
  }

  return Response.json({
    mode: "play",
    videoId: item.id.videoId,
    title: item.snippet.title,
  });
};
