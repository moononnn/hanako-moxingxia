// 模型匣 —— 插件生命周期入口
// 纪律：onload 只做轻量注册，不做重活（坑 48/49：onload 超时会丢插件）

import path from "node:path";
import { FailwatchGuard } from "./lib/failwatch-guard.js";
import { LogTail } from "./lib/failwatch.js";
import { readStore, writeStore } from "./lib/store.js";
import { discoverServer, apiFetch, resolveHanakoHome } from "./lib/host-api.js";

export default class Plugin {
  // 注意：onload 被宿主无参调用，ctx 由宿主在实例化后注入到 this.ctx
  // （c.ctx = t.ctx 先于 c.onload() 执行），不要自己接参覆盖
  async onload() {
    this.ctx.log.info("[模型匣] loaded");
    this._startFailwatch();
  }

  async onunload() {
    this.ctx.log.info("[模型匣] unloaded");
    if (this._guard) {
      this._guard.stop();
      this._guard = null;
    }
  }

  /** 启动降级守护（后台轮询日志 → 自动降级/恢复） */
  _startFailwatch() {
    try {
      const ctx = this.ctx;
      const hanakoHome = resolveHanakoHome(ctx);
      const logsDir = hanakoHome ? path.join(hanakoHome, "logs") : "";
      const tail = new LogTail({ logsDir });
      const store = readStore(ctx.dataDir);
      const backup = store.failwatch?.backup || {};
      const guard = new FailwatchGuard({
        readLogLines: () => tail.readNewLines(),
        discoverServer: () => discoverServer(hanakoHome),
        apiFetch,
        readStore,
        writeStore,
        dataDir: () => ctx.dataDir,
        backup,
        policy: store.failwatch?.policy || undefined,
        // 读备用模型的思考档位（深度思考型兼容判定用）。读不到返回 null → 保守不兼容。
        getBackupThinkingLevel: async (backupCfg) => {
          try {
            const server = discoverServer(hanakoHome);
            if (!server) return null;
            const res = await apiFetch(server, "/api/models");
            if (!res?.ok) return null;
            const models = Array.isArray(res?.body?.models) ? res.body.models : [];
            // 找备用模型里第一个带 thinking 档位的
            for (const key of ["utility", "utility_large", "vision"]) {
              const ref = backupCfg?.[key];
              if (typeof ref !== "string" || !ref) continue;
              const [provider, ...rest] = ref.split("/");
              const id = rest.join("/");
              const m = models.find((x) => x.provider === provider && x.id === id);
              if (m && typeof m.defaultThinkingLevel === "string" && m.defaultThinkingLevel) {
                return m.defaultThinkingLevel;
              }
            }
            return null;
          } catch {
            return null;
          }
        },
        // 读主模型（当前 Hana 配置的 utility/utility_large）的思考档位，
        // 用于「主模型 thinking-capped」兼容判定（2026-09-01 实测 command code 深度思考型空响应）。
        getMainThinkingLevel: async () => {
          try {
            const server = discoverServer(hanakoHome);
            if (!server) return null;
            const [prefsRes, modelsRes] = await Promise.all([
              apiFetch(server, "/api/preferences/models"),
              apiFetch(server, "/api/models"),
            ]);
            if (!prefsRes?.ok || !modelsRes?.ok) return null;
            const m = prefsRes.body?.models || {};
            const models = Array.isArray(modelsRes.body?.models) ? modelsRes.body.models : [];
            // 当前 utility / utility_large 的模型引用
            const refs = [m.utility, m.utility_large]
              .filter((r) => r && (typeof r === "string" || (r.provider && r.id)))
              .map((r) => (typeof r === "string" ? r : `${r.provider}/${r.id}`));
            for (const ref of refs) {
              const [provider, ...rest] = ref.split("/");
              const id = rest.join("/");
              const model = models.find((x) => x.provider === provider && x.id === id);
              if (model && typeof model.defaultThinkingLevel === "string" && model.defaultThinkingLevel) {
                return model.defaultThinkingLevel;
              }
            }
            return null;
          } catch {
            return null;
          }
        },
        // 弹通知走提个醒的对外接口（复用它的静默时段/风格/音效）
        sendNotify: async ({ title, message }) => {
          const server = discoverServer(hanakoHome);
          if (!server) return;
          await apiFetch(server, "/api/plugins/tigexing/api/external/notify", {
            method: "POST",
            body: JSON.stringify({ title, message }),
          });
        },
      });
      guard.start();
      this._guard = guard;
      this.ctx.log.info(`[模型匣] failwatch started (backup=${JSON.stringify(backup)})`);
    } catch (err) {
      this.ctx.log.error(`[模型匣] failwatch start failed: ${err?.message || err}`);
    }
  }
}