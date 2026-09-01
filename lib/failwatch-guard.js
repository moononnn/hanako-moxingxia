// 模型匣 —— 备用模型切换守护（后台动作层）
//
// 职责：定时轮询 Hana 日志 → 识别失败信号 → 按槽位切到备用模型。
// 新语义：切换后保持备用模型，恢复必须由用户在模型匣里手动触发；不再自动切回。
// 依赖注入便于测试（不真跑定时器）。

import {
  FAILWATCH_SLOTS,
  FAILWATCH_SLOT_LABELS,
  collectFailures,
  decideDegrade,
  decideStandbyFailure,
  buildDegradePatch,
  isStandbyConfig,
  normalizeFailwatchSlots,
  isActiveFallbackSlot,
  failureReason,
  isImmediateFailure,
  isThinkingCappedFailure,
} from "./failwatch.js";

const DEFAULT_POLL_MS = 15 * 1000;
const DEFAULT_THRESHOLD = 2;
const DEFAULT_VISION_THRESHOLD = 1;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_STANDBY_THRESHOLD = 2;

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function refText(ref) {
  if (typeof ref === "string" && ref.trim()) return ref.trim();
  if (ref && typeof ref === "object" && ref.provider && ref.id) {
    return `${ref.provider}/${ref.id}`;
  }
  return "当前模型";
}

export class FailwatchGuard {
  /**
   * @param {object} deps
   * @param {() => string[]} deps.readLogLines 读新增日志行
   * @param {() => object|null} deps.discoverServer 发现 Hana server
   * @param {(server, pathname, init) => Promise<object>} deps.apiFetch
   * @param {(dataDir) => object} deps.readStore
   * @param {(dataDir, store) => void} deps.writeStore
   * @param {() => string} deps.dataDir
   * @param {object} deps.policy { threshold, visionThreshold, windowMs, standbyThreshold }
   * @param {object} deps.backup { utility, utility_large, vision } 备用模型
   * @param {(info: {title:string, message:string}) => Promise<any>} deps.sendNotify 弹通知（可选，不传则不弹）
   */
  constructor(deps) {
    this.deps = deps;
    this.policy = {
      threshold: DEFAULT_THRESHOLD,
      visionThreshold: DEFAULT_VISION_THRESHOLD,
      windowMs: DEFAULT_WINDOW_MS,
      standbyThreshold: DEFAULT_STANDBY_THRESHOLD,
      ...(deps.policy || {}),
    };
    this.backup = deps.backup || {};
    this._timer = null;
    this._tickInFlight = null;
  }

  _store() {
    const store = this.deps.readStore(this.deps.dataDir());
    // 页面保存备用模型后不需要重启插件；每轮从持久化状态刷新一份快照。
    this.backup = store.failwatch?.backup && typeof store.failwatch.backup === "object"
      ? { ...store.failwatch.backup }
      : {};
    return store;
  }

  _save(store) {
    this.deps.writeStore(this.deps.dataDir(), store);
  }

  _state(store) {
    if (!store.failwatch || typeof store.failwatch !== "object") store.failwatch = {};
    return store.failwatch;
  }

  _slots(fw) {
    const slots = normalizeFailwatchSlots(fw);
    fw.slots = slots;
    return slots;
  }

  _syncLegacySummary(fw) {
    const slots = this._slots(fw);
    const active = FAILWATCH_SLOTS.filter((key) => isActiveFallbackSlot(slots[key]));
    fw.degraded = active.length > 0;
    fw.consecutiveFailures = FAILWATCH_SLOTS.reduce((sum, key) => sum + (slots[key].consecutiveFailures || 0), 0);
    fw.visionFailures = slots.vision.visionFailures || 0;
    fw.standbyFailures = FAILWATCH_SLOTS.reduce((sum, key) => sum + (slots[key].standbyFailures || 0), 0);
    fw.lastFailureAt = FAILWATCH_SLOTS.reduce((latest, key) => {
      const at = slots[key].lastFailureAt || 0;
      return at > latest ? at : latest;
    }, fw.lastFailureAt || 0) || null;
    if (active.length === 0) {
      fw.degradedAt = null;
      delete fw.snapshot;
      delete fw.lastDegradePatch;
      return;
    }

    const patchModels = {};
    const snapshots = {};
    let earliest = null;
    for (const key of active) {
      const state = slots[key];
      const ref = state.lastDegradePatch?.models?.[key] || this.backup[key];
      if (ref) patchModels[key] = ref;
      if (hasOwn(state, "snapshot")) snapshots[key] = state.snapshot;
      if (state.switchedAt && (!earliest || state.switchedAt < earliest)) earliest = state.switchedAt;
    }
    fw.degradedAt = earliest;
    fw.lastDegradePatch = { models: patchModels };
    if (Object.keys(snapshots).length > 0) fw.snapshot = snapshots;
    else delete fw.snapshot;
  }

