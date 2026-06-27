import "./globals.css";

export const metadata = {
  title: "財務收據整理面板",
  description: "公司發票與收據批量匯入整理、人工確認、Excel 匯出"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
