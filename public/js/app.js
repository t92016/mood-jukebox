// ============================================================
// 心情點唱機 前端主邏輯
// 流程：心情輸入 → /api/recommend (Groq) → Firestore 快取檢查
//       → （無快取時）/api/youtube-search → 寫入快取 + 心情日誌
//       → YouTube IFrame 播放
// ============================================================

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
      .map((log) => `<li><span class="wall-mood">「${escapeHtml(log.mood)}」</span> →
        <span class="wall-song">🎵 ${escapeHtml(log.artist)}《${escapeHtml(log.song)}》</span></li>`)
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

// ---------- 主流程 ----------
async function handleMood(mood) {
  setBusy(true);
  $("resultArea").hidden = true;
  browseSongs = [];
  $("songSelect").innerHTML = `<option value="" disabled selected>— 請選擇歌曲 —</option>`;
  $("playSelectedBtn").disabled = true;
  showStatus("🔮 正在感受你的心情……");

  try {
    // 1. Groq AI 判斷意圖
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
      updateLyrics(rec.song, rec.artist);
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

      // 填充下拉選單
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
      updateControlsState();
      return;
    }

    // ===== 意圖 C：依心情推薦（原有邏輯） =====
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
    updateLyrics(rec.song, rec.artist);
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

// 瀏覽模式：播放選中的歌曲
async function playBrowseSelection(videoId) {
  const song = browseSongs.find((s) => s.videoId === videoId);
  if (!song) return;

  const rec = { song: song.songName || song.title, artist: $("songArtist").textContent.replace(/^.*歌手\s*/, "").trim() };

  // 隱藏下拉選單、顯示播放器
  $("browseWrap").hidden = true;
  playVideo(videoId);

  // 寫入快取與日誌
  await saveCache(rec.song, rec.artist, videoId, song.title);
  logMood("browse: " + rec.artist, rec, videoId).then(loadWall).catch(() => {});
}

// ---------- 播放狀態與控制 ----------
let currentBrowseIndex = -1;
let isPlaying = false;

// 簡易歌詞庫（可持續擴充）
const lyricsDB = {
  "周杰倫 - 晴天": "故事的小黃花\n從出生那年就飄著\n童年的盪鞦韆\n隨記憶一直晃到現在\n\nRe So So Si Do Si La\nSo La Si Si Si Si La Si La So\n\n吹著前奏望著天空\n我想起花瓣試著掉落\n\n為你翹課的那一天\n花落的那一天\n教室的那一間\n我怎麼看不見\n消失的下雨天\n我好想再淋一遍\n\n沒想到失去的勇氣我還留著\n好想再問一遍\n你會等待還是離開",
  "五月天 - 知足": "怎麼去擁有一道彩虹\n怎麼去擁抱一夏天的風\n天上的星星笑地上的人\n總是不能懂不能覺得足夠\n\n如果我愛上你的笑容\n要怎麼收藏要怎麼擁有\n如果你快樂再不是為我\n會不會放手其實才是擁有\n\n當一陣風吹來風箏飛上天空\n為了你而祈禱而祝福而感動\n終於你身影消失在人海盡頭\n才發現笑著哭最痛",
  "周杰倫 - 稻香": "對這個世界如果你有太多的抱怨\n跌倒了就不敢繼續往前走\n為什麼人要這麼的脆弱 墮落\n\n請你打開電視看看\n多少人為生命在努力勇敢的走下去\n我們是不是該知足\n珍惜一切 就算沒有擁有\n\n還記得你說家是唯一的城堡\n隨著稻香河流繼續奔跑\n微微笑 小時候的夢我知道\n\n不要哭讓螢火蟲帶著你逃跑\n鄉間的歌謠永遠的依靠\n回家吧 回到最初的美好",
};

function updateLyrics(song, artist) {
  const key = `${artist} - ${song}`;
  const text = lyricsDB[key] || "暫無歌詞，靜心聆聽音樂吧～ 🎵\n\n（歌詞庫持續擴充中）";
  $("lyricsText").textContent = text;
  $("lyricsWrap").hidden = false;
  $("lyricsContent").classList.add("collapsed");
  $("btnToggleLyrics").textContent = "展開 ▼";
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

function playNext() {
  if (browseSongs.length > 0 && currentBrowseIndex >= 0) {
    // 瀏覽模式：播放下一首
    currentBrowseIndex = (currentBrowseIndex + 1) % browseSongs.length;
    const next = browseSongs[currentBrowseIndex];
    $("songSelect").value = next.videoId;
    playBrowseSelection(next.videoId);
    updateLyrics(next.songName || next.title, $("songArtist").textContent.replace(/^.*請從下方選擇一首\s*/, "").trim());
  } else {
    // 非瀏覽模式：觸發隨機心情推薦
    const moods = ["開心", "難過", "生氣", "想睡", "緊張", "無聊"];
    handleMood(moods[Math.floor(Math.random() * moods.length)]);
  }
}

function playPrev() {
  if (browseSongs.length > 0 && currentBrowseIndex > 0) {
    currentBrowseIndex = currentBrowseIndex - 1;
    const prev = browseSongs[currentBrowseIndex];
    $("songSelect").value = prev.videoId;
    playBrowseSelection(prev.videoId);
    updateLyrics(prev.songName || prev.title, $("songArtist").textContent.replace(/^.*請從下方選擇一首\s*/, "").trim());
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

// 頁面載入：讀取點唱牆
loadWall();
