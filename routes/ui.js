// 模型匣 —— 页面与 API 路由
// 页面前缀由 host 代理：/api/plugins/moxingxia/...
// 注意：/api/providers/reorder 必须先于 /api/providers/:name/... 注册，避免被 :name 吞掉
// 文件预算豁免：所有路由共享同一套 ctx、鉴权、Hana API 环境和错误封装，
// 保持单入口可避免拆分后出现路由注册顺序或环境初始化漂移。

import fs from "node:fs";
import path from "node:path";

import {
  discoverServer,
  fetchCurrentModels,
  fetchProviderModels,
  patchProviderConfig,
  readCatalog,
  readEffectiveCatalog,
  resolveHanakoHome,
  resolveLocalProviderFile,
  triggerProviderRefresh,
  writeCatalogAtomic,
  apiFetch,
} from "../lib/host-api.js";
import { resolveBuiltinProviderIds } from "../lib/builtin.js";
import {
  buildHidePatch,
  buildShowPatch,
  inspectRuntimeModelOrder,
  inspectRuntimeProviderOrderDetailed,
  listProviders,
  renameModelEntry,
  renameProviderDisplay,
  reorderModelEntries,
  reorderProvidersObject,
  resolveProviderKind,
  snapshotProvider,
} from "../lib/catalog.js";
import {
  dropHiddenRecord,
  getHiddenRecord,
  pruneHiddenRecords,
  readStore,
  setHiddenRecord,
  writeStore,
} from "../lib/store.js";
import { renderPage } from "../lib/page.js";
import {
  FAILWATCH_SLOTS,
  FAILWATCH_SLOT_LABELS,
  readUsageLedger,
  summarizeUsage,
  normalizeFailwatchSlots,
  isActiveFallbackSlot,
  buildManualRestorePlan,
  finalizeManualRestoreState,
  listProtectedProviderSlots,
} from "../lib/failwatch.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