  _appendEvent(fw, event) {
    fw.events = Array.isArray(fw.events) ? fw.events : [];
    fw.events.push({ ...event, at: event.at || new Date().toISOString() });
    if (fw.events.length > 50) fw.events = fw.events.slice(-50);
  }

  /** 备用模型的思考档位；按当前失败槽位读取，避免大小模型互相污染判定。 */
  async _backupThinkingLevel(slot) {
    try {
      const level = await this.deps.getBackupThinkingLevel?.(this.backup, slot);
      return typeof level === "string" && level ? level : null;
    } catch {
      return null;
    }
  }

  /** 主模型的思考档位；按当前失败槽位读取。 */
  async _mainThinkingLevel(slot) {
    try {
      const level = await this.deps.getMainThinkingLevel?.(slot);
      return typeof level === "string" && level ? level : null;
    } catch {
      return null;
    }
  }

  /** 弹通知（提个醒接口；失败不阻断切换）。 */
  _notify(info) {
    const p = this.deps.sendNotify?.(info);
    return Promise.resolve(p).catch(() => {});
  }

  _notifySwitch(slot, mainRef, backupRef, failure) {
    const label = FAILWATCH_SLOT_LABELS[slot] || "模型";
    const reason = failureReason(failure);
    this._notify({
      title: `${label}已切到备用模型`,
      message: `${label}「${refText(mainRef)}」因为${reason}，已切换到备用模型「${refText(backupRef)}」。需要恢复时，请在模型匣点击“手动切回主模型”。`,
    });
  }

  /** 读当前共享模型配置（快照用）。失败返回 null。 */
  async _readSharedModels(server) {
    try {
      const res = await this.deps.apiFetch(server, "/api/preferences/models");
      if (!res?.ok || !res.body?.models) return null;
      const m = res.body.models;
      const snap = {};
      for (const key of FAILWATCH_SLOTS) {
        if (hasOwn(m, key)) snap[key] = m[key] ?? null;
      }
      return Object.keys(snap).length > 0 ? snap : null;
    } catch {
      return null;
    }
  }

  _markManualTakeover(store, slot, state) {
    const fw = this._state(store);
    state.mode = "manual";
    state.manualTakenOver = true;
    state.manualTakenOverAt = Date.now();
    delete state.snapshot;
    delete state.lastDegradePatch;
    fw.manualTakenOver = true;
    fw.manualTakenOverAt = Date.now();
    this._appendEvent(fw, {
      type: "manual-takeover",
      slot,
      label: FAILWATCH_SLOT_LABELS[slot],
      reason: "user-changed-config",
    });
    this._syncLegacySummary(fw);
    this._save(store);
    return { action: "manual-takeover", error: "manual-takeover", slot, reason: "user-changed-config" };
  }

  /**
   * 降级态期间，如果用户手动改了某个槽位，停止管理该槽位，不能再覆盖。
   */
  _checkManualTakeoverForSlot(store, slot, state, current) {
    if (!isActiveFallbackSlot(state) || !current) return null;
    const expected = state.lastDegradePatch || buildDegradePatch(this.backup, [slot]);
    if (!expected?.models?.[slot]) return null;
    if (isStandbyConfig({ [slot]: current[slot] }, expected)) return null;
    return this._markManualTakeover(store, slot, state);
  }

