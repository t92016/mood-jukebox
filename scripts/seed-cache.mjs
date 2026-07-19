// ============================================================
// 預填歌曲快取腳本（解決冷啟動配額問題）
//
// 使用方式：
//   1. npm install                    （第一次，安裝 firebase）
//   2. 填好 public/js/firebase-config.js
//   3. 設定環境變數 YOUTUBE_API_KEY
//      PowerShell:  $env:YOUTUBE_API_KEY="你的key"
//   4. npm run seed
//
// 配額估算：36 首歌 × 100 單位 = 3,600 單位（每日免費 10,000，安全）
// ============================================================

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { firebaseConfig } from "../public/js/firebase-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
  console.error("❌ 請先設定環境變數 YOUTUBE_API_KEY");
  console.error('   PowerShell: $env:YOUTUBE_API_KEY="你的key"');
  process.exit(1);
}
if (firebaseConfig.apiKey.startsWith("PASTE_")) {
  console.error("❌ 請先填寫 public/js/firebase-config.js");
  process.exit(1);
}

const db = getFirestore(initializeApp(firebaseConfig));
const cacheId = (song, artist) => `${artist} - ${song}`.replaceAll("/", " ").slice(0, 200);

async function searchYouTube(song, artist) {
  const params = new URLSearchParams({
    part: "snippet",
    q: `${artist} ${song}`,
    type: "video",
    videoCategoryId: "10",
    safeSearch: "strict",
    videoEmbeddable: "true",
    maxResults: "1",
    key: API_KEY,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  const data = await res.json();
  const item = data.items?.[0];
  return item?.id?.videoId ? { videoId: item.id.videoId, title: item.snippet.title } : null;
}

const seed = JSON.parse(await readFile(join(__dirname, "../seeds/songs-seed.json"), "utf-8"));

let done = 0, skipped = 0, failed = 0;

for (const [mood, songs] of Object.entries(seed)) {
  if (!Array.isArray(songs)) continue; // 跳過「說明」欄位
  for (const { song, artist } of songs) {
    const id = cacheId(song, artist);
    try {
      const existing = await getDoc(doc(db, "SongsCache", id));
      if (existing.exists()) {
        console.log(`⏭️  已有快取：${artist}《${song}》`);
        skipped++;
        continue;
      }
      const result = await searchYouTube(song, artist);
      if (!result) {
        console.warn(`⚠️  找不到影片：${artist}《${song}》`);
        failed++;
        continue;
      }
      await setDoc(doc(db, "SongsCache", id), {
        song, artist,
        videoId: result.videoId,
        videoTitle: result.title,
        moods: [mood],
        createdAt: serverTimestamp(),
      });
      console.log(`✅ ${artist}《${song}》→ ${result.videoId}`);
      done++;
      // 稍微間隔，對 API 溫柔一點
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`❌ ${artist}《${song}》：${err.message}`);
      failed++;
    }
  }
}

console.log(`\n完成！新增 ${done} 首、略過 ${skipped} 首、失敗 ${failed} 首`);
process.exit(0);
