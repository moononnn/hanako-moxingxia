// 模型匣 —— 降级守护（后台动作层）
//
// 职责：定时轮询 Hana 日志 → 识别失败信号 → 判定是否降级 → 调主 API
// 切换备用模型；降级后定时探测主模型 → 恢复后切回。
//
// 依赖注入便于测试（不真跑定时器）。

import {
  decideDegrade,
  decideRestore,
  decideNotify,
  decideStandbyFailure,
  collectFailures,
  buildDegradePatch,
  buildRestorePatch,
  isStandbyConfig,
  isThinkingCappedFailure,
} from "./failwatch.js";

const DEFAULT_POLL_MS = 15 * 1000;         // 日志轮询间隔
const DEFAULT_PROBE_INTERVAL_MS = 60 * 1000; // 恢复探测间隔（保留兼容）

// 快速失败切换节奏（2026-09-01 产品决策）：主模型优先，备用临时救火，很快切回
const DEFAULT_HOLD_MS = 60 * 1000; // 备用临时顶班时长（原 5 分钟 → 60 秒）

export class FailwatchGuard {
  /**
   * @param {object} deps
   * @param {() => string[]} deps.readLogLines 读新增日志行
   * @param {() => object|null} deps.discoverServer 发现 Hana server
   * @param {(server, pathname, init) => Promise<object>} deps.apiFetch
   * @param {(dataDir) => object} deps.readStore
   * @param {(dataDir, store) => void} deps.writeStore
   * @param {() => string} deps.dataDir
   * @param {object} deps.policy { threshold, windowMs, holdMs, notifyAfterCycles }
   * @param {object} deps.backup { utility, utility_large, vision } 备用模型
   * @param {(info: {title:string, message:string}) => Promise<any>} deps.sendNotify 弹通知（可选，不传则不弹）
   */
  constructor(deps) {
    this.deps = deps;
    this.policy = {
      threshold: 2,
      windowMs: 5 * 60 * 1000,
      holdMs: DEFAULT_HOLD_MS,
      notifyAfterCycles: 2,
      ...(deps.policy || {}),
    };
    this.backup = deps.backup || {};
    this._timer = null;
    this._lastProbeAt = 0;
  }

  _store() {
    return this.deps.readStore(this.deps.dataDir());
  }
  _save(store) {
    this.deps.writeStore(this.deps.dataDir(), store);
  }
  _state(store) {
    return store.failwatch || {};
  }

  /**
   * 备用模型的思考档位（defaultThinkingLevel）。
   * 通过 deps.getBackupThinkingLevel 注入（guard 自身不查 /api/models，保持可测）；
   * 读不到返回 null → 保守：不触发思考型兼容，走原判定。
   */
  async _backupThinkingLevel() {
    try {
      const level = await this.deps.getBackupThinkingLevel?.(this.backup);
      return typeof level === "string" && level ? level : null;
    } catch {
      return null;
    }
  }

