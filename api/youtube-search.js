// ============================================================
// YouTube 搜尋代理（後端防護層）— Vercel Serverless Function
// 前端 → 本 Function → YouTube Data API v3
// YOUTUBE_API_KEY 只存在 Vercel 環境變數
// ⚠️ 注意配額：search 一次消耗 100 單位（每日免費 10,000）
//    前端會先查 Firestore 快取，只有沒快取才會呼叫這裡
// ============================================================

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

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

export default async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = await readJSON(req);
  if (!body) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const mode = body.mode ?? "play";
  const song = String(body.song ?? "").trim().slice(0, 100);
  const artist = String(body.artist ?? "").trim().slice(0, 100);

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set");
    return res.status(500).json({ error: "點唱機還沒準備好，請稍後再試" });
  }

  // ===== 模式一：browse（只搜歌手，回傳多首歌曲清單） =====
  if (mode === "browse") {
    if (!artist) {
      return res.status(400).json({ error: "artist is required for browse mode" });
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
      return res.status(502).json({ error: "搜尋歌手時遇到問題，請稍後再試" });
    }

    const data = await ytRes.json();
    const items = (data.items ?? [])
      .filter((i) => i?.id?.videoId && i?.snippet?.title)
      .map((i) => ({
        videoId: i.id.videoId,
        title: i.snippet.title,
      }));

    if (items.length === 0) {
      return res.status(404).json({ error: "找不到這位歌手的歌曲" });
    }

    return res.json({ mode: "browse", artist, items });
  }

  // ===== 模式二：play（搜尋特定歌曲，回傳單一結果） =====
  if (!song || !artist) {
    return res.status(400).json({ error: "song and artist are required" });
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: `${artist} ${song} MV`,
    type: "video",
    videoCategoryId: "10",
    safeSearch: "strict",
    videoEmbeddable: "true",
    maxResults: "5",
    key: apiKey,
  });

  const ytRes = await fetch(`${SEARCH_URL}?${params}`);
  if (!ytRes.ok) {
    const text = await ytRes.text();
    console.error(`YouTube API error ${ytRes.status}:`, text);
    return res.status(502).json({ error: "找不到歌曲的影片，請再試一次" });
  }

  const data = await ytRes.json();

  const lyricKeywords = ["歌詞版", "歌詞", "lyrics", "lyric", "字幕", "純歌詞", "動態歌詞", "static lyrics"];
  const isLyricsVideo = (title) => lyricKeywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()));

  let item = data.items?.find((i) => i?.id?.videoId && i?.snippet?.title && !isLyricsVideo(i.snippet.title));
  if (!item) item = data.items?.[0];

  if (!item?.id?.videoId) {
    return res.status(404).json({ error: "找不到這首歌的影片" });
  }

  return res.json({
    mode: "play",
    videoId: item.id.videoId,
    title: item.snippet.title,
  });
};
