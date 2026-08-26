// 模型匣 —— 插件数据存储（原子写，防止并发写损坏）
// 存两类东西：
//   hidden: 被隐藏供应商的原始配置快照（models 列表 + 原 projection），恢复时原样还回去

import fs from "node:fs";
import path from "node:path";

const STORE_FILE = "store.json";
const STORE_VERSION = 1;

function defaultStore() {
  return { version: STORE_VERSION, hidden: {} };
}

export function storePath(dataDir) {
  return path.join(dataDir, STORE_FILE);
}

export function readStore(dataDir) {
  try {
    const raw = fs.readFileSync(storePath(dataDir), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultStore();
    return {
      version: STORE_VERSION,
      hidden: parsed.hidden && typeof parsed.hidden === "object" ? parsed.hidden : {},
    };
  } catch {
    return defaultStore();
  }
}

/** 原子写：tmp + rename，避免写一半断电/并发读损坏 */
export function writeStore(dataDir, store) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = storePath(dataDir);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, target);
}

export function getHiddenRecord(store, providerId) {
  const rec = store.hidden?.[providerId];
  if (!rec || typeof rec !== "object") return null;
  return rec;
}

export function setHiddenRecord(dataDir, store, providerId, record) {
  store.hidden = store.hidden || {};
  store.hidden[providerId] = record;
  writeStore(dataDir, store);
}

export function dropHiddenRecord(dataDir, store, providerId) {
  if (!store.hidden?.[providerId]) return;
  delete store.hidden[providerId];
  writeStore(dataDir, store);
}

/** 清理快照里已不存在于 catalog 的死记录（供应商被用户删了） */
export function pruneHiddenRecords(store, knownProviderIds) {
  const ids = new Set(knownProviderIds);
  let changed = false;
  for (const key of Object.keys(store.hidden || {})) {
    if (!ids.has(key)) {
      delete store.hidden[key];
      changed = true;
    }
  }
  return changed;
}