// ============================================================
// Firebase Web App 設定
// 取得方式：Firebase Console → 專案設定 → 一般 → 你的應用程式 → SDK 設定
//
// 注意：Firebase 的 apiKey 設計上就是可以公開的，
// 真正的防護由 Firestore Security Rules（見 firestore.rules）把關。
// 若尚未填寫，前端會自動以「無資料庫模式」運作（可點歌，但不寫紀錄）。
// ============================================================

export const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};
