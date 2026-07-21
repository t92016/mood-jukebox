// ============================================================
// 心情點唱機 前端主邏輯 v8
// 流程：心情輸入 → /api/recommend (Groq) → 互動對話選歌 → 確認播放
//       → Firestore 快取 + 心情日誌 → YouTube IFrame 播放 + 多源歌詞
// ============================================================
console.log("[Mood Jukebox] app.js v8 loaded — interactive chat mode enabled");

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc,
  collection, query, orderBy, limit, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);

// ---------- Firebase 初始化（未設定時優雅降級） ----------
let db = null;
try {
  if (!firebaseConfig.apiKey.startsWith("PASTE_")) {
    db = getFirestore(initializeApp(firebaseConfig));
  } else {
    console.info("Firebase 尚未設定，以無資料庫模式運作（可點歌但不保存紀錄）");
  }
} catch (err) {
  console.warn("Firebase 初始化失敗，以無資料庫模式運作", err);
}

// ---------- YouTube Player ----------
let ytPlayer = null;
let ytApiReady = false;
let pendingVideoId = null;

window._onYtReady = () => {
  ytApiReady = true;
  if (pendingVideoId) {
    playVideo(pendingVideoId);
    pendingVideoId = null;
  }
};

// 若 YouTube API 在模組載入前就已 ready，手動觸發
if (window.ytApiReady) {
  window._onYtReady();
}

function playVideo(videoId) {
  if (!ytApiReady || typeof YT === "undefined") {
    pendingVideoId = videoId;
    return;
  }
  if (ytPlayer) {
    ytPlayer.loadVideoById(videoId);
  } else {
    ytPlayer = new YT.Player("player", {
      width: "100%",
      height: "100%",
      videoId,
      playerVars: { rel: 0, modestbranding: 1 },
    });
  }
  updateControlsState();
  $("lyricsWrap").hidden = true; // 等歌曲資訊更新後再顯示
}

// ---------- UI 工具 ----------
function showStatus(msg) {
  $("statusArea").hidden = false;
  $("statusText").textContent = msg;
}

function hideStatus() {
  $("statusArea").hidden = true;
}

function setBusy(busy) {
  document.querySelectorAll(".mood-btn").forEach((b) => (b.disabled = busy));
  $("submitBtn").disabled = busy;
  $("moodInput").disabled = busy;
}

// ---------- API 呼叫 ----------
async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "點唱機打盹了，請再試一次");
  }
  return data;
}

// ---------- Firestore：快取與日誌 ----------
function cacheId(song, artist) {
  // Firestore 文件 ID 不可含 "/"
  return `${artist} - ${song}`.replaceAll("/", " ").slice(0, 200);
}

async function lookupCache(song, artist) {
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, "SongsCache", cacheId(song, artist)));
    return snap.exists() ? snap.data().videoId : null;
  } catch (err) {
    console.warn("讀取快取失敗", err);
    return null;
  }
}

