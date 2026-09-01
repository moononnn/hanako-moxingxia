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

  /** 启动备用切换守护（后台轮询日志 → 自动切备用，恢复由页面手动完成） */
  _startFailwatch() {
    try {
      const ctx = this.ctx;
      const hanakoHome = resolveHanakoHome(ctx);
      const logsDir = hanakoHome ? path.join(hanakoHome, "logs") : "";
      const tail = new LogTail({ logsDir });
      // 插件重启时从当前日志末尾建立基线，避免把历史错误当成刚发生。
      tail.prime();
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
        // 读备用模型的思考档位；按失败槽位读取，避免大小模型互相污染判定。
        getBackupThinkingLevel: async (backupCfg, slot) => {
          try {
            const server = discoverServer(hanakoHome);
            if (!server) return null;
            const res = await apiFetch(server, "/api/models");
            if (!res?.ok) return null;
            const models = Array.isArray(res?.body?.models) ? res.body.models : [];
            const ref = backupCfg?.[slot];
            if (typeof ref !== "string" || !ref) return null;
            const [provider, ...rest] = ref.split("/");
            const id = rest.join("/");
            const m = models.find((x) => x.provider === provider && x.id === id);
            return m && typeof m.defaultThinkingLevel === "string" ? m.defaultThinkingLevel : null;
          } catch {
            return null;
          }
        },
        // 读主模型思考档位；按失败槽位读取。
        getMainThinkingLevel: async (slot) => {
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
            const ref = m[slot];
            if (!ref || !(typeof ref === "string" || (ref.provider && ref.id))) return null;
            const text = typeof ref === "string" ? ref : `${ref.provider}/${ref.id}`;
            const [provider, ...rest] = text.split("/");
            const id = rest.join("/");
            const model = models.find((x) => x.provider === provider && x.id === id);
            return model && typeof model.defaultThinkingLevel === "string" ? model.defaultThinkingLevel : null;
          } catch {
            return null;
          }
        },
        // 弹通知走提个醒的对外接口；未安装时 404 也不影响切换。
        sendNotify: async ({ title, message }) => {
          const server = discoverServer(hanakoHome);
          if (!server) return false;
          const result = await apiFetch(server, "/api/plugins/tigexing/api/external/notify", {
            method: "POST",
            body: JSON.stringify({ title, message }),
          });
          return !!result?.ok;
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