  /** 实际切换一个槽位到备用模型。 */
  async _doDegradeSlot(store, slot, failure, current) {
    const fw = this._state(store);
    const slots = this._slots(fw);
    const state = slots[slot];
    const backupRef = this.backup[slot];
    if (!backupRef) {
      state.mode = "primary";
      state.degraded = false;
      this._syncLegacySummary(fw);
      this._save(store);
      return { ok: false, error: "no-backup-configured", slot };
    }

    const patch = buildDegradePatch(this.backup, [slot]);
    if (!patch.models[slot]) {
      return { ok: false, error: "no-backup-configured", slot };
    }

    const currentRef = current?.[slot];
    // 当前已经是备用模型，通常代表用户自己提前切过；不重新覆盖，也不制造错误快照。
    if (current && isStandbyConfig({ [slot]: currentRef }, patch)) {
      return this._markManualTakeover(store, slot, state);
    }

    const server = this.deps.discoverServer();
    if (!server) return { ok: false, error: "server-unreachable", slot };

    const snapshot = current && hasOwn(current, slot) ? currentRef ?? null : null;
    try {
      const res = await this.deps.apiFetch(server, "/api/preferences/models", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      if (!res?.ok) return { ok: false, error: `http-${res?.status || 0}`, slot };

      // Hana 某些旧接口可能返回 ok 但没有实际改到配置；能读回时必须对账。
      const after = await this._readSharedModels(server);
      if (after && hasOwn(after, slot) && !isStandbyConfig({ [slot]: after[slot] }, patch)) {
        return { ok: false, error: "config-not-applied", slot };
      }

      const now = Date.now();
      slots[slot] = {
        ...state,
        mode: "backup",
        degraded: true,
        switchedAt: now,
        degradedAt: now,
        snapshot,
        lastDegradePatch: patch,
        lastFailureAt: now,
        standbyFailures: 0,
        standbyFailed: false,
        manualTakenOver: false,
      };
      this._appendEvent(fw, {
        type: "switch-to-backup",
        slot,
        label: FAILWATCH_SLOT_LABELS[slot],
        main: refText(snapshot),
        backup: refText(backupRef),
        reason: failureReason(failure),
        failureKind: failure?.kind || "error",
      });
      this._syncLegacySummary(fw);
      this._save(store);
      this._notifySwitch(slot, snapshot, backupRef, failure);
      return {
        ok: true,
        action: "switched-to-backup",
        slot,
        patch,
        main: snapshot,
        backup: backupRef,
        reason: failureReason(failure),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), slot };
    }
  }

  async _processStandbySlot(store, slot, failures, current) {
    const fw = this._state(store);
    const slots = this._slots(fw);
    const state = slots[slot];
    if (state.mode === "backup-failed") {
      return { action: "backup-failed", slot, reason: "standby-threshold" };
    }
    const takeover = this._checkManualTakeoverForSlot(store, slot, state, current);
    if (takeover) return takeover;
    if (state.mode === "manual") return { action: "manual-takeover", slot, reason: "user-changed-config" };

    const backupLevel = await this._backupThinkingLevel(slot);
    const realFailures = failures.filter((failure) => !isThinkingCappedFailure(failure, backupLevel));
    const cappedCount = failures.length - realFailures.length;
    if (cappedCount > 0) {
      state.thinkingCapped = (state.thinkingCapped || 0) + cappedCount;
      fw.thinkingCapped = (fw.thinkingCapped || 0) + cappedCount;
      fw.lastThinkingCappedAt = Date.now();
    }
    if (realFailures.length === 0) {
      this._syncLegacySummary(fw);
      this._save(store);
      return { action: "standby-thinking-capped", slot, capped: true, failures };
    }

    const decision = decideStandbyFailure(
      { ...state, degraded: true },
      this.policy,
    );
    slots[slot] = {
      ...state,
      ...decision.nextState,
      mode: decision.shouldStop ? "backup-failed" : "backup",
      degraded: true,
    };
    if (decision.shouldStop) {
      this._appendEvent(fw, {
        type: "backup-failed",
        slot,
        label: FAILWATCH_SLOT_LABELS[slot],
        backup: refText(this.backup[slot]),
        reason: failureReason(realFailures[0]),
      });
    }
    this._syncLegacySummary(fw);
    this._save(store);
    return {
      action: decision.shouldStop ? "backup-failed" : "standby-failing",
      slot,
      reason: decision.shouldStop ? "standby-threshold" : "standby-pending",
      failures,
    };
  }