function jsonErr(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

/**
 * 按未生效 provider 的类型拼提示：内置=定死改不了，自定义=保存了但菜单没跟上。
 * @param providerResults inspectRuntimeProviderOrderDetailed 的 per-provider 结果
 * @param providerConfigs catalog.providers
 * @param builtinIds 内置名单（可 null）
 * @returns null=全部生效，否则为提示文案
 */
function buildSupplierReorderWarning(providerResults, providerConfigs, builtinIds) {
  if (!providerResults) return null;
  const failed = providerResults.filter((r) => r.state !== "ok");
  if (failed.length === 0) return null;
  const names = (list) => list.map((r) => r.requestedId).join("、");
  const builtinFailed = failed.filter((r) => (
    resolveProviderKind(r.requestedId, providerConfigs?.[r.requestedId], builtinIds) === "builtin"
  ));
  const customFailed = failed.filter((r) => (
    resolveProviderKind(r.requestedId, providerConfigs?.[r.requestedId], builtinIds) === "custom"
  ));
  const parts = [];
  if (builtinFailed.length > 0) {
    parts.push(
      names(builtinFailed)
      + " 是 Hana 内置供应商，顺序由内置目录决定，改不了（能隐藏，不能换位）",
    );
  }
  if (customFailed.length > 0) {
    parts.push("顺序已保存，但 " + names(customFailed) + " 的菜单位置暂时没跟着换");
  }
  if (parts.length === 0) parts.push("顺序已保存，但 Hana 菜单暂时没有完全跟着换");
  return parts.join("；");
}

function initEnv(ctx) {
  const hanakoHome = resolveHanakoHome(ctx);
  if (!hanakoHome) return { error: "找不到 Hana 数据目录" };
  const server = discoverServer(hanakoHome);
  if (!server) return { error: "连不上 Hana 服务（server-info 读不到）" };
  return { hanakoHome, server };
}

export default function registerPluginUiRoutes(app, ctx) {
  // ── 降级保护：读状态 + 消耗监测 ──
  app.get("/api/failwatch/status", async (c) => {
    const store = readStore(ctx.dataDir);
    const fw = store.failwatch || {};
    const slots = normalizeFailwatchSlots(fw);
    const activeSlots = FAILWATCH_SLOTS.filter((key) => isActiveFallbackSlot(slots[key]));
    const enabled = Object.values(fw.backup || {}).some((ref) => typeof ref === "string" && ref.trim());

    // 消耗量：读 usage-ledger.json，统计近 24h 的 utility / 插件子系统用量
    let usage = null;
    const env = initEnv(ctx);
    if (env.hanakoHome) {
      const ledgerPath = path.join(env.hanakoHome, "usage-ledger.json");
      const ledger = readUsageLedger(ledgerPath);
      if (ledger) {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        usage = {
          utility24h: summarizeUsage(ledger, { sinceMs: since, subsystem: "utility" }),
          plugin24h: summarizeUsage(ledger, { sinceMs: since, subsystem: "plugin" }),
          total24h: summarizeUsage(ledger, { sinceMs: since }),
        };
      }
    }

    // 降级事件日志（最近 20 条）
    const events = Array.isArray(fw.events) ? fw.events.slice(-20) : [];

    return json({
      ok: true,
      mode: "manual-restore",
      enabled,
      backup: fw.backup || null,
      degraded: activeSlots.length > 0,
      activeSlots,
      slots,
      degradedAt: fw.degradedAt || null,
      consecutiveFailures: fw.consecutiveFailures || 0,
      lastFailureAt: fw.lastFailureAt || null,
      lastDegradePatch: fw.lastDegradePatch || null,
      thinkingCapped: fw.thinkingCapped || 0,
      lastThinkingCappedAt: fw.lastThinkingCappedAt || null,
      events,
      usage,
    });
  });

  // ── 降级保护：拉 Hana 内置模型列表（供下拉选择备用模型） ──
  app.get("/api/failwatch/models", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return json({ ok: false, error: env.error });
    const modelState = await fetchCurrentModels(env.server).catch(() => null);
    if (!modelState) return json({ ok: false, error: "读不到模型列表" });
    const models = (modelState.models || [])
      .filter((m) => m && typeof m.id === "string" && m.id)
      .map((m) => ({
        id: m.id,
        provider: typeof m.provider === "string" ? m.provider : "",
        name: typeof m.name === "string" && m.name ? m.name : m.id,
        ref: [m.provider, m.id].filter(Boolean).join("/"),
        // 识图能力：input 数组含 image 即为能看图
        vision: Array.isArray(m.input) && m.input.includes("image"),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    // 当前 Hana 的工具/大工具/视觉/主模型配置（冲突检测基准）
    const prefsPath = path.join(env.hanakoHome, "user", "preferences.json");
    let current = null;
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      const norm = (v) => (v && typeof v === "object" && v.provider && v.id)
        ? v.provider + "/" + v.id
        : (typeof v === "string" && v ? v : "");
      current = {
        utility: norm(prefs.utility_model),
        utility_large: norm(prefs.utility_large_model),
        vision: norm(prefs.vision_model),
      };
    } catch {
      current = null;
    }
    return json({ ok: true, models, current });
  });

  // ── 降级保护：测试备用模型连通性 ──
  // 原理：从 provider-catalog.json 读到该 provider 的 api/base_url/api_key，
  // 发一条最小请求验证模型存在且凭据有效。不保存任何东西。
  app.post("/api/failwatch/test", async (c) => {
    const body = await c.req.json().catch(() => null);
    const ref = body?.ref;
    if (typeof ref !== "string" || !ref.trim()) return jsonErr("缺模型引用");
    const env = initEnv(ctx);
    if (env.error) return json({ ok: false, error: env.error });

    const [provider, ...rest] = ref.split("/");
    const modelId = rest.join("/");
    const catalog = readEffectiveCatalog(env.hanakoHome);
    const p = catalog?.providers?.[provider];
    if (!p) return json({ ok: false, error: "找不到这家供应商的配置" });
    if (!p.base_url) return json({ ok: false, error: "这家供应商是 OAuth 登录型，没有可直接测试的接口地址（如 openai-codex），建议选其他备用模型" });
    if (!p.api_key) return json({ ok: false, error: "这家供应商没配 api_key" });

    const api = p.api || "openai-completions";
    // 组最小请求体：不同协议端点不同
    let url, payload;
    const timeout = AbortSignal.timeout(15000);
    try {
      if (api === "anthropic-messages") {
        url = p.base_url.replace(/\/$/, "") + "/v1/messages";
        payload = { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
      } else if (api === "openai-responses") {
        url = p.base_url.replace(/\/$/, "") + "/responses";
        payload = { model: modelId, input: "hi", max_output_tokens: 1 };
      } else if (api === "google-generative-ai") {
        url = `${p.base_url.replace(/\/$/, "")}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(p.api_key)}`;
        payload = { contents: [{ parts: [{ text: "hi" }] }] };
      } else {
        url = p.base_url.replace(/\/$/, "") + "/chat/completions";
        payload = { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
      }
      const headers = { "Content-Type": "application/json" };
      if (api !== "google-generative-ai") headers.Authorization = `Bearer ${p.api_key}`;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: timeout });
      if (res.ok) return json({ ok: true, provider, model: modelId, status: res.status });
      // 429 限流 / 401 认证 / 404 模型不存在，给友好提示
      let reason = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) reason = "认证失败，检查 key";
      else if (res.status === 404) reason = "模型不存在或协议不对";
      else if (res.status === 429) reason = "限流了";
      return json({ ok: false, error: reason });
    } catch (err) {
      return json({ ok: false, error: "连接失败：" + (err?.message || String(err)) });
    }
  });

  // ── 降级保护：保存备用模型配置（带冲突检测） ──
  app.post("/api/failwatch/backup", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return jsonErr("参数不对");
    const clean = {};
    for (const key of ["utility", "utility_large", "vision"]) {
      const v = body[key];
      if (typeof v === "string" && v.trim()) clean[key] = v.trim();
    }
    if (Object.keys(clean).length === 0) return jsonErr("至少选一个备用模型");

    // 冲突检测：备用模型不能跟当前 Hana 配置一样（一样则降级等于白切）
    const env = initEnv(ctx);
    let conflicts = [];
    if (!env.error) {
      const prefsPath = path.join(env.hanakoHome, "user", "preferences.json");
      try {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        const norm = (v) => (v && typeof v === "object" && v.provider && v.id)
          ? v.provider + "/" + v.id
          : (typeof v === "string" && v ? v : "");
        const cur = {
          utility: norm(prefs.utility_model),
          utility_large: norm(prefs.utility_large_model),
          vision: norm(prefs.vision_model),
        };
        // 备用槽位 vs 当前同槽位：
        const label = { utility: "小工具模型", utility_large: "大工具模型", vision: "视觉模型" };
        for (const key of ["utility", "utility_large", "vision"]) {
          if (clean[key] && cur[key] && clean[key] === cur[key]) {
            conflicts.push(label[key] + " 的备用模型跟当前配置一样（" + clean[key] + "），降级了也还是同一个，换个吧");
          }
        }
      } catch { /* 读不到配置就不做冲突检测 */ }
    }
    if (conflicts.length > 0) {
      return json({ ok: false, error: conflicts.join("；") });
    }

    const store = readStore(ctx.dataDir);
    const fw = store.failwatch || {};
    const activeSlots = FAILWATCH_SLOTS.filter((key) => isActiveFallbackSlot(normalizeFailwatchSlots(fw)[key]));
    if (activeSlots.length > 0) {
      return jsonErr("当前正在使用备用模型，先手动切回主模型再修改备用配置", 409);
    }
    // 保存备用配置；省略的槽位表示清空该槽位，不影响当前主模型配置。
    fw.backup = clean;
    // 用户重新保存备用配置，代表愿意重新启用之前人工接管过的槽位。
    const slots = normalizeFailwatchSlots(fw);
    for (const key of Object.keys(clean)) {
      if (slots[key]?.mode === "manual") {
        slots[key] = { ...slots[key], mode: "primary", manualTakenOver: false, consecutiveFailures: 0, visionFailures: 0 };
      }
    }
    fw.slots = slots;
    fw.manualTakenOver = false;
    fw.events = Array.isArray(fw.events) ? fw.events : [];
    store.failwatch = fw;
    writeStore(ctx.dataDir, store);
    return json({ ok: true, backup: clean });
  });

  // ── 降级保护：手动重置降级状态（切回主模型） ──
  app.post("/api/failwatch/reset", async (c) => {
    const store = readStore(ctx.dataDir);
    const fw = store.failwatch || {};
    const env = initEnv(ctx);
    if (env.error) return jsonErr(env.error, 503);

    // 恢复前先读回当前配置；某个槽位被用户手动改过时，只跳过该槽位，绝不覆盖。
    let current;
    try {
      const currentRes = await apiFetch(env.server, "/api/preferences/models");
      if (!currentRes?.ok || !currentRes.body?.models) {
        return jsonErr("读不到当前模型配置，暂时没敢覆盖", 502);
      }
      current = currentRes.body.models;
    } catch (err) {
      return jsonErr("读当前模型配置失败：" + (err?.message || String(err)), 502);
    }

    const plan = buildManualRestorePlan(fw, current);
    let restored = false;
    if (Object.keys(plan.patch.models || {}).length > 0) {
      try {
        const res = await apiFetch(env.server, "/api/preferences/models", {
          method: "PUT",
          body: JSON.stringify(plan.patch),
        });
        restored = !!res?.ok;
        if (!res?.ok) return jsonErr("恢复失败（HTTP " + res.status + "）", 502);
      } catch (err) {
        return jsonErr("恢复失败：" + (err?.message || String(err)), 502);
      }
    }

    const nextFw = finalizeManualRestoreState(fw, plan);
    nextFw.events = Array.isArray(nextFw.events) ? nextFw.events : [];
    if (plan.trackedSlots.length > 0) {
      nextFw.events.push({
        type: "manual-restore",
        slots: plan.restoredSlots,
        skippedSlots: plan.skippedSlots,
        labels: plan.restoredSlots.map((key) => FAILWATCH_SLOT_LABELS[key]),
        at: new Date().toISOString(),
      });
      if (nextFw.events.length > 50) nextFw.events = nextFw.events.slice(-50);
    }
    store.failwatch = nextFw;
    writeStore(ctx.dataDir, store);
    return json({
      ok: true,
      restored,
      restoredSlots: plan.restoredSlots,
      skippedSlots: plan.skippedSlots,
      message: plan.skippedSlots.length > 0
        ? "有槽位已经被手动改过，已跳过，没覆盖你的选择"
        : (restored ? "已切回主模型" : "当前没在使用备用模型，不用恢复"),
    });
  });

  // ── 页面 ──
  app.get("/settings", (c) => {
    const env = initEnv(ctx);
    const html = renderPage(ctx, {
      serverOk: !env.error,
      serverError: env.error || null,
    });
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  });

  // ── 状态 ──
  app.get("/api/state", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return json({ ok: true, list: [], serverOk: false, error: env.error });

    const catalog = readEffectiveCatalog(env.hanakoHome);
    if (!catalog) return json({ ok: false, error: "读不到 Hana 的供应商配置（provider-catalog.json）" });

    const store = readStore(ctx.dataDir);
    const modelState = await fetchCurrentModels(env.server).catch(() => ({ current: null, activeModel: null }));
    pruneHiddenRecords(store, Object.keys(catalog.providers || {}));
    const builtinIds = resolveBuiltinProviderIds(env.hanakoHome);

    return json({
      ok: true,
      serverOk: true,
      builtinsKnown: builtinIds !== null,
      list: listProviders(catalog, store, modelState, builtinIds),
    });
  });

  // ── 供应商排序（先注册静态路径）──
  app.post("/api/providers/reorder", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return jsonErr(env.error, 503);
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.ids)) return jsonErr("参数不对");

    const catalog = readCatalog(env.hanakoHome);
    if (!catalog) return jsonErr("读不到供应商配置", 500);
    const reordered = reorderProvidersObject(catalog, body.ids);
    if (reordered.error) return jsonErr(reordered.error);
    catalog.providers = reordered.catalog.providers;
    try {
      writeCatalogAtomic(env.hanakoHome, catalog);
    } catch (err) {
      return jsonErr("写配置失败：" + (err?.message || String(err)), 500);
    }
    try {
      await triggerProviderRefresh(env.server, body.ids[0]);
    } catch (err) {
      return jsonErr("顺序已写入，但刷新模型菜单失败：" + (err?.message || String(err)), 502);
    }

    const modelState = await fetchCurrentModels(env.server).catch(() => null);
    const effectiveCatalog = readEffectiveCatalog(env.hanakoHome);
    const providerConfigs = effectiveCatalog?.providers || catalog.providers;
    const builtinIds = resolveBuiltinProviderIds(env.hanakoHome);
    const runtimeCheck = modelState
      ? inspectRuntimeProviderOrderDetailed(modelState.models, body.ids, providerConfigs)
      : null;
    const warning = runtimeCheck
      ? buildSupplierReorderWarning(runtimeCheck.providerResults, providerConfigs, builtinIds)
      : null;
    if (runtimeCheck && !runtimeCheck.matches) {
      return json({
        ok: true,
        applied: false,
        saved: true,
        runtimeProviderOrder: runtimeCheck.actualOrder,
        providerResults: runtimeCheck.providerResults,
        warning,
      });
    }
    return json({ ok: true, applied: true, verified: !!runtimeCheck });
  });

  // ── 隐藏供应商 ──
  app.post("/api/providers/:name/hide", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return jsonErr(env.error, 503);
    const name = c.req.param("name");
    const catalog = readEffectiveCatalog(env.hanakoHome);
    if (!catalog) return jsonErr("读不到供应商配置", 500);
    const provider = catalog.providers?.[name];
    if (!provider) return jsonErr("这家供应商不存在（可能已经被删了）", 404);

    const store = readStore(ctx.dataDir);
    if (getHiddenRecord(store, name)) return jsonErr("它已经收进匣底了", 409);

    // 正在使用保护
    const modelState = await fetchCurrentModels(env.server).catch(() => ({ current: null, activeModel: null }));
    const inUseProvider = modelState?.activeModel?.provider || modelState?.current?.provider || null;
    if (inUseProvider === name) {
      return jsonErr("这家正在用着呢，先切到别家再收起来吧", 409);
    }

    // 备用模型也属于“正在使用”：收起它的供应商会让自动切换失去落点。
    // 同时保护当前 utility / utility_large / vision，避免 Hana 配置仍依赖它却被隐藏。
    const normalizeRef = (value) => {
      if (value && typeof value === "object" && value.provider && value.id) return `${value.provider}/${value.id}`;
      return typeof value === "string" ? value : "";
    };
    let currentSlots = {};
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(env.hanakoHome, "user", "preferences.json"), "utf-8"));
      currentSlots = {
        utility: normalizeRef(prefs.utility_model),
        utility_large: normalizeRef(prefs.utility_large_model),
        vision: normalizeRef(prefs.vision_model),
      };
    } catch { /* 读不到时保留已有 activeModel 保护 */ }
    const protectedBy = listProtectedProviderSlots(currentSlots, store.failwatch?.backup || {});
    const holders = protectedBy[name] || [];
    if (holders.length > 0) {
      const holderText = holders.map((item) => `${item.kind}「${item.label}」`).join("、");
      return jsonErr(`这家还被${holderText}占用，先换掉相关模型再收起来吧`, 409);
    }

    const snapshot = snapshotProvider(provider);
    // 快照模型为空但供应商实际有模型时（catalog 滞后 / 本地定义未合并），
    // 从 Hana 运行时模型列表补齐，避免 show 时恢复不了模型列表
    if (snapshot.models.length === 0) {
      const runtimeModels = (modelState?.models || [])
        .filter((m) => m?.provider === name && typeof m.id === "string")
        .map((m) => ({ id: m.id, name: m.name || m.id }));
      if (runtimeModels.length > 0) snapshot.models = runtimeModels;
    }
    const patch = buildHidePatch(provider);
    // 先落快照再调 API：API 失败时回滚快照，保证数据与配置永远一致
    setHiddenRecord(ctx.dataDir, store, name, { ...snapshot, hiddenAt: new Date().toISOString() });
    try {
      await patchProviderConfig(env.server, name, patch);
    } catch (err) {
      dropHiddenRecord(ctx.dataDir, store, name);
      return jsonErr(err.message, 502);
    }
    return json({ ok: true });
  });

  // ── 恢复供应商 ──
  app.post("/api/providers/:name/show", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return jsonErr(env.error, 503);
    const name = c.req.param("name");
    const store = readStore(ctx.dataDir);
    const snapshot = getHiddenRecord(store, name);
    if (!snapshot) return jsonErr("它没在匣底，不用打开", 409);

    const catalog = readEffectiveCatalog(env.hanakoHome);
    if (!catalog) {
      dropHiddenRecord(ctx.dataDir, store, name);
      return jsonErr("读不到供应商配置，已顺手清掉这条记录", 500);
    }
    const provider = catalog.providers?.[name];
    if (!provider) {
      // 供应商已被用户删除：快照没有意义，只清记录
      dropHiddenRecord(ctx.dataDir, store, name);
      return json({ ok: true, error: "这家供应商已经不在配置里了，记录已清理" });
    }

    // 快照模型为空或丢失时（原快照本就没存上 / 用户中途在设置页重新发现过模型），
    // 不能把空数组写回去——那等于保持隐藏态。分两档恢复：
    //   1. 自定义供应商（含类型未知，宁可用 fetch 兜底）：调 fetch-models 重新发现真实模型列表后写回
    //   2. 内置供应商：带 seed_default_models 让 Hana 填默认模型
    const builtinIds = resolveBuiltinProviderIds(env.hanakoHome);
    const kind = resolveProviderKind(name, provider, builtinIds);
    const isBuiltin = kind === "builtin";
    let restoreModels = Array.isArray(snapshot?.models) ? snapshot.models : [];
    let fetchError = null;
    if (restoreModels.length === 0 && !isBuiltin) {
      try {
        const fetched = await fetchProviderModels(env.server, name);
        if (fetched.models.length > 0) restoreModels = fetched.models;
        else fetchError = fetched.error || "重新发现模型返回空列表";
      } catch (err) {
        fetchError = err.message;
      }
    }

    const patch = buildShowPatch(provider, { ...snapshot, models: restoreModels }, {
      // 内置供应商一定 seed；自定义供应商 fetch 失败时也带 seed 试一次（可能有默认条目）
      seedDefault: isBuiltin || (restoreModels.length === 0 && fetchError !== null),
    });
    try {
      await patchProviderConfig(env.server, name, patch);
    } catch (err) {
      return jsonErr(err.message, 502);
    }
    dropHiddenRecord(ctx.dataDir, store, name);

    // 恢复后对账：确认模型真的回到 Hana 运行时，没回到给明确警告
    let warning = null;
    if (fetchError) {
      warning = `模型列表没能自动找回（${fetchError}），需要去 Hana 设置页重新「发现模型」一次`;
    } else {
      const modelState = await fetchCurrentModels(env.server).catch(() => null);
      const runtimeIds = (modelState?.models || [])
        .filter((m) => m?.provider === name && typeof m.id === "string")
        .map((m) => m.id);
      if (runtimeIds.length === 0) {
        warning = "供应商已打开，但模型菜单里暂时没看到它的模型——去 Hana 设置页重新「发现模型」即可";
      }
    }
    return json({ ok: true, ...(warning ? { warning } : {}) });
  });

  // ── 模型排序 ──
  app.post("/api/providers/:name/models/reorder", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return jsonErr(env.error, 503);
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.ids)) return jsonErr("参数不对");

    const catalog = readEffectiveCatalog(env.hanakoHome);
    if (!catalog) return jsonErr("读不到供应商配置", 500);
    const provider = catalog.providers?.[name];
    if (!provider) return jsonErr("这家供应商不存在", 404);

    const store = readStore(ctx.dataDir);
    if (getHiddenRecord(store, name)) return jsonErr("它还收在匣底呢，先打开再排模型吧", 409);

    const current = Array.isArray(provider.models) ? provider.models : [];
    const reordered = reorderModelEntries(current, body.ids);
    if (reordered.error) return jsonErr(reordered.error);

    try {
      await patchProviderConfig(env.server, name, { models: reordered.models });
    } catch (err) {
      return jsonErr(err.message, 502);
    }

    // Hana 对内置 provider 会把 allowlist 模型替换回 Pi SDK 原位，
    // 配置文件顺序可能已保存，但运行时菜单未必采用；保存后立即对账，避免页面报喜不报忧。
    const modelState = await fetchCurrentModels(env.server).catch(() => null);
    const runtimeCheck = modelState
      ? inspectRuntimeModelOrder(modelState.models, name, body.ids)
      : null;
    if (runtimeCheck && !runtimeCheck.matches) {
      const kind = resolveProviderKind(name, provider, resolveBuiltinProviderIds(env.hanakoHome));
      const warning = kind === "builtin"
        ? "顺序已保存，但这是 Hana 内置供应商，模型顺序由内置目录决定，菜单不会跟着换"
        : "顺序已保存，但 Hana 当前版本的模型菜单暂时没有跟着换";
      return json({
        ok: true,
        applied: false,
        saved: true,
        runtimeProviderId: runtimeCheck.runtimeProviderId,
        warning,
      });
    }
    return json({ ok: true, applied: true, verified: !!runtimeCheck });
  });

  // ── 供应商改名（只影响模型匣页面显示；主菜单分组头无配置通道）──
  app.post("/api/providers/:name/rename", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return jsonErr(env.error, 503);
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.displayName !== "string") return jsonErr("参数不对");

    const catalog = readCatalog(env.hanakoHome);
    if (!catalog) return jsonErr("读不到供应商配置", 500);
    const result = renameProviderDisplay(catalog, name, body.displayName);
    if (result.error) return jsonErr(result.error);
    try {
      writeCatalogAtomic(env.hanakoHome, catalog);
    } catch (err) {
      return jsonErr("写配置失败：" + (err?.message || String(err)), 500);
    }
    return json({ ok: true, ...result });
  });

  // ── 模型改名（主菜单跟着变；hint：Hana 设置页重新发现模型可能冲掉 name）──
  app.post("/api/providers/:name/models/rename", async (c) => {
    const env = initEnv(ctx);
    if (env.error) return jsonErr(env.error, 503);
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.modelId !== "string" || typeof body.name !== "string") {
      return jsonErr("参数不对");
    }

    const effective = readEffectiveCatalog(env.hanakoHome);
    const provider = effective?.providers?.[name];
    if (!provider) return jsonErr("这家供应商不存在", 404);

    // models 源判定（实测结论）：catalog 显式 models 带 name 会进运行时；
    // provider-plugins 定义文件的 name 不被 Hana 采用（models.json 的元数据来自发现逻辑）。
    // 所以 provider-plugins 型供应商改名时，把完整模型列表白名单化写进 catalog 再改名。
    const catalog = readCatalog(env.hanakoHome);
    const catalogProvider = catalog?.providers?.[name];
    const catalogHasModels = isPlainObject(catalogProvider) && Array.isArray(catalogProvider.models);
    if (!catalogHasModels && !resolveLocalProviderFile(env.hanakoHome, name)) {
      return jsonErr("找不到这个供应商的模型列表", 500);
    }

    let targetModels = null;
    if (catalogHasModels) {
      targetModels = catalogProvider.models;
    } else {
      const effectiveModels = Array.isArray(provider.models) ? provider.models : [];
      if (effectiveModels.length === 0) return jsonErr("这个供应商还没有模型，先配了模型再改名", 400);
      catalogProvider.models = structuredClone(effectiveModels);
      targetModels = catalogProvider.models;
    }

    const result = renameModelEntry(targetModels, body.modelId, body.name);
    if (result.error) return jsonErr(result.error);

    try {
      writeCatalogAtomic(env.hanakoHome, catalog);
    } catch (err) {
      return jsonErr("写配置失败：" + (err?.message || String(err)), 500);
    }

    // 触发 Hana 刷新，让改名进入运行时菜单
    try {
      await triggerProviderRefresh(env.server, name);
    } catch (err) {
      return jsonErr("名字已写入，但刷新模型菜单失败：" + (err?.message || String(err)), 502);
    }

    // 对账：设置新名时断言运行时 name 跟上了；还原默认时若运行时残留旧名则明确提示
    const modelState = await fetchCurrentModels(env.server).catch(() => null);
    const runtime = modelState?.models?.find((m) => m.provider === name && m.id === body.modelId);
    if (result.restored) {
      if (runtime && result.previousName && runtime.name === result.previousName) {
        return json({
          ok: true,
          applied: false,
          saved: true,
          ...result,
          warning: "配置已还原，但菜单里还留着旧名字——需要去 Hana 设置页『重新发现模型』才会变回默认名",
        });
      }
      return json({ ok: true, applied: true, verified: !!runtime, ...result });
    }
    if (runtime && runtime.name !== result.name) {
      return json({
        ok: true,
        applied: false,
        saved: true,
        ...result,
        warning: "名字已保存，但 Hana 菜单暂时没显示新名字（可能是内置目录优先，或设置页重新发现模型时被冲掉）",
      });
    }
    return json({ ok: true, applied: true, verified: !!runtime, ...result });
  });

  // ── 检查更新（分享版必带；仓库地址写死，不依赖环境变量）──
  app.get("/api/check-update", async (c) => {
    const REPO_OWNER = "moononnn";
    const REPO_NAME = "hanako-moxingxia";
    const repoUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
    try {
      const manifestPath = path.join(ctx.pluginDir, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const currentVersion = manifest.version || "0.1.0";

      const resp = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tags?per_page=1`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "moxingxia" },
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) {
        return json({
          success: true,
          current: currentVersion,
          latest: null,
          hasUpdate: false,
          apiDown: true,
          message: `GitHub API 暂时不可用（${resp.status}），可手动去仓库看`,
          repoUrl,
        });
      }

      const tags = await resp.json();
      if (!Array.isArray(tags) || tags.length === 0) {
        return json({ success: true, current: currentVersion, latest: currentVersion, hasUpdate: false, message: "已是最新版本 ✓" });
      }

      const latestTag = String(tags[0].name || "").replace(/^v/, "");
      const hasUpdate = compareVersions(latestTag, currentVersion) > 0;

      let releaseBody = "";
      if (hasUpdate) {
        try {
          const releaseResp = await fetch(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${tags[0].name}`,
            {
              headers: { Accept: "application/vnd.github+json", "User-Agent": "moxingxia" },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (releaseResp.ok) {
            const release = await releaseResp.json();
            releaseBody = release.body || "";
          }
        } catch {
          /* release 正文拉取失败不影响主流程 */
        }
      }

      return json({
        success: true,
        current: currentVersion,
        latest: latestTag,
        hasUpdate,
        updateUrl: hasUpdate ? `${repoUrl}/releases/tag/${tags[0].name}` : null,
        downloadUrl: hasUpdate ? `${repoUrl}/archive/refs/tags/${tags[0].name}.zip` : null,
        repoUrl,
        releaseBody,
        message: hasUpdate ? `发现新版本 v${latestTag}！当前 v${currentVersion}` : "已是最新版本 ✓",
      });
    } catch (e) {
      return json({ success: false, error: e?.message || "网络不可用", repoUrl });
    }
  });
}

/** 版本号比较（semver，兼容两段版本号） */
function compareVersions(a, b) {
  const pa = String(a || "").split(".").map(Number);
  const pb = String(b || "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}