// ============================================================
// 心情推薦代理（後端防護層）
// 前端 → 本 Function → Groq API
// GROQ_API_KEY 只存在 Netlify 環境變數，永遠不會出現在前端程式碼
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// 兒童安全 System Prompt：
// - 只推薦適合兒童、歌詞健康的歌
// - 必須是 YouTube 上容易找到的知名歌曲
// - 強制純 JSON 輸出（搭配 response_format 雙重保險）
const SYSTEM_PROMPT = `你是一台專為國小高年級學生設計的「心情點唱機」。
使用者會告訴你他現在的心情，你要推薦一首適合的歌曲。

規則（必須嚴格遵守）：
1. 只能推薦適合兒童聆聽的歌曲：歌詞健康正面、無不雅內容、無成人主題。
2. 優先推薦華語流行歌曲，且必須是在 YouTube 上很容易找到的知名歌曲（知名歌手、正式發行）。
3. 歌曲必須真實存在，絕對不可編造歌名或歌手名稱。
4. reason 用 20 字以內、國小學生看得懂的繁體中文，語氣溫暖、鼓勵。
5. 只能輸出一個 JSON 物件，格式為：{"song": "歌名", "artist": "歌手", "reason": "推薦理由"}
   不可輸出任何其他文字、說明或 markdown 標記。`;

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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY is not set");
    return Response.json({ error: "點唱機還沒準備好，請稍後再試" }, { status: 500 });
  }

  // 失敗時自動重試一次（AI 偶爾會回非預期格式）
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
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `我現在的心情是：${mood}` },
          ],
          temperature: 0.8,
          max_tokens: 256,
          // JSON mode：API 層級強制輸出合法 JSON
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
      const parsed = JSON.parse(content); // 若格式異常會丟出 → 進 catch 重試

      if (!parsed.song || !parsed.artist) {
        throw new Error("AI 回傳缺少 song 或 artist 欄位");
      }

      return Response.json({
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