  async _processPrimarySlot(store, slot, failures, current) {
    const fw = this._state(store);
    const slots = this._slots(fw);
    const state = slots[slot];
    if (state.mode === "manual") {
      return { action: "manual-takeover", slot, reason: "user-changed-config" };
    }

    // 深度思考模型在小预算工具调用下可能只是没来得及输出正文，不把它误判成模型坏了。
    const mainLevel = slot === "vision" ? null : await this._mainThinkingLevel(slot);
    const realFailures = failures.filter((failure) => !isThinkingCappedFailure(failure, mainLevel));
    const cappedCount = failures.length - realFailures.length;
    if (cappedCount > 0) {
      state.thinkingCapped = (state.thinkingCapped || 0) + cappedCount;
      fw.thinkingCapped = (fw.thinkingCapped || 0) + cappedCount;
      fw.lastThinkingCappedAt = Date.now();
    }
    if (realFailures.length === 0) {
      this._syncLegacySummary(fw);
      this._save(store);
      return { action: "main-thinking-capped", slot, capped: true, failures };
    }

    let curState = state;
    let decision = null;
    let triggerFailure = realFailures[0];
    for (const failure of realFailures) {
      const decisionForFailure = decideDegrade(curState, {
        ...this.policy,
        failureKind: slot === "vision" ? "vision" : undefined,
        immediate: isImmediateFailure(failure),
      });
      curState = decisionForFailure.nextState;
      if (decisionForFailure.shouldDegrade) {
        decision = decisionForFailure;
        triggerFailure = failure;
        break;
      }
    }

    slots[slot] = curState;
    this._syncLegacySummary(fw);
    this._save(store);
    if (!decision) {
      return { action: "pending", slot, reason: "pending", failures };
    }

    const result = await this._doDegradeSlot(store, slot, triggerFailure, current);
    if (!result.ok && result.error !== "manual-takeover") {
      // PUT 失败或没有备用时，不能把未切成功的槽位留在“已降级”假状态。
      const failedState = slots[slot];
      slots[slot] = {
        ...failedState,
        mode: "primary",
        degraded: false,
        consecutiveFailures: 0,
        visionFailures: 0,
      };
      this._syncLegacySummary(fw);
      this._save(store);
    }
    return {
      action: result.ok ? "switched-to-backup" : "switch-failed",
      slot,
      reason: decision.reason,
      failures,
      ...result,
    };
  }

  /** 一次轮询：按槽位处理新增失败；同一槽位一次批量只允许切换一次。 */
  async tick(linesOverride) {
    const lines = linesOverride !== undefined ? linesOverride : this.deps.readLogLines();
    if (!lines || lines.length === 0) return null;
    const failures = collectFailures(lines);
    if (failures.length === 0) return null;

    const store = this._store();
    const fw = this._state(store);
    const slots = this._slots(fw);
    const server = this.deps.discoverServer();
    const current = server ? await this._readSharedModels(server) : null;
    const results = [];
    const grouped = new Map();
    for (const failure of failures) {
      const slot = FAILWATCH_SLOTS.includes(failure.slot) ? failure.slot : "utility";
      if (!grouped.has(slot)) grouped.set(slot, []);
      grouped.get(slot).push({ ...failure, slot });
    }

    for (const slot of FAILWATCH_SLOTS) {
      const group = grouped.get(slot);
      if (!group || group.length === 0) continue;
      const state = slots[slot];
      let result;
      if (isActiveFallbackSlot(state)) {
        result = await this._processStandbySlot(store, slot, group, current);
      } else {
        result = await this._processPrimarySlot(store, slot, group, current);
      }
      results.push(result);
    }

    if (results.length === 1) return { ...results[0], failures };
    const switched = results.filter((result) => result.action === "switched-to-backup").length;
    return {
      action: switched > 0 ? "batch-switched" : "batch-processed",
      failures,
      results,
    };
  }

  /** 新语义不自动恢复；保留方法供旧调用方安全得到明确结果。 */
  async maybeRestore() {
    return { action: "manual-only", reason: "manual-restore-required" };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._tickInFlight) return;
      this._tickInFlight = Promise.resolve(this.tick())
        .catch(() => {})
        .finally(() => { this._tickInFlight = null; });
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
