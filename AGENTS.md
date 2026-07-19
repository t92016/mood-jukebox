# 心情點唱機 (Mood Jukebox)

## 專案概述
給國小高年級學生使用的心情音樂推薦網頁：輸入心情 → Groq AI 分析推薦歌曲 → Firestore 快取 → YouTube 嵌入播放。日式可愛溫馨風，響應式設計。

## 技術棧
- 前端：HTML / CSS / 原生 JS（Firebase client SDK via CDN）
- 後端代理：Netlify Functions（`netlify/functions/`，藏 API Key 的防護層）
- AI：Groq API（llama-3.3-70b-versatile，JSON mode）
- 資料庫：Firebase Firestore（`SongsCache` 快取池 + `MoodLogs` 心情日誌）
- 音樂：YouTube Data API v3（搜尋）+ IFrame Player API（播放）
- 部署：GitHub repo → Netlify 自動部署

## 資料夾結構
```
├── netlify/functions/    ← 後端代理（recommend.js / youtube-search.js）
├── public/               ← 前端（index.html / css / js）
│   └── js/firebase-config.js  ← Firebase 設定（需手動填寫）
├── seeds/                ← 預填歌曲清單（npm run seed 灌入快取）
├── scripts/seed-cache.mjs ← 快取預填腳本
├── docs/專案規劃書.md     ← 原始專案規劃書
├── firestore.rules       ← Firestore 安全規則（需貼到 Firebase Console）
├── netlify.toml          ← Netlify 設定（/api/* → functions）
└── 專案的處理步驟/專案進度.md ← 詳細開發進度與踩坑記錄
```

## API Key 管理（重要）
- `GROQ_API_KEY`、`YOUTUBE_API_KEY`：只放 Netlify 環境變數（本機開發放 `.env`），**絕不進前端程式碼、絕不 commit**
- Firebase config：可公開，安全性由 `firestore.rules` 把關

## 同步對照表
| 項目 | 位置 |
|---|---|
| 本機專案 | `G:\AI\Mood_Jukebox心情點唱機` |
| GitHub | `t92016/mood-jukebox`（private） |
| Obsidian | `小工具開發/mood-jukebox.md` |
| 規劃書來源 | `J:\我的雲端硬碟\AI\AI Agents\OpenCode\心情點唱機_20260719\` |

## 常用指令
- `npm install` → 第一次安裝
- `npm run dev` → 本機啟動（netlify dev，含 functions）
- `npm run seed` → 預填歌曲快取（需先設 `YOUTUBE_API_KEY` 環境變數）

---

> AI 助理接手須知：請務必先完整讀取 `專案的處理步驟/專案進度.md`，裡面有完整的開發流程、踩坑記錄、下一步。本檔案只是精簡摘要。
