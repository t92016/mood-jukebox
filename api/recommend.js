// ============================================================
// 心情推薦代理（後端防護層）— Vercel Serverless Function
// 前端 → 本 Function → Groq API
// GROQ_API_KEY 只存在 Vercel 環境變數，永遠不會出現在前端程式碼
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// Helper: 讀取 JSON body（Node.js raw stream）
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

// 簡易意圖分類器：比 AI 更可靠，先判斷 obvious 情況
function classifyIntent(input) {
  const m = input.trim();

  const hasChinese = (s) => {
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i);
      if (cp >= 0x4e00 && cp <= 0x9fff) return true;
    }
    return false;
  };

  const playCmds = ["我想聽", "播放", "點播", "聽一下", "來一首", "給我", "放一首", "找一下"];
  if (playCmds.some((cmd) => m.includes(cmd)) && m.length > 3) return "play";

  if (m.includes(" ") && m.length > 4 && m.length <= 20) {
    const parts = m.split(/\s+/).filter(Boolean);
    if (parts.length === 2 && parts.some(hasChinese)) return "play";
  }

  const dashParts = m.split(/[-–—]/);
  if (dashParts.length === 2 && dashParts.every(hasChinese)) return "play";

  const moodWords = ["開心", "難過", "生氣", "緊張", "無聊", "想睡", "累", "悶", "煩", "傷心", "難受", "興奮", "激動", "平靜", "放鬆", "壓力", "考試", "成績", "朋友", "家人", "愛", "喜歡", "討厭", "害怕", "擔心", "焦慮", "憤怒", "失落", "沮喪", "疲憊", "舒服", "溫暖", "感動", "驕傲", "自信", "勇敢", "堅強", "快樂"];
  const isMood = moodWords.some((w) => m.includes(w));
  if (!isMood && !m.includes(" ") && m.length >= 2 && m.length <= 8) {
    return "browse";
  }

  return "recommend";
}

const PLAY_PROMPT = `使用者指定了一首想聽的歌曲。請從他的輸入中辨識出「歌名」與「歌手」，輸出 JSON。

規則：
1. 只能推薦適合兒童聆聽的歌曲：歌詞健康正面、無不雅內容、無成人主題。
2. 優先推薦華語流行歌曲，且必須是在 YouTube 上很容易找到的知名歌曲。
3. 歌曲必須真實存在，絕對不可編造歌名或歌手名稱。如果你不確定這首歌是否存在，請改推薦一首你確定存在的經典華語歌曲。
4. reason 用 20 字以內、國小學生看得懂的繁體中文，語氣溫暖。
5. 只能輸出一個 JSON：{"song": "歌名", "artist": "歌手", "reason": "理由"}
不可輸出任何其他文字。`;

const CHAT_PROMPT = `你是「心情點唱機」的 AI 點歌員，專門跟國小高年級學生聊天、推薦歌曲。

規則：
1. 語氣溫暖、簡短、像大朋友一樣，用繁體中文。
2. 每次只推薦一首歌。
3. 如果使用者說「換一首」、「不喜歡」、「改心情」、「重新選」、「換」，你就換一首不同歌。
4. 如果使用者說「播放」、「聽這首」、「就這首」、「確認」，回覆「好！準備播放～」即可，不需要換歌。
5. 只推薦真實存在的知名歌曲（KTV 熱門、排行榜、經典老歌），絕對不可編造。如果不確定，改推薦經典歌曲。
6. 只能輸出一個 JSON：{"reply": "對話文字", "song": "歌名", "artist": "歌手", "reason": "推薦理由"}
不可輸出任何其他文字。`;

export default async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = await readJSON(req);
  if (!body) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  // ===== 模式 A：多輪對話（messages 陣列）=====
  if (body.messages && Array.isArray(body.messages)) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("GROQ_API_KEY is not set");
      return res.status(500).json({ error: "點唱機還沒準備好，請稍後再試" });
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const groqRes = await fetch(GROQ_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            messages: body.messages,
            temperature: 0.8,
            max_tokens: 256,
            response_format: { type: "json_object" },
          }),
        });

        if (!groqRes.ok) {
          const text = await groqRes.text();
          console.error(`Groq API error ${groqRes.status}:`, text);
          return res.status(502).json({ error: "AI 服務暫時休息中，請稍後再試" });
        }

        const data = await groqRes.json();
        const content = data.choices?.[0]?.message?.content ?? "";
        const parsed = JSON.parse(content);

        if (!parsed.song || !parsed.artist) {
          throw new Error("AI 回傳缺少 song 或 artist 欄位");
        }

        return res.json({
          intent: body.intent || "recommend",
          reply: String(parsed.reply ?? ""),
          song: String(parsed.song),
          artist: String(parsed.artist),
          reason: String(parsed.reason ?? ""),
        });
      } catch (err) {
        console.warn(`chat attempt ${attempt} failed:`, err);
      }
    }
    return res.status(502).json({ error: "點唱機打盹了，請再試一次" });
  }

  // ===== 模式 B：單輪輸入（mood 字串，向後相容）=====
  const mood = String(body.mood ?? "").trim().slice(0, 200);
  if (!mood) {
    return res.status(400).json({ error: "mood or messages is required" });
  }

  const intent = classifyIntent(mood);

  if (intent === "browse") {
    return res.json({ intent: "browse", artist: mood });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY is not set");
    return res.status(500).json({ error: "點唱機還沒準備好，請稍後再試" });
  }

  const systemPrompt = intent === "play" ? PLAY_PROMPT : CHAT_PROMPT;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const groqRes = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: mood },
          ],
          temperature: 0.7,
          max_tokens: 256,
          response_format: { type: "json_object" },
        }),
      });

      if (!groqRes.ok) {
        const text = await groqRes.text();
        console.error(`Groq API error ${groqRes.status}:`, text);
        return res.status(502).json({ error: "AI 服務暫時休息中，請稍後再試" });
      }

      const data = await groqRes.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content);

      if (!parsed.song || !parsed.artist) {
        throw new Error("AI 回傳缺少 song 或 artist 欄位");
      }

      return res.json({
        intent,
        reply: String(parsed.reply ?? ""),
        song: String(parsed.song),
        artist: String(parsed.artist),
        reason: String(parsed.reason ?? ""),
      });
    } catch (err) {
      console.warn(`recommend attempt ${attempt} failed:`, err);
    }
  }

  return res.status(502).json({ error: "點唱機打盹了，請再試一次" });
};
