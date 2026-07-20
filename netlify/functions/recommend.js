// ============================================================
// 心情推薦代理（後端防護層）
// 前端 → 本 Function → Groq API
// GROQ_API_KEY 只存在 Netlify 環境變數，永遠不會出現在前端程式碼
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// 簡易意圖分類器：比 AI 更可靠，先判斷 obvious 情況
function classifyIntent(input) {
  const m = input.trim();

  // === play：明確指定歌手 + 歌曲，或說了「我想聽/播放/點播 + 歌名」===
  const playKeywords = /我想聽|播放|點播|聽一下|來一首|給我|放一首|找一下/;
  if (playKeywords.test(m) && m.length > 3) return "play";
  // "歌手 歌曲" 格式：兩個中文詞組之間有空格，且整體不太長（避免把心情描述當成 play）
  if (m.includes(" ") && m.length > 4 && m.length <= 20) {
    const parts = m.split(/\s+/).filter(Boolean);
    // 兩個詞，且至少一個詞包含中文字，才視為「歌手 歌曲」
    if (parts.length === 2 && parts.some((p) => /[\u4e00-\u9fa5]/.test(p))) return "play";
  }
  if (/[\u4e00-\u9fa5]+[-–—][\u4e00-\u9fa5]+/.test(m)) return "play"; // "周杰倫-晴天"

  // === browse：只輸入歌手名字（沒有空格、沒有情緒詞、長度適中）===
  const moodKeywords = /開心|難過|生氣|緊張|無聊|想睡|累|悶|煩|傷心|難受|興奮|激動|平靜|放鬆|壓力|考試|成績|朋友|家人|愛|喜歡|討厭|害怕|擔心|焦慮|憤怒|失落|沮喪|疲憊|舒服|溫暖|感動|驕傲|自信|勇敢|堅強|開心|快樂|難過|傷心|生氣|無聊/;
  if (!moodKeywords.test(m) && !m.includes(" ") && m.length >= 2 && m.length <= 8) {
    return "browse";
  }

  return "recommend";
}

// 兒童安全 System Prompt：
// - 只推薦適合兒童、歌詞健康的歌
// - 必須是 YouTube 上容易找到的知名歌曲
// - 強制純 JSON 輸出（搭配 response_format 雙重保險）
// 兩種 Prompt：play（指定歌曲）與 recommend（心情推薦）
const PLAY_PROMPT = `使用者指定了一首想聽的歌曲。請從他的輸入中辨識出「歌名」與「歌手」，輸出 JSON。

規則：
1. 只能推薦適合兒童聆聽的歌曲：歌詞健康正面、無不雅內容、無成人主題。
2. 優先推薦華語流行歌曲，且必須是在 YouTube 上很容易找到的知名歌曲。
3. 歌曲必須真實存在，絕對不可編造歌名或歌手名稱。
4. reason 用 20 字以內、國小學生看得懂的繁體中文，語氣溫暖。
5. 只能輸出一個 JSON：{"song": "歌名", "artist": "歌手", "reason": "理由"}
不可輸出任何其他文字。`;

const RECOMMEND_PROMPT = `使用者描述了現在的心情或情境。請推薦一首適合的歌曲。

規則：
1. 只能推薦適合兒童聆聽的歌曲：歌詞健康正面、無不雅內容、無成人主題。
2. 優先推薦華語流行歌曲，且必須是在 YouTube 上很容易找到的知名歌曲。
3. 歌曲必須真實存在，絕對不可編造歌名或歌手名稱。
4. reason 用 20 字以內、國小學生看得懂的繁體中文，語氣溫暖、鼓勵。
5. 只能輸出一個 JSON：{"song": "歌名", "artist": "歌手", "reason": "推薦理由"}
不可輸出任何其他文字。`;

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 輸入清理：限制長度，避免惡意長文消耗 token
  let mood;
  try {
    const body = await req.json();
    mood = String(body.mood ?? "").trim().slice(0, 200);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!mood) {
    return Response.json({ error: "mood is required" }, { status: 400 });
  }

  // === 意圖分類（規則優先，比 AI 更可靠） ===
  const intent = classifyIntent(mood);

  // === browse：直接回傳歌手名，不耗費 AI token ===
  if (intent === "browse") {
    return Response.json({ intent: "browse", artist: mood });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY is not set");
    return Response.json({ error: "點唱機還沒準備好，請稍後再試" }, { status: 500 });
  }

  // === play / recommend：呼叫 Groq AI ===
  const systemPrompt = intent === "play" ? PLAY_PROMPT : RECOMMEND_PROMPT;

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
        return Response.json({ error: "AI 服務暫時休息中，請稍後再試" }, { status: 502 });
      }

      const data = await groqRes.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content);

      if (!parsed.song || !parsed.artist) {
        throw new Error("AI 回傳缺少 song 或 artist 欄位");
      }

      return Response.json({
        intent,
        song: String(parsed.song),
        artist: String(parsed.artist),
        reason: String(parsed.reason ?? ""),
      });
    } catch (err) {
      console.warn(`recommend attempt ${attempt} failed:`, err);
    }
  }

  return Response.json({ error: "點唱機打盹了，請再試一次" }, { status: 502 });
};
