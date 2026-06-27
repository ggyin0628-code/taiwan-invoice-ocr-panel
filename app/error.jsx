"use client";

import { useEffect } from "react";

export default function Error({ error, reset }) {
  useEffect(() => {
    console.error("Application error boundary:", error);
  }, [error]);

  return (
    <main className="shell">
      <section className="fallbackPanel">
        <h1>系統載入時發生錯誤</h1>
        <p>請先重新整理頁面；若仍無法開啟，請重新啟動本機服務。</p>
        <button type="button" className="primary" onClick={reset}>重新載入</button>
      </section>
    </main>
  );
}
