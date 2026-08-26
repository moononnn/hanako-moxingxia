// 模型匣 —— 主 API 访问层
//
// 原理（源码调研结论）：
//   Hana 把「本机最高权限」的 loopback token 明文写在 hanakoHome/server-info.json，
//   持它 + 127.0.0.1 访问主 API 时，请求被判定为 local 连接（lan 模式下
//   127.0.0.1 → 127.0.0.1 也归 local），principal 是 local_user/loopback_token，
//   拥有全部 scope（principalHasScope 对 local owner 恒真）。
//   于是 PUT /api/config（需要 providers.manage + settings.write）可以直接调用，
//   走 Hana 自己的 saveProvider → onProviderChanged → models-changed 刷新链路，
//   菜单实时更新、无需重启。
//
//   插件页面/后端原本拿不到这些 scope（plugin principal scopes=[]），
//   所以这是唯一能让改动实时生效的正路。

import fs from "node:fs";
import path from "node:path";

const SERVER_INFO_FILE = "server-info.json";
const PROVIDER_CATALOG_FILE = "provider-catalog.json";
const PROVIDER_PLUGINS_DIR = "provider-plugins";
const REQUEST_TIMEOUT_MS = 8000;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** hanakoHome = 插件目录的上级上级（plugins/moxingxia → .hanako） */
export function resolveHanakoHome(ctx) {
  if (!ctx?.pluginDir) return null;
  return path.resolve(ctx.pluginDir, "..", "..");
}

/** 读 server-info.json 拿 port/token；读不到返回 null */
export function discoverServer(hanakoHome) {
  try {
    const raw = fs.readFileSync(path.join(hanakoHome, SERVER_INFO_FILE), "utf-8");
    const info = JSON.parse(raw);
    if (!info || typeof info.token !== "string" || !info.token) return null;
    if (!Number.isInteger(info.port) || info.port <= 0) return null;
    return {
      port: info.port,
      token: info.token,
      host: "127.0.0.1",
      version: info.version || null,
    };
  } catch {
    return null;
  }
}

export function serverBaseUrl(server) {
  return `http://${server.host}:${server.port}`;
}

/** 带 Bearer 的主 API 请求；失败时抛错并附原因 */
export async function apiFetch(server, pathname, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(serverBaseUrl(server) + pathname, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("连接 Hana 超时（8 秒）");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把某个供应商的配置 patch 交给主 API（PUT /api/config）。
 * Hana 会 saveProvider → onProviderChanged → 菜单实时刷新。
 */
export async function patchProviderConfig(server, providerId, patch) {
  const { ok, status, body } = await apiFetch(server, "/api/config", {
    method: "PUT",
    body: JSON.stringify({ providers: { [providerId]: patch } }),
  });
  if (!ok) {
    const msg = body?.error || `HTTP ${status}`;
    throw new Error(`保存供应商配置失败：${msg}`);
  }
  return body || { ok: true };
}

/** 无害 patch 触发一次 onProviderChanged（供应商键序重排后需要它重读 catalog 并重建菜单） */
export async function triggerProviderRefresh(server, anyProviderId) {
  if (!anyProviderId) return;
  await apiFetch(server, "/api/config", {
    method: "PUT",
    body: JSON.stringify({ providers: { [anyProviderId]: {} } }),
  });
}

/** 当前模型（current = 聚焦 agent 的当前模型，activeModel = 活动会话模型） */
export async function fetchCurrentModels(server) {
  const { ok, status, body } = await apiFetch(server, "/api/models");
  if (!ok) return { current: null, activeModel: null, error: `HTTP ${status}` };
  return {
    models: Array.isArray(body?.models) ? body.models : [],
    current: body?.current ? { id: body.current, provider: null } : null,
    activeModel: body?.activeModel || null,
  };
}

// ── provider-catalog.json 直接读写（供应商键序重排需要） ──

export function readCatalog(hanakoHome) {
  return readJsonObject(path.join(hanakoHome, PROVIDER_CATALOG_FILE));
}

/**
 * 读取已迁移到 provider-plugins 的本地供应商定义。
 * 这些定义的 models 不再重复写进 provider-catalog.json，但仍是有效模型来源。
 */
export function readLocalProviderDefinitions(hanakoHome) {
  const root = path.join(hanakoHome, PROVIDER_PLUGINS_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const definitions = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = readJsonObject(path.join(dir, "manifest.json"));
    const providerId = typeof manifest?.provider === "string" ? manifest.provider.trim() : "";
    if (!providerId) continue;
    const config = readJsonObject(path.join(dir, "providers", entry.name + ".json"));
    if (config) definitions.set(providerId, config);
  }
  return definitions;
}

/** 读取给模型匣使用的有效供应商视图，不改变原始 catalog 文件 */
export function readEffectiveCatalog(hanakoHome) {
  const catalog = readCatalog(hanakoHome);
  if (!catalog || !isPlainObject(catalog.providers)) return catalog;

  const providers = { ...catalog.providers };
  for (const [providerId, definition] of readLocalProviderDefinitions(hanakoHome)) {
    const configured = isPlainObject(providers[providerId]) ? providers[providerId] : {};
    const merged = { ...definition, ...configured };
    if (!Object.prototype.hasOwnProperty.call(configured, "models") && Array.isArray(definition.models)) {
      merged.models = structuredClone(definition.models);
    }
    if (!Object.prototype.hasOwnProperty.call(configured, "display_name")
      && typeof definition.displayName === "string") {
      merged.display_name = definition.displayName;
    }
    if (isPlainObject(definition.capabilities) || isPlainObject(configured.capabilities)) {
      merged.capabilities = {
        ...(isPlainObject(definition.capabilities) ? structuredClone(definition.capabilities) : {}),
        ...(isPlainObject(configured.capabilities) ? structuredClone(configured.capabilities) : {}),
      };
      if (isPlainObject(definition.capabilities?.chat) || isPlainObject(configured.capabilities?.chat)) {
        merged.capabilities.chat = {
          ...(isPlainObject(definition.capabilities?.chat) ? structuredClone(definition.capabilities.chat) : {}),
          ...(isPlainObject(configured.capabilities?.chat) ? structuredClone(configured.capabilities.chat) : {}),
        };
      }
    }
    providers[providerId] = merged;
  }
  return { ...catalog, providers };
}

/** 原子写 provider-catalog.json（tmp + rename，参考 Hana 自己的写入模式） */
export function writeCatalogAtomic(hanakoHome, catalog) {
  const target = path.join(hanakoHome, PROVIDER_CATALOG_FILE);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, target);
}