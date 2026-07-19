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

window.onYouTubeIframeAPIReady = () => {
  ytApiReady = true;
  if (pendingVideoId) {
    playVideo(pendingVideoId);
    pendingVideoId = null;
  }
};

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

// ---------- 主流程 ----------
async function handleMood(mood) {
  setBusy(true);
  $("resultArea").hidden = true;
  showStatus("🔮 正在感受你的心情……");

  try {
    // 1. Groq AI 推薦
    const rec = await postJSON("/api/recommend", { mood });

    // 2. 先查 Firestore 快取（省 YouTube 配額的關鍵！）
    showStatus("🎧 找到了！準備唱片中……");
    let videoId = await lookupCache(rec.song, rec.artist);

    // 3. 無快取才呼叫 YouTube 搜尋，結果存回快取池
    if (!videoId) {
      const yt = await postJSON("/api/youtube-search", { song: rec.song, artist: rec.artist });
      videoId = yt.videoId;
      await saveCache(rec.song, rec.artist, videoId, yt.title);
    }

    // 4. 寫入心情日誌（背景執行，不阻塞播放）
    logMood(mood, rec, videoId).then(loadWall).catch(() => {});

    // 5. 顯示結果 + 播放
    $("songTitle").textContent = `《${rec.song}》`;
    $("songArtist").textContent = rec.artist;
    $("songReason").textContent = rec.reason ? `💬 ${rec.reason}` : "";
    $("resultArea").hidden = false;
    hideStatus();
    playVideo(videoId);
    $("resultArea").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    console.error(err);
    showStatus(`😴 ${err.message || "點唱機打盹了，再試一次吧！"}`);
  } finally {
    setBusy(false);
  }
}

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

// 頁面載入：讀取點唱牆
loadWall();
