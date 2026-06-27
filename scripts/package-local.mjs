import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const distDir = join(root, "dist");
const packageName = "財務收據整理面板-朋友版";
const packageDir = join(distDir, packageName);
const zipPath = join(distDir, `${packageName}.zip`);

const copyItems = [
  "app",
  "lib",
  "scripts",
  "ocr-service",
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  ".env.example",
  ".env.local.example",
  "README.md",
  "eng.traineddata",
  "chi_tra.traineddata",
  "start-desktop.sh",
  "start-ocr-service.sh",
  "財務收據整理面板-啟動.command",
  "PaddleOCR服務-啟動.command"
];

function copyItem(item) {
  const source = join(root, item);
  if (!existsSync(source)) return;
  cpSync(source, join(packageDir, item), {
    recursive: true,
    filter: (sourcePath) => {
      const name = basename(sourcePath);
      if (name === ".DS_Store") return false;
      if (name === "__pycache__") return false;
      if (name === ".venv") return false;
      if (sourcePath.includes(`${join("app", "api", "settings")}`)) return false;
      if (sourcePath.includes(`${join("app", "api", "vision-ocr")}`)) return false;
      return true;
    }
  });
}

mkdirSync(distDir, { recursive: true });
rmSync(packageDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(packageDir, { recursive: true });

for (const item of copyItems) copyItem(item);

mkdirSync(join(packageDir, "data", "uploads"), { recursive: true });
mkdirSync(join(packageDir, "data", "processed"), { recursive: true });
mkdirSync(join(packageDir, "data", "debug"), { recursive: true });
mkdirSync(join(packageDir, "data", "templates"), { recursive: true });
writeFileSync(join(packageDir, "data", "records.json"), "[]\n", "utf8");
writeFileSync(join(packageDir, "data", "correction-rules.json"), `${JSON.stringify({
  sellerNameCorrections: {},
  commonDigitCorrections: {
    O: "0",
    I: "1",
    l: "1"
  },
  fieldRules: {
    buyerTaxIdCannotEqualInvoiceNumberSuffix: true,
    amountCalculatedFromQuantityAndUnitPrice: true
  }
}, null, 2)}\n`, "utf8");

writeFileSync(join(packageDir, "朋友使用說明.md"), `# 財務收據整理面板朋友版

這是純本地端版本，不需要 OpenAI API key，也不會把發票圖片傳到雲端。

正式流程固定為：

1. PaddleOCR 讀取發票文字與位置。
2. Ollama 只輔助模糊欄位。
3. 金額用「數量 x 單價」公式計算。
4. 人工確認後才算正式資料。
5. Excel 匯出只匯出正式欄位。

## 使用前需求

- macOS，建議 Apple Silicon M1/M2/M3/M4。
- Node.js 20 或更新版本：https://nodejs.org/
- Python 3.10 到 3.13 其中一版。
- Ollama：https://ollama.com/
- Ollama 模型：

\`\`\`bash
ollama pull qwen2.5vl:7b
\`\`\`

第一次啟動需要網路，用來安裝 npm 與 Python 套件，以及下載 PaddleOCR 模型。

## 朋友需要拿到哪些檔案

只需要拿整個解壓縮後的資料夾：

\`\`\`
財務收據整理面板-朋友版
\`\`\`

不要只拿單一 app 檔，裡面的 \`app\`、\`lib\`、\`ocr-service\`、\`data\`、\`package.json\`、\`package-lock.json\`、兩個 \`.command\` 檔都要保留在同一個資料夾內。

## 啟動方式

1. 解壓縮整個資料夾。
2. 先開 Ollama app。
3. 雙擊「PaddleOCR服務-啟動.command」。
4. 等畫面出現 \`http://127.0.0.1:8765\`。
5. 另外再雙擊「財務收據整理面板-啟動.command」。
6. 瀏覽器開啟 http://localhost:3000。

第一次啟動會自動安裝套件，時間可能較久。

## 資料位置

- 原圖：data/uploads
- 處理後圖片：data/processed
- OCR debug：data/debug
- 發票模板：data/templates
- 財務紀錄：data/records.json

## 匯出 Excel

進入系統後上傳發票圖片，人工確認資料，再按 Excel 匯出。

多品項會一品項一列；稅金與總金額只會出現在同一張發票的最後一列，避免 Excel 加總重複。

## 注意

- OCR 只做初步填入，正式資料仍以人工確認為準。
- 如果 Ollama 沒開，系統仍可用 PaddleOCR 辨識，但會出現 \`ollama_unavailable\` warning。
- 如果 PaddleOCR service 沒開，請先啟動「PaddleOCR服務-啟動.command」。
- 若 macOS 阻擋啟動，請在 Terminal 到此資料夾執行：

\`\`\`bash
chmod +x start-desktop.sh start-ocr-service.sh 財務收據整理面板-啟動.command PaddleOCR服務-啟動.command
./PaddleOCR服務-啟動.command
./財務收據整理面板-啟動.command
\`\`\`

## 常見問題

### 1. 打不開 .command

在資料夾空白處按右鍵，選「服務」或「新增終端機於資料夾」，執行：

\`\`\`bash
chmod +x *.command *.sh
\`\`\`

### 2. PaddleOCR 安裝很久

第一次正常，會安裝 Python 套件和下載模型。等它跑完即可。

### 3. Ollama 模型不存在

執行：

\`\`\`bash
ollama pull qwen2.5vl:7b
\`\`\`

### 4. 3000 或 8765 port 被佔用

啟動腳本會自動停止舊服務。如果還是不行，重新開機後再啟動。
`, "utf8");

execFileSync("chmod", ["+x", join(packageDir, "start-desktop.sh"), join(packageDir, "start-ocr-service.sh"), join(packageDir, "財務收據整理面板-啟動.command"), join(packageDir, "PaddleOCR服務-啟動.command")]);
execFileSync("zip", ["-r", "-X", zipPath, basename(packageDir)], { cwd: distDir, stdio: "ignore" });

console.log(zipPath);
