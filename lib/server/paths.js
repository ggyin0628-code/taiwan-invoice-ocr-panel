import { join, normalize, sep } from "node:path";

export const DATA_DIR = join(process.cwd(), "data");
export const UPLOADS_DIR = join(DATA_DIR, "uploads");
export const PROCESSED_DIR = join(DATA_DIR, "processed");
export const DEBUG_DIR = join(DATA_DIR, "debug");
export const TEMPLATES_DIR = join(DATA_DIR, "templates");
export const RECORDS_FILE = join(DATA_DIR, "records.json");

export function toDataRelativePath(absolutePath) {
  const normalizedData = normalize(DATA_DIR);
  const normalizedPath = normalize(absolutePath);
  if (!normalizedPath.startsWith(normalizedData + sep) && normalizedPath !== normalizedData) {
    throw new Error("path is outside data directory");
  }
  return `data/${normalizedPath.slice(normalizedData.length + 1).split(sep).join("/")}`;
}

export function fromDataRelativePath(relativePath) {
  const clean = String(relativePath || "").replace(/^data\//, "").replace(/^\/+/, "");
  const resolved = normalize(join(DATA_DIR, clean));
  const normalizedData = normalize(DATA_DIR);
  if (!resolved.startsWith(normalizedData + sep) && resolved !== normalizedData) {
    throw new Error("invalid data path");
  }
  return resolved;
}

export function publicFileUrl(relativePath) {
  const clean = String(relativePath || "").replace(/^data\//, "").replace(/^\/+/, "");
  return `/api/files/${clean}`;
}
