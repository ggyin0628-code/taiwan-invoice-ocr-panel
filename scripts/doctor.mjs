import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();

function check(label, ok, detail = "") {
  const mark = ok ? "OK" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? ` - ${detail}` : ""}`);
  return ok;
}

function info(label, detail = "") {
  console.log(`[OK] ${label}${detail ? ` - ${detail}` : ""}`);
}

function command(name, args = []) {
  try {
    return execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

const nodeVersion = process.versions.node;
const npmVersion = command("npm", ["--version"]);
const portUsers = command("lsof", ["-nP", "-iTCP:3000", "-sTCP:LISTEN"]);

let ok = true;
ok = check("Node.js", Number(nodeVersion.split(".")[0]) >= 18, nodeVersion) && ok;
ok = check("npm", Boolean(npmVersion), npmVersion || "找不到 npm") && ok;
ok = check("node_modules", existsSync(join(root, "node_modules")), "缺少時請先執行 npm install 或 npm ci") && ok;
ok = check("Next build output", existsSync(join(root, ".next")), "缺少時請執行 npm run build") && ok;
ok = check("Tesseract eng traineddata", existsSync(join(root, "eng.traineddata")), "缺少時本地 OCR 無法辨識英數") && ok;
ok = check("Tesseract chi_tra traineddata", existsSync(join(root, "chi_tra.traineddata")), "缺少時本地 OCR 無法辨識中文錨點") && ok;
info("Port 3000", portUsers ? "目前已有服務在執行；若要重啟請執行 npm run kill:3000" : "可使用");

console.log("");
console.log("正式桌機啟動建議：");
console.log("1. npm run kill:3000");
console.log("2. npm run build");
console.log("3. npm run start -- -p 3000");
console.log("");
console.log("如果要一鍵執行，使用：npm run desktop 或雙擊 財務收據整理面板-啟動.command");

process.exit(ok ? 0 : 1);
