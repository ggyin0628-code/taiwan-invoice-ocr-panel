import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RECORDS_FILE } from "./paths.js";

function ensureRecordsFile() {
  mkdirSync(dirname(RECORDS_FILE), { recursive: true });
  if (!existsSync(RECORDS_FILE)) writeFileSync(RECORDS_FILE, "[]\n", "utf8");
}

export function readRecords() {
  ensureRecordsFile();
  try {
    const parsed = JSON.parse(readFileSync(RECORDS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRecords(records) {
  ensureRecordsFile();
  const sorted = Array.isArray(records)
    ? records.map((record, index) => ({ ...record, sequenceNo: record.sequenceNo || index + 1 }))
    : [];
  writeFileSync(RECORDS_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  return sorted;
}

export function appendRecords(newRecords) {
  const current = readRecords();
  const next = [...current, ...newRecords].map((record, index) => ({
    ...record,
    sequenceNo: index + 1
  }));
  return writeRecords(next);
}

export function updateRecord(id, patch) {
  const now = new Date().toISOString();
  const records = readRecords();
  let updated = null;
  const next = records.map((record) => {
    if (record.id !== id) return record;
    updated = {
      ...record,
      ...patch,
      updatedAt: now
    };
    return updated;
  });
  if (!updated) return null;
  writeRecords(next);
  return updated;
}

export function deleteRecord(id) {
  const records = readRecords();
  const next = records.filter((record) => record.id !== id).map((record, index) => ({
    ...record,
    sequenceNo: index + 1
  }));
  writeRecords(next);
  return next;
}
