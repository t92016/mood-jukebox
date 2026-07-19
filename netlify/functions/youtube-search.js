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

  let song, artist;
  try {
    const body = await req.json();
    song = String(body.song ?? "").trim().slice(0, 100);
    artist = String(body.artist ?? "").trim().slice(0, 100);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!song || !artist) {
    return Response.json({ error: "song and artist are required" }, { status: 400 });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set");
    return Response.json({ error: "點唱機還沒準備好，請稍後再試" }, { status: 500 });
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: `${artist} ${song}`,
    type: "video",
    videoCategoryId: "10",   // 限定音樂分類，提高命中率
    safeSearch: "strict",    // 兒童安全：嚴格過濾不當內容
    videoEmbeddable: "true", // 必須可嵌入，避免拿到不能播的影片
    maxResults: "1",
    key: apiKey,
  });

  const ytRes = await fetch(`${SEARCH_URL}?${params}`);
  if (!ytRes.ok) {
    const text = await ytRes.text();
    console.error(`YouTube API error ${ytRes.status}:`, text);
    return Response.json({ error: "找不到歌曲的影片，請再試一次" }, { status: 502 });
  }

  const data = await ytRes.json();
  const item = data.items?.[0];
  if (!item?.id?.videoId) {
    return Response.json({ error: "找不到這首歌的影片" }, { status: 404 });
  }

  return Response.json({
    videoId: item.id.videoId,
    title: item.snippet.title,
  });
};
