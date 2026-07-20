// ============================================================
// Firebase Web App 設定
// 取得方式：Firebase Console → 專案設定 → 一般 → 你的應用程式 → SDK 設定
//
// 注意：Firebase 的 apiKey 設計上就是可以公開的，
// 真正的防護由 Firestore Security Rules（見 firestore.rules）把關。
// 若尚未填寫，前端會自動以「無資料庫模式」運作（可點歌，但不寫紀錄）。
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyD-PYAuWwcC5t-ZNlrB5J3RUB59vyFvAqQ",
  authDomain: "small-tools-firebase.firebaseapp.com",
  projectId: "small-tools-firebase",
  storageBucket: "small-tools-firebase.firebasestorage.app",
  messagingSenderId: "423591001752",
  appId: "1:423591001752:web:ea44db03fa620743db9aed"
};