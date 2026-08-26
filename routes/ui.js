// 模型匣 —— 页面与 API 路由
// 页面前缀由 host 代理：/api/plugins/moxingxia/...
// 注意：/api/providers/reorder 必须先于 /api/providers/:name/... 注册，避免被 :name 吞掉

import fs from "node:fs";
import path from "node:path";

import {
  discoverServer,
  fetchCurrentModels,
  patchProviderConfig,
  readCatalog,
  readEffectiveCatalog,
  resolveHanakoHome,
  triggerProviderRefresh,
  writeCatalogAtomic,
} from "../lib/host-api.js";
import {
  buildHidePatch,
  buildShowPatch,
  inspectRuntimeModelOrder,
  inspectRuntimeProviderOrder,
  listProviders,
  reorderModelEntries,
  reorderProvidersObject,
  snapshotProvider,
} from "../lib/catalog.js";
import {
  dropHiddenRecord,
  getHiddenRecord,
  pruneHiddenRecords,
  readStore,
  setHiddenRecord,
} from "../lib/store.js";
import { renderPage } from "../lib/page.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

function jsonErr(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function initEnv(ctx) {
  const hanakoHome = resolveHanakoHome(ctx);
  if (!hanakoHome) return { error: "找不到 Hana 数据目录" };
  const server = discoverServer(hanakoHome);
  if (!server) return { error: "连不上 Hana 服务（server-info 读不到）" };
  return { hanakoHome, server };
}

export default function registerPluginUiRoutes(app, ctx) {
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

    return json({
      ok: true,
      serverOk: true,
      list: listProviders(catalog, store, modelState),
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
    const runtimeCheck = modelState
      ? inspectRuntimeProviderOrder(
        modelState.models,
        body.ids,
        readEffectiveCatalog(env.hanakoHome)?.providers || catalog.providers,
      )
      : null;
    if (runtimeCheck && !runtimeCheck.matches) {
      return json({
        ok: true,
        applied: false,
        saved: true,
        runtimeProviderOrder: runtimeCheck.actualOrder,
        warning: "顺序已保存，但 Hana 当前版本的模型菜单仍按内置目录展示，暂时没有完全跟着换",
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

    const snapshot = snapshotProvider(provider);
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
    const patch = buildShowPatch(provider, snapshot);
    try {
      await patchProviderConfig(env.server, name, patch);
    } catch (err) {
      return jsonErr(err.message, 502);
    }
    dropHiddenRecord(ctx.dataDir, store, name);
    return json({ ok: true });
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

    // Hana 目前对内置 provider 会把 allowlist 模型替换回 Pi SDK 原位，
    // 配置文件顺序可能已保存，但运行时菜单未必采用；保存后立即对账，避免页面报喜不报忧。
    const modelState = await fetchCurrentModels(env.server).catch(() => null);
    const runtimeCheck = modelState
      ? inspectRuntimeModelOrder(modelState.models, name, body.ids)
      : null;
    if (runtimeCheck && !runtimeCheck.matches) {
      return json({
        ok: true,
        applied: false,
        saved: true,
        runtimeProviderId: runtimeCheck.runtimeProviderId,
        warning: "顺序已保存，但 Hana 当前版本的模型菜单仍按内置目录展示，暂时没有跟着换",
      });
    }
    return json({ ok: true, applied: true, verified: !!runtimeCheck });
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