async function saveCache(song, artist, videoId, videoTitle) {
  if (!db) return;
  try {
    await setDoc(doc(db, "SongsCache", cacheId(song, artist)), {
      song, artist, videoId,
      videoTitle: videoTitle ?? "",
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("寫入快取失敗", err);
  }
}

async function logMood(mood, rec, videoId) {
  if (!db) return;
  try {
    await addDoc(collection(db, "MoodLogs"), {
      mood,
      song: rec.song,
      artist: rec.artist,
      reason: rec.reason ?? "",
      videoId,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("寫入心情日誌失敗", err);
  }
}

// ---------- 心情點唱牆 ----------
async function loadWall() {
  const list = $("wallList");
  if (!db) {
    list.innerHTML = `<li class="wall-empty">點唱牆準備中 🌱</li>`;
    return;
  }
  try {
    const q = query(collection(db, "MoodLogs"), orderBy("createdAt", "desc"), limit(12));
    const snap = await getDocs(q);
    if (snap.empty) {
      list.innerHTML = `<li class="wall-empty">還沒有人點歌，來當第一個吧！</li>`;
      return;
    }
    list.innerHTML = snap.docs
      .map((d) => d.data())
      .map((log) => {
        const attrs = log.videoId
          ? `data-video-id="${escapeHtml(log.videoId)}" data-song="${escapeHtml(log.song)}" data-artist="${escapeHtml(log.artist)}" tabindex="0" role="button"`
          : "";
        return `<li><span class="wall-mood">「${escapeHtml(log.mood)}」</span> →
          <span class="wall-song" ${attrs}>
            🎵 ${escapeHtml(log.artist)}《${escapeHtml(log.song)}》
          </span></li>`;
      })
      .join("");
  } catch (err) {
    console.warn("載入點唱牆失敗", err);
    list.innerHTML = `<li class="wall-empty">點唱牆打瞌睡中 😴</li>`;
  }
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- 瀏覽模式暫存 ----------
let browseSongs = []; // { videoId, title, songName }

// ---------- 互動對話模式狀態 ----------
let chatHistory = [];     // Groq messages 陣列
let chatMode = false;     // 是否正在對話中
let pendingRec = null;    // 當前推薦的歌曲（等使用者確認）
let lastMoodText = "";    // 原始心情輸入文字（寫入日誌用）

// ---------- 顯示結果卡共用函式 ----------
function showResultCard({ label, title, artist, reason, hideBrowse }) {
  $("resultLabel").textContent = label ?? "🎁 為你點播";
  $("songTitle").textContent = title;
  $("songArtist").textContent = artist;
  $("songReason").textContent = reason ? `💬 ${reason}` : "";
  $("browseWrap").hidden = hideBrowse ?? true;
  $("resultArea").hidden = false;
  hideStatus();
  $("resultArea").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- 互動對話模式 ----------
function startChat(rec, moodText) {
  chatMode = true;
  pendingRec = rec;
  lastMoodText = moodText;

  // 初始化對話歷史
  chatHistory = [
    { role: "system", content: "你是「心情點唱機」的 AI 點歌員，專門跟國小高年級學生聊天、推薦歌曲。每次只推薦一首歌。如果使用者說換一首，你就換不同歌。只推薦真實存在的知名歌曲。輸出 JSON:{\"reply\":\"對話文字\",\"song\":\"歌名\",\"artist\":\"歌手\",\"reason\":\"推薦理由\"}" },
    { role: "user", content: moodText },
    { role: "assistant", content: JSON.stringify({ reply: rec.reply, song: rec.song, artist: rec.artist, reason: rec.reason }) },
  ];

  // 顯示對話 UI、隱藏播放器
  $("resultArea").hidden = false;
  $("chatWrap").hidden = false;
  $("playerView").hidden = true;
  $("chatMessages").innerHTML = "";
  $("chatInput").value = "";
  $("chatInput").disabled = false;
  $("chatSendBtn").disabled = false;

  // 顯示 AI 第一條訊息
  addChatBubble("ai", rec.reply, rec);
  hideStatus();
  $("resultArea").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function addChatBubble(role, text, rec = null) {
  const container = $("chatMessages");
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;

  const p = document.createElement("p");
  p.textContent = text;
  bubble.appendChild(p);

  // AI 訊息附帶操作按鈕
  if (role === "ai" && rec) {
    const actions = document.createElement("div");
    actions.className = "chat-actions";

    const btnPlay = document.createElement("button");
    btnPlay.className = "chat-action-btn primary";
    btnPlay.textContent = `▶ 播放這首（${rec.artist}《${rec.song}》）`;
    btnPlay.addEventListener("click", () => confirmPlay());

    const btnChange = document.createElement("button");
    btnChange.className = "chat-action-btn secondary";
    btnChange.textContent = "🔄 換一首（AI 幫你選）";
    btnChange.addEventListener("click", () => sendChatMessage("幫我換一首"));

    actions.appendChild(btnPlay);
    actions.appendChild(btnChange);
    bubble.appendChild(actions);
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage(userText) {
  if (!userText.trim()) return;

  // 顯示使用者訊息
  addChatBubble("user", userText);
  chatHistory.push({ role: "user", content: userText });

  // 暫時鎖定輸入
  $("chatInput").disabled = true;
  $("chatSendBtn").disabled = true;
  showStatus("🤖 AI 正在思考……");

  try {
    const rec = await postJSON("/api/recommend", { messages: chatHistory, intent: "recommend" });

    // 更新歷史與待播歌曲
    chatHistory.push({
      role: "assistant",
      content: JSON.stringify({ reply: rec.reply, song: rec.song, artist: rec.artist, reason: rec.reason }),
    });
    pendingRec = rec;

    // 顯示 AI 回覆
    addChatBubble("ai", rec.reply, rec);
    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus(`😴 ${err.message || "AI 打盹了，請再試一次"}`);
  } finally {
    $("chatInput").disabled = false;
    $("chatSendBtn").disabled = false;
    $("chatInput").focus();
    setBusy(false);
  }
}

async function confirmPlay() {
  if (!pendingRec) return;
  const { song, artist, reason } = pendingRec;

  // 切換回播放器畫面
  chatMode = false;
  $("chatWrap").hidden = true;
  $("playerView").hidden = false;

  // 顯示歌曲資訊
  showResultCard({ title: `《${song}》`, artist, reason });

  // 載入影片
  let videoId = await lookupCache(song, artist);
  if (!videoId) {
    const yt = await postJSON("/api/youtube-search", { song, artist });
    videoId = yt.videoId;
    await saveCache(song, artist, videoId, yt.title);
  }

  playVideo(videoId);
  await updateLyrics(song, artist);

  // 寫入日誌
  logMood(lastMoodText, pendingRec, videoId).then(loadWall).catch(() => {});
}

// ---------- 主流程 ----------
async function handleMood(mood) {
  setBusy(true);
  $("resultArea").hidden = true;
  browseSongs = [];
  $("songSelect").innerHTML = `<option value="" disabled selected>— 請選擇歌曲 —</option>`;
  $("playSelectedBtn").disabled = true;
  showStatus("🔮 正在感受你的心情……");

  try {
    const rec = await postJSON("/api/recommend", { mood });
    const intent = rec.intent || "recommend";

    // ===== 意圖 A：直接播放指定歌曲 =====
    if (intent === "play") {
      showStatus("🎧 找到了！準備唱片中……");
      let videoId = await lookupCache(rec.song, rec.artist);
      if (!videoId) {
        const yt = await postJSON("/api/youtube-search", { song: rec.song, artist: rec.artist });
        videoId = yt.videoId;
        await saveCache(rec.song, rec.artist, videoId, yt.title);
      }
      logMood(mood, rec, videoId).then(loadWall).catch(() => {});
      showResultCard({ title: `《${rec.song}》`, artist: rec.artist, reason: rec.reason });
      playVideo(videoId);
      await updateLyrics(rec.song, rec.artist);
      return;
    }

    // ===== 意圖 B：瀏覽歌手歌曲清單 =====
    if (intent === "browse") {
      showStatus(`🎹 正在搜尋 ${rec.artist} 的歌曲……`);
      const yt = await postJSON("/api/youtube-search", { mode: "browse", artist: rec.artist });
      browseSongs = yt.items.map((it) => ({
        videoId: it.videoId,
        title: it.title,
        songName: extractSongName(it.title),
      }));
      const select = $("songSelect");
      browseSongs.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.videoId;
        opt.textContent = s.title;
        select.appendChild(opt);
      });
      showResultCard({
        label: `🎤 ${rec.artist} 的歌曲`,
        title: "",
        artist: `請從下方選擇一首 ${rec.artist} 的歌`,
        reason: "",
        hideBrowse: false,
      });
      $("songArtist").dataset.queryArtist = rec.artist;
      updateControlsState();
      return;
    }

    // ===== 意圖 C：依心情推薦 → 進入互動對話 =====
    startChat(rec, mood);
  } catch (err) {
    console.error(err);
    showStatus(`😴 ${err.message || "點唱機打盹了，再試一次吧！"}`);
  } finally {
    setBusy(false);
  }
}

// 從 YouTube 標題猜測歌曲名稱（簡易版）
function extractSongName(title) {
  // 去掉常見後綴
  let name = title
    .replace(/\s*[-–—]\s*(Official|MV|M\/V|Audio|Lyric|Video|Music|Live|Cover|翻唱|官方|歌詞|完整版|HD|4K).*$/i, "")
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/\s*【.*?】\s*/g, "")
    .trim();
  // 取 "歌手 - 歌名" 或 "歌手 — 歌名" 的後半段
  const parts = name.split(/\s*[-–—]\s*/);
  if (parts.length >= 2) return parts[parts.length - 1].trim();
  return name;
}

// 從 YouTube 標題猜測歌手名稱（取 "歌手 - 歌名" 的前半段）
function extractArtistName(title) {
  let name = title
    .replace(/\s*[-–—]\s*(Official|MV|M\/V|Audio|Lyric|Video|Music|Live|Cover|翻唱|官方|歌詞|完整版|HD|4K).*$/i, "")
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/\s*【.*?】\s*/g, "")
    .trim();
  const parts = name.split(/\s*[-–—]\s*/);
  if (parts.length >= 2) return parts[0].trim();
  return "";
}

// 瀏覽模式：播放選中的歌曲
async function playBrowseSelection(videoId) {
  const song = browseSongs.find((s) => s.videoId === videoId);
  if (!song) return;

  // 從 YouTube 標題解析真正的歌手名，比用 UI 文字更準確
  const artistFromTitle = extractArtistName(song.title);
  const queryArtist = $("songArtist").dataset.queryArtist || "";
  const rec = {
    song: song.songName || extractSongName(song.title),
    artist: artistFromTitle || queryArtist,
  };

  // 隱藏下拉選單、顯示播放器
  $("browseWrap").hidden = true;
  playVideo(videoId);

  // 寫入快取與日誌（用正確的歌手名）
  await saveCache(rec.song, rec.artist, videoId, song.title);
  logMood("browse: " + (queryArtist || rec.artist), rec, videoId).then(loadWall).catch(() => {});
}

// ---------- 播放狀態與控制 ----------
let currentBrowseIndex = -1;
let isPlaying = false;

async function updateLyrics(song, artist) {
  console.log(`[Lyrics] 載入: ${artist} - ${song}`);
  $("lyricsText").textContent = "正在載入歌詞…… 🎵";
  $("lyricsWrap").hidden = false;
  $("lyricsContent").classList.add("collapsed");
  $("btnToggleLyrics").textContent = "展開 ▼";

  try {
    const url = `/api/lyrics?song=${encodeURIComponent(song)}&artist=${encodeURIComponent(artist)}`;
    console.log(`[Lyrics] API: ${url}`);
    const res = await fetch(url);
    console.log(`[Lyrics] 狀態: ${res.status}`);
    const data = await res.json();
    console.log(`[Lyrics] 回傳長度: ${data.lyrics?.length ?? 0}, 來源: ${data.source ?? "none"}`);
    const text = data.lyrics?.trim()
      ? data.lyrics
      : (data.message ?? "暫無歌詞，靜心聆聽音樂吧～ 🎵\n\n（歌詞庫持續擴充中）");
    $("lyricsText").textContent = text;
  } catch (err) {
    console.warn("[Lyrics] 載入失敗", err);
    $("lyricsText").textContent = "暫無歌詞，靜心聆聽音樂吧～ 🎵\n\n（歌詞庫持續擴充中）";
  }
}

function toggleLyrics() {
  const content = $("lyricsContent");
  const btn = $("btnToggleLyrics");
  if (content.classList.contains("collapsed")) {
    content.classList.remove("collapsed");
    btn.textContent = "收合 ▲";
  } else {
    content.classList.add("collapsed");
    btn.textContent = "展開 ▼";
  }
}

function updateControlsState() {
  const hasPlayer = ytPlayer !== null;
  $("btnPlayPause").disabled = !hasPlayer;
  $("btnNext").disabled = !hasPlayer;
  $("btnPrev").disabled = !hasPlayer || currentBrowseIndex < 0;
}

function togglePlayPause() {
  if (!ytPlayer) return;
  const state = ytPlayer.getPlayerState?.();
  if (state === YT.PlayerState.PLAYING) {
    ytPlayer.pauseVideo();
    $("btnPlayPause").textContent = "▶";
    isPlaying = false;
  } else {
    ytPlayer.playVideo();
    $("btnPlayPause").textContent = "⏸";
    isPlaying = true;
  }
}

async function playNext() {
  if (browseSongs.length > 0 && currentBrowseIndex >= 0) {
    // 瀏覽模式：播放下一首
    currentBrowseIndex = (currentBrowseIndex + 1) % browseSongs.length;
    const next = browseSongs[currentBrowseIndex];
    $("songSelect").value = next.videoId;
    await playBrowseSelection(next.videoId);
    await updateLyrics(next.songName || next.title, $("songArtist").textContent.replace(/^.*請從下方選擇一首\s*/, "").trim());
  } else {
    // 非瀏覽模式：觸發隨機心情推薦
    const moods = ["開心", "難過", "生氣", "想睡", "緊張", "無聊"];
    await handleMood(moods[Math.floor(Math.random() * moods.length)]);
  }
}

async function playPrev() {
  if (browseSongs.length > 0 && currentBrowseIndex > 0) {
    currentBrowseIndex = currentBrowseIndex - 1;
    const prev = browseSongs[currentBrowseIndex];
    $("songSelect").value = prev.videoId;
    await playBrowseSelection(prev.videoId);
    await updateLyrics(prev.songName || prev.title, $("songArtist").textContent.replace(/^.*請從下方選擇一首\s*/, "").trim());
  }
}

function setVolume(val) {
  if (!ytPlayer) return;
  ytPlayer.setVolume(Number(val));
  const icon = $("volumeSlider").previousElementSibling || $("controlsBar").querySelector(".volume-icon");
  if (icon) {
    icon.textContent = val == 0 ? "🔇" : val < 40 ? "🔉" : "🔊";
  }
}

function doRandomPlay() {
  // 隨機挑一個心情按鈕的主題
  const moods = ["開心", "難過", "生氣", "想睡", "緊張", "無聊"];
  const mood = moods[Math.floor(Math.random() * moods.length)];
  handleMood(mood);
}

// 監聽 YouTube 播放器狀態變化（需輪詢，因為 onStateChange 有時不穩定）
setInterval(() => {
  if (ytPlayer && ytPlayer.getPlayerState) {
    const state = ytPlayer.getPlayerState();
    $("btnPlayPause").textContent = state === YT.PlayerState.PLAYING ? "⏸" : "▶";
    isPlaying = state === YT.PlayerState.PLAYING;
  }
}, 1000);

// ---------- 事件綁定 ----------
$("moodButtons").addEventListener("click", (e) => {
  const btn = e.target.closest(".mood-btn");
  if (btn && !btn.disabled) handleMood(btn.dataset.mood);
});

$("moodForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const mood = $("moodInput").value.trim();
  if (mood) {
    handleMood(mood);
    $("moodInput").value = "";
  }
});

// 瀏覽模式：下拉選單互動
$("songSelect").addEventListener("change", (e) => {
  $("playSelectedBtn").disabled = !e.target.value;
});

$("playSelectedBtn").addEventListener("click", () => {
  const videoId = $("songSelect").value;
  if (videoId) {
    currentBrowseIndex = browseSongs.findIndex((s) => s.videoId === videoId);
    playBrowseSelection(videoId);
    const song = browseSongs[currentBrowseIndex];
    const artist = $("songArtist").textContent.replace(/^.*請從下方選擇一首\s*/, "").trim();
    updateLyrics(song.songName || song.title, artist);
  }
});

// 播放控制列
$("btnPlayPause").addEventListener("click", togglePlayPause);
$("btnNext").addEventListener("click", playNext);
$("btnPrev").addEventListener("click", playPrev);
$("btnRandom").addEventListener("click", doRandomPlay);
$("volumeSlider").addEventListener("input", (e) => setVolume(e.target.value));
$("lyricsHeader").addEventListener("click", toggleLyrics);
$("btnToggleLyrics").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleLyrics();
});

// 點唱牆點擊：在本頁播放器直接播放
$("wallList").addEventListener("click", async (e) => {
  const songEl = e.target.closest(".wall-song");
  if (!songEl) return;
  const videoId = songEl.dataset.videoId;
  const song = songEl.dataset.song;
  const artist = songEl.dataset.artist;
  if (!videoId || !song || !artist) return;
  // 確保播放器視圖顯示、聊天視圖隱藏
  chatMode = false;
  $("chatWrap").hidden = true;
  $("playerView").hidden = false;
  playVideo(videoId);
  showResultCard({ title: `《${song}》`, artist, reason: "", hideBrowse: true });
  await updateLyrics(song, artist);
});

// 聊天輸入事件綁定
$("chatSendBtn").addEventListener("click", () => {
  const text = $("chatInput").value.trim();
  if (text) {
    sendChatMessage(text);
    $("chatInput").value = "";
  }
});

$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = $("chatInput").value.trim();
    if (text) {
      sendChatMessage(text);
      $("chatInput").value = "";
    }
  }
});

// 頁面載入：讀取點唱牆
loadWall();