  /** 一次轮询：读日志 → 判定 → 必要时降级。lines 可注入（测试用），缺省走 deps.readLogLines */
  async tick(linesOverride) {
    const lines = linesOverride !== undefined ? linesOverride : this.deps.readLogLines();
    if (!lines || lines.length === 0) return null;
    const failures = collectFailures(lines);
    if (failures.length === 0) return null;

    const store = this._store();
    const state = this._state(store);

    // 手动接管检测（统一入口）：降级态期间用户手动改了 Hana 模型配置，
    // 就不再自动覆盖（不降级、不切回），直接退出降级态（2026-09-01 产品决策）。
    if (state.degraded) {
      const takeover = await this._checkManualTakeover(store, state);
      if (takeover) return takeover;
    }

    // 降级态期间仍在报失败 → 备用模型可能也在坏，走兜底判定
    if (state.degraded) {
      const backupLevel = await this._backupThinkingLevel();
      // 思考型兼容：备胎是深度思考型 + 失败是空响应 → 不是真坏，不累计
      const capped = failures.some((f) =>
        isThinkingCappedFailure(f, backupLevel)
      );
      if (capped) {
        // 记录一次 thinking-capped 事件（页面可展示），但不累计 standbyFailures
        const prev = store.failwatch || {};
        store.failwatch = {
          ...prev,
          thinkingCapped: (prev.thinkingCapped || 0) + 1,
          lastThinkingCappedAt: Date.now(),
        };
        this._save(store);
        return { action: "standby-thinking-capped", failures, reason: "thinking-capped", capped: true };
      }

      const sd = decideStandbyFailure(state, this.policy);
      store.failwatch = sd.nextState;
      this._save(store);
      if (sd.shouldStop) {
        // 两个模型都坏，停掉循环，通知用户手动处理
        this._notify({
          title: "备用模型也出问题了，降级已停止",
          message: "主模型和备用模型都连续失败了，已停止自动降级。请尽快检查模型配置和额度，手动切换到可用的模型。",
        });
        return { action: "standby-failed-stop", failures, reason: "standby-threshold" };
      }
      return { action: "standby-degrading", failures, reason: "standby-pending" };
    }

    // 确定本次失败类型：vision 失败走 1 次阈值，其他走 2 次。
    // 多条失败要逐条累计（每条 +1），而不是“有失败就 +1”——否则一锅 8 条失败只算 1 次，
    // 永远到不了阈值（2026-09-01 实测 bug：滚动摘要一轮炸 3 条，consecutiveFailures 仍停 1）。
    const isVisionFail = failures.some((f) => f.kind === "vision");
    const failureKind = isVisionFail ? "vision" : undefined;
    // 逐条喂给 decideDegrade：每条失败累加一次计数，直到达标或耗尽
    let curState = state;
    let decision = null;
    for (const f of failures) {
      const d = decideDegrade(curState, { ...this.policy, failureKind });
      curState = d.nextState;
      if (d.shouldDegrade) { decision = d; break; }
    }
    if (!decision) {
      store.failwatch = curState;
      this._save(store);
      return { action: "pending", failures, reason: "pending", vision: isVisionFail };
    }

    // 达标触发降级（decision.nextState 已含降级态标记，_doDegrade 会再存）
    store.failwatch = decision.nextState;
    this._save(store);

    const result = await this._doDegrade(store);
    // 降级成功后检查是否该通知（连续两轮都坏）
    let notify = null;
    if (result.ok) {
      const notifyDecision = decideNotify(this._state(store), this.policy);
      if (notifyDecision.shouldNotify) {
        store.failwatch = notifyDecision.nextState;
        this._save(store);
        notify = { shouldNotify: true, cycles: notifyDecision.nextState.cycles };
        this._notify({
          title: "模型持续出问题，已切到备用模型",
          message: "Hana 的小工具/大工具模型连续两轮都失败了，已经自动切到备用模型。建议去检查一下模型额度或配置。",
        });
      }
    }
    return { action: result.ok ? "degraded" : "degrade-failed", failures, reason: decision.reason, notify, ...result };
  }

  /** 弹通知（提个醒接口；失败不阻断主流程）。返回 promise 供调用方决定是否等待。 */
  _notify(info) {
    const p = this.deps.sendNotify?.(info);
    return Promise.resolve(p).catch(() => {});
  }

  /**
   * 手动接管检测：降级态期间，如果当前 Hana 配置已不是「备用配置」
   * （用户手动改过模型），返回 true 并退出降级态，不再自动覆盖。
   * @returns {Promise<{action:string, reason:string}|null>} 接管了返回结果，否则 null
   */
  async _checkManualTakeover(store, state) {
    const server = this.deps.discoverServer();
    if (!server) return null;
    const current = await this._readSharedModels(server);
    if (!current) return null;
    const standby = state.lastDegradePatch || this.backup;
    if (isStandbyConfig(current, standby)) return null; // 还是备用配置，没人动
    // 用户手动改过 → 退出降级态，不覆盖
    const next = {
      ...store.failwatch,
      degraded: false,
      degradedAt: null,
      manualTakenOver: true,
      manualTakenOverAt: Date.now(),
    };
    delete next.snapshot;
    store.failwatch = next;
    this._save(store);
    return { action: "manual-takeover", reason: "user-changed-config" };
  }

  /** 实际执行降级：读快照 → 改配置 + 存状态 */
  async _doDegrade(store) {
    const server = this.deps.discoverServer();
    if (!server) return { ok: false, error: "server-unreachable" };

    // 手动接管检测（降级前）：如果用户已经把 Hana 模型改成可用配置
    // （不再是降级前快照的原配置），就不该再自动降级覆盖（2026-09-01 产品决策）。
    // 注意：此刻还没降级，state.degraded=false，不能复用 _checkManualTakeover（那是降级态专用）。
    const prevState = store.failwatch || {};
    if (prevState.snapshot) {
      const current = await this._readSharedModels(server);
      if (current && !isStandbyConfig(current, prevState.snapshot)) {
        // 当前配置已不是降级前原样 → 用户手动改过，不自动降级
        store.failwatch = { ...prevState, degraded: false, degradedAt: null, manualTakenOver: true, manualTakenOverAt: Date.now() };
        delete store.failwatch.snapshot;
        this._save(store);
        return { ok: false, error: "manual-takeover", action: "manual-takeover" };
      }
    }

    const patch = buildDegradePatch(this.backup);
    if (Object.keys(patch).length === 0) {
      // 没配备用模型 → 无法降级；但把状态标记为 degraded 避免反复判定
      store.failwatch = { ...store.failwatch, degraded: true, degradedAt: Date.now(), consecutiveFailures: 0 };
      this._save(store);
      return { ok: false, error: "no-backup-configured" };
    }
    try {
      // 快照-恢复制：先读用户当前配置存快照（只有降级前才快照，避免覆盖已存快照）
      const prev = store.failwatch || {};
      if (!prev.snapshot) {
        const snapshot = await this._readSharedModels(server);
        if (snapshot) prev.snapshot = snapshot;
      }
      const res = await this.deps.apiFetch(server, "/api/preferences/models", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      if (!res.ok) return { ok: false, error: `http-${res.status}` };
      const now = Date.now();
      // 保留 cycles（降级轮次计数）/ notifiedCycles，降级态刷新时间戳与 patch
      store.failwatch = {
        ...prev,
        degraded: true,
        degradedAt: now,
        consecutiveFailures: 0,
        lastFailureAt: now,
        lastDegradePatch: patch,
        lastDegradeAt: now,
      };
      this._save(store);
      return { ok: true, patch };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** 读当前共享模型配置（快照用）。失败返回 null。 */
  async _readSharedModels(server) {
    try {
      const res = await this.deps.apiFetch(server, "/api/preferences/models");
      if (!res?.ok || !res.body?.models) return null;
      const m = res.body.models;
      // 只快照我们管得到的三个槽位；对象/字符串都保留原样
      const snap = {};
      for (const key of ["utility", "utility_large", "vision"]) {
        if (Object.prototype.hasOwnProperty.call(m, key)) snap[key] = m[key] ?? null;
      }
      return Object.keys(snap).length > 0 ? snap : null;
    } catch {
      return null;
    }
  }

  /** 恢复探测：降级态 + 坚持期满 → 切回主模型（写回快照，而不是清空） */
  async maybeRestore() {
    const store = this._store();
    const state = this._state(store);
    if (!state.degraded) return null;

    const decision = decideRestore(true, state, this.policy);
    if (!decision.shouldRestore) return null;

    const server = this.deps.discoverServer();
    if (!server) return null;

    // 手动接管检测：降级期间如果用户手动改了 Hana 模型配置（不再是备用配置），
    // 就不再自动切回/覆盖用户的选择，直接退出降级态（2026-09-01 产品决策）。
    const takeover = await this._checkManualTakeover(store, state);
    if (takeover) return takeover;

    // 快照-恢复制：优先写回降级前快照；没快照时退化为旧行为（清空回退 chat）
    const patch = buildRestorePatch(state.lastDegradePatch || this.backup, state.snapshot || null);
    try {
      const res = await this.deps.apiFetch(server, "/api/preferences/models", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      if (!res.ok) return { action: "restore-failed", error: `http-${res.status}` };
      const next = { ...store.failwatch, degraded: false, degradedAt: null, restoredAt: Date.now() };
      // 恢复成功后清掉快照（下次降级重新快照，避免写入过期的旧配置）
      delete next.snapshot;
      store.failwatch = next;
      this._save(store);
      return { action: "restored", patch };
    } catch (err) {
      return { action: "restore-failed", error: err?.message || String(err) };
    }
  }

  /** 探测主模型是否恢复。默认实现：查 /api/models 判活（保守，不真发 LLM） */
  async _probeMainModel() {
    try {
      const server = this.deps.discoverServer();
      if (!server) return false;
      const res = await this.deps.apiFetch(server, "/api/models");
      return !!res.ok;
    } catch {
      return false;
    }
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch(() => {});
      this.maybeRestore().catch(() => {});
    }, this.deps.pollMs || DEFAULT_POLL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
