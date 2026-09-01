// 模型匣 —— 降级保护与消耗监测（纯逻辑，可测试）
//
import fs from "node:fs";
import path from "node:path";
//
// 背景（源码调研 v0.810.0）：
//   Hana 的 utility / utility_large / vision 模型解析是「单点」：
//     utility = 共享配置显式值 → agent 配置 → chat 兜底
//   一旦模型失败（空响应/超时/认证/限流），直接抛错，没有运行时降级。
//   模型槽位是共享配置（user/preferences.json），改动即时生效（每次调用重新解析）。
//
// 本模块提供：
//   1. 失败信号识别（从日志行）
//   2. 一次性降级状态机（连续失败 N 次 → 降级；只降级一次；冷却后恢复）
//   3. 配置 patch 生成（降级切备用 / 恢复清空回退 chat）
//   4. 消耗量监测（从 usage-ledger.json 统计）

// ── 失败信号识别 ──

/**
 * 从一行日志里识别「工具模型失败」信号。
 * @param {string} line
 * @returns {{ kind: string, raw: string } | null}
 *   kind: "empty" | "timeout" | "auth" | "rate" | "error"
 */
export function parseFailureSignal(line) {
  if (typeof line !== "string" || line.length === 0) return null;
  // 排除恢复成功行：Hana 的「滚动摘要 恢复正常 / recovered (was: <错误原文>)」会把错误文本原样带回来，
  // 不排除会被误判成一次新失败（2026-09-01 实测 8 条失败里有 3 条是恢复行误报）。
  if (/恢复正常|\brecovered\b|\brecovery\b/i.test(line)) return null;
  const markers = [
    // 空响应 / 无正文（memory-ticker、compile、callText 最常见）
    { kind: "empty", re: /模型未回复正文|EMPTY_AFTER_THINKING|LLM_EMPTY_RESPONSE|empty (response|reply)/i },
    // 超时
    { kind: "timeout", re: /LLM_TIMEOUT|timed? ?out|超时/i },
    // 认证失败
    { kind: "auth", re: /LLM_AUTH_FAILED|authentication failed|认证失败|invalid api key|api key.*(invalid|error)/i },
    // 限流
    { kind: "rate", re: /LLM_RATE_LIMITED|rate ?limit|限流|429/i },
    // 额度用尽 / 余额不足（没充值最常见：Monthly usage limit / quota / insufficient balance）
    { kind: "quota", re: /usage limit|monthly limit|quota|insufficient balance|余额不足|额度已|billing|402/i },
    // 视觉辅助模型失败（图片识别）：辅助识图模型不可用/不能识图/分析失败
    { kind: "vision", re: /VISION_CONTEXT_INJECTION_FAILED|vision auxiliary model|vision context injection|vision analyze|辅助视觉|vision model.*(fail|error|unavailable)/i },
    // 通用 LLM 错误（解析失败、provider 缺失等）
    { kind: "error", re: /LLM_.*FAILED|providerMissing|modelNotFound|utilityApi|callText? failed|call-text failed/i },
    // 网络层失败（没充值/断网/连接被重置最常见：fetch failed / ECONNRESET / socket / 域名解析失败）
    // 主对话模型也会 fetch failed，必须靠 scope 限定在工具/记忆/摘要等上下文
    { kind: "network", re: /fetch failed|ECONNRESET|socket disconnected|getaddrinfo|ENOTFOUND|EAI_AGAIN|network error|connection (refused|reset|closed)/i },
  ];
  // 关键：必须限定在「工具模型相关」的上下文里，不能把主对话模型的失败也算进来
  // 注意：empty（空响应）、timeout（超时）和 network（网络）也常出现在 session/reply（主对话），需要 scope；
  //       auth（认证）和 rate（限流）错误码本身就只出现在模型调用失败，自带语义，不用 scope。
  // vision（视觉辅助）自带语义，也无需 scope（VISION_ 前缀只在识图链路出现）。
  const scopeRe = /utility|工具|memory|记忆|summar|摘要|compile|fact|deep-memory|sample-text|RAG|roll|vision|视觉|识图|image/i;
  for (const m of markers) {
    if (m.re.test(line)) {
      const inScope = (m.kind === "error" || m.kind === "auth" || m.kind === "rate" || m.kind === "vision") || scopeRe.test(line);
      return inScope ? { kind: m.kind, raw: line } : null;
    }
  }
  return null;
}

/** 从一行日志提取时间戳（[HH:MM:SS.mmm] 前缀），失败返回 null */
function logLineTime(line) {
  const m = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/.exec(line);
  if (!m) return null;
  const [h, mi, s, ms] = [m[1], m[2], m[3], m[4]].map(Number);
  const now = new Date();
  // 用今天日期 + 日志时间构造；跨午夜日志罕见，直接取当天
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, s, ms).getTime();
}

/** 从一批日志行里收集失败信号（带时间戳，尽量解析日志行自身时间） */
export function collectFailures(lines, now = Date.now()) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const line of lines) {
    const sig = parseFailureSignal(line);
    if (sig) out.push({ ...sig, at: logLineTime(line) ?? now });
  }
  return out;
}

// ── 循环降级状态机 ──
//
// 节奏（产品决策）：
//   连续失败 2 次（5 分钟内）→ 切到备用
//   备用坚持 5 分钟 → 切回主模型试探（用下一次真实工具调用当试金石）
//   又失败 → 再切备用，再坚持 5 分钟，循环
//   连续两轮（2 个循环周期）都坏 → 触发通知（提醒用户去检查额度/切模型）

/**
 * 判定是否应该触发降级（切到备用）。
 *
 * 阈值分槽（2026-09-01 产品决策）：
 *   - utility / utility_large：连续 threshold 次（默认 2）触发，因为工具调用高频，2 次能避免误判；
 *   - vision（辅助识图）：连续 visionThreshold 次（默认 1）触发，因为识图是低频单次调用，
 *     等 2 次意味着要连发两张图才降级，体验差；识别失败一次就应立刻换备用识图模型。
 *
 * @param {object} state { degraded, degradedAt, consecutiveFailures, visionFailures, lastFailureAt, cycles }
 * @param {object} opts { threshold=2, visionThreshold=1, windowMs=5min }
 * @returns {{ shouldDegrade: boolean, nextState: object, reason: string }}
 */
export function decideDegrade(state, opts = {}) {
  const s = state && typeof state === "object" ? state : {};
  const threshold = opts.threshold || 2;
  const visionThreshold = opts.visionThreshold || 1;
  const windowMs = opts.windowMs || 5 * 60 * 1000;
  const now = Date.now();

  // 已降级 → 不再触发（等坚持期满切回试探）
  if (s.degraded) {
    return { shouldDegrade: false, nextState: { ...s }, reason: "already-degraded" };
  }

  // 本次失败是不是 vision 类（决定计数走哪条 + 用哪个阈值）
  const isVision = opts.failureKind === "vision";

  // 窗口过期 → 重置对应计数
  let consecutive = s.consecutiveFailures || 0;
  let visionFails = s.visionFailures || 0;
  if (s.lastFailureAt && now - s.lastFailureAt > windowMs) {
    consecutive = 0;
    visionFails = 0;
  }
  const nextState = { ...s, lastFailureAt: now };
  const effectiveThreshold = isVision ? visionThreshold : threshold;

  if (isVision) {
    visionFails += 1;
    nextState.visionFailures = visionFails;
    // vision 失败不清 utility 计数（两条链路独立）
    if (visionFails >= visionThreshold) {
      const cycles = (s.cycles || 0) + 1;
      return {
        shouldDegrade: true,
        nextState: { ...nextState, degraded: true, degradedAt: now, visionFailures: 0, consecutiveFailures: 0, cycles },
        reason: "vision-threshold",
      };
    }
    return { shouldDegrade: false, nextState, reason: "vision-pending" };
  }

  consecutive += 1;
  nextState.consecutiveFailures = consecutive;
  if (consecutive >= threshold) {
    // 触发降级：本轮循环计数 +1
    const cycles = (s.cycles || 0) + 1;
    return {
      shouldDegrade: true,
      nextState: { ...nextState, degraded: true, degradedAt: now, consecutiveFailures: 0, visionFailures: 0, cycles },
      reason: "threshold",
    };
  }
  return { shouldDegrade: false, nextState, reason: "pending" };
}

/**
 * 触发降级后生成配置 patch（切到备用模型）。
 * @param {object} cfg 备用模型配置 { utility, utility_large, vision }
 * @returns {object} PUT /api/preferences/models 的 body（需包 models 层，Hana 0.810 实测）
 */
export function buildDegradePatch(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const models = {};
  if (c.utility) models.utility = c.utility;
  if (c.utility_large) models.utility_large = c.utility_large;
  if (c.vision) models.vision = c.vision;
  return { models };
}

/**
 * 判定是否该从降级态切回主模型（备用临时顶班后，快速切回试探）。
 *
 * 快速失败切换（2026-09-01 产品决策）：主模型永远是默认；失败时备用临时顶一下，
 * 很快（holdMs，默认 60 秒）就切回主模型再试，试不动再切备用。备用只是救火员，用完就撤。
 *
 * @param {object} state
 * @param {object} opts { holdMs=60s }
 * @returns {{ shouldRestore: boolean, nextState: object }}
 */
export function decideRestore(probeOk, state, opts = {}) {
  const s = state && typeof state === "object" ? state : {};
  const holdMs = opts.holdMs || 60 * 1000; // 默认 60 秒（原 5 分钟）
  if (!s.degraded) return { shouldRestore: false, nextState: { ...s } };
  const now = Date.now();
  if (s.degradedAt && now - s.degradedAt < holdMs) {
    return { shouldRestore: false, nextState: { ...s } };
  }
  // 备用临时顶班期满 → 切回主模型试探（probeOk 保留兼容，但不再阻塞）
  return {
    shouldRestore: true,
    nextState: { ...s, degraded: false, degradedAt: null },
  };
}

/**
 * 判定是否应该触发通知。
 * 达到 notifyAfterCycles 轮后，每再坏一轮都通知一次（用户可能不在电脑前，多弹几轮
 * 提高被看到的概率；不是只通知一次）。
 * @param {object} state { cycles, notifiedCycles }
 * @param {object} opts { notifyAfterCycles=2 }
 * @returns {{ shouldNotify: boolean, nextState: object }}
 */
export function decideNotify(state, opts = {}) {
  const s = state && typeof state === "object" ? state : {};
  const notifyAfterCycles = opts.notifyAfterCycles || 2;
  const cycles = s.cycles || 0;
  const notifiedCycles = s.notifiedCycles || 0;
  // 达到阈值且本轮还没通知过 → 通知，记录到当前轮次（下一轮再坏会再通知）
  if (cycles >= notifyAfterCycles && cycles > notifiedCycles) {
    return { shouldNotify: true, nextState: { ...s, notifiedCycles: cycles } };
  }
  return { shouldNotify: false, nextState: { ...s } };
}

/**
 * 备用模型兜底判定：降级态期间日志仍在报失败，说明备用模型也在坏。
 * 连续 standbyThreshold 次 → 彻底停掉降级循环（两个模型都坏，别再空转），
 * 等用户手动处理。
 * @param {object} state { degraded, standbyFailures }
 * @param {object} opts { standbyThreshold=2 }
 * @returns {{ shouldStop: boolean, nextState: object }}
 */
export function decideStandbyFailure(state, opts = {}) {
  const s = state && typeof state === "object" ? state : {};
  const standbyThreshold = opts.standbyThreshold || 2;
  if (!s.degraded) return { shouldStop: false, nextState: { ...s } };
  const next = (s.standbyFailures || 0) + 1;
  if (next >= standbyThreshold) {
    return {
      shouldStop: true,
      nextState: {
        ...s,
        standbyFailures: next,
        standbyFailed: true,
        degraded: false,
        degradedAt: null,
      },
    };
  }
  return { shouldStop: false, nextState: { ...s, standbyFailures: next } };
}

// ── 思考型备胎兼容判定 ──
//
// 背景（2026-08-31 实测）：部分模型 defaultThinkingLevel 高（max/high），
// Hana 工具调用（滚动摘要/标题）的 token 预算写死且偏小，思考型模型会
// 把预算几乎全烧在思考上，正文趋近于 0，Hana 报「模型未回复正文」。
// 这不是备胎真坏，是「想太多没来得及说」。插件不修改用户配置，
// 只做归因：这类失败不累计 standbyFailures，避免误判备胎故障。

/**
 * 判断备胎的思考档位是否属于「深度思考型」（容易在小预算下空正文）。
 * @param {string|null|undefined} thinkingLevel 模型的 defaultThinkingLevel
 * @returns {boolean}
 */
export function isDeepThinkingModel(thinkingLevel) {
  return typeof thinkingLevel === "string" && /^(max|xhigh|high)$/i.test(thinkingLevel.trim());
}

/**
 * 判断一次备胎失败是否属于「思考型兼容」（thinking-capped）。
 * 只有空响应/未回复正文类失败 + 备胎是深度思考型，才算兼容；
 * quota / network / auth / timeout 等真实故障绝不放过。
 * @param {object} failure { kind: string }
 * @param {string|null} backupThinkingLevel
 * @returns {boolean}
 */
export function isThinkingCappedFailure(failure, backupThinkingLevel) {
  if (!failure || typeof failure !== "object") return false;
  if (failure.kind !== "empty") return false;
  return isDeepThinkingModel(backupThinkingLevel);
}

/**
 * 恢复主模型后生成配置 patch。
 *
 * 快照-恢复制（2026-09-01 产品决策）：
 *   降级前把用户当前 Hana 配置快照存下来，恢复时写回原值（而不是清空成 null）。
 *   这样用户充了值、模型恢复可用后，Hana 配置自动回到原来的模型，不用重选。
 *
 * @param {object} cfg 降级 patch 或槽位配置（兼容旧输入）
 * @param {object|null} [snapshot] 降级前的原始槽位配置 { utility, utility_large, vision }，
 *   每槽可以是 {id, provider} 对象、"provider/id" 字符串，或 null/undefined（表示原本没配）
 * @returns {{ models: object }}
 */
export function buildRestorePatch(cfg, snapshot) {
  // 兼容两种输入：直接槽位配置 {utility, utility_large, vision}，或已包 models 层的降级 patch {models:{...}}
  const c = (cfg && cfg.models && typeof cfg.models === "object") ? cfg.models : (cfg || {});
  const models = {};
  // 只处理「降级时确实动过的槽位」（patch 里有该键），其他槽位（如没配备用没降级的 vision）
  // 恢复时不动，保持用户当前选择，避免覆盖用户手动改过的配置（2026-09-01 产品决策）。
  for (const key of ["utility", "utility_large", "vision"]) {
    if (!Object.prototype.hasOwnProperty.call(c, key)) continue; // 该槽没降级，不处理
    const snap = snapshot && Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key] : undefined;
    const hasSnap = snap !== undefined && snap !== null;
    if (hasSnap) {
      // 写回原值（对象原样，字符串保持 provider/id 格式）
      models[key] = snap;
    } else {
      // 降级过该槽但快照里没有（旧数据/兼容）→ 清空
      models[key] = null;
    }
  }
  return { models };
}

/**
 * 判断当前 Hana 配置是否还是「备用配置」（我们降级时写的那套）。
 * 用于手动接管检测：降级态期间，如果用户手动改了 Hana 的模型配置，
 * 自动切回/继续降级就不该再覆盖用户的手动选择（2026-09-01 产品决策）。
 *
 * @param {object} current 当前 Hana 配置 { utility, utility_large, vision }（来自 GET /api/preferences/models）
 * @param {object} standbyPatch 降级时写的 patch（可能包 models 层）{ models: { utility: "provider/id" } } 或 { utility: "provider/id" }
 * @returns {boolean} true=当前还是备用配置（没人动过）；false=被手动改过
 */
export function isStandbyConfig(current, standbyPatch) {
  if (!current || !standbyPatch) return false;
  // 兼容两种 patch 形态：包 models 层或不包
  const sp = standbyPatch.models && typeof standbyPatch.models === "object" ? standbyPatch.models : standbyPatch;
  // 降级只切了有备用配置的槽位，逐个比对
  for (const key of ["utility", "utility_large", "vision"]) {
    if (!Object.prototype.hasOwnProperty.call(sp, key)) continue; // 该槽没降级，不比较
    const expected = sp[key]; // "provider/id" 字符串
    const actual = current[key]; // {id, provider} 对象 或 "provider/id"
    if (expected == null) continue;
    if (!refSame(actual, expected)) return false; // 被手动改过
  }
  return true;
}

/**
 * 判断一个模型引用（对象或字符串）与期望的 "provider/id" 字符串是否同一模型。
 * Hana 模型引用格式混乱：provider 可含子路径（command code/deepseek），id 可带组织前缀（deepseek/deepseek-v4-flash）。
 * 所以比较时取 provider 尾段开头 + id 尾段结尾，中间允许任意（组织/子路径差异不敏感）。
 */
function refSame(actual, expected) {
  if (typeof actual === "string") return actual === expected;
  if (!actual || !actual.provider || !actual.id) return false;
  const pTail = String(actual.provider).split("/").pop().toLowerCase();
  const idTail = String(actual.id).split("/").pop().toLowerCase();
  const exp = expected.toLowerCase();
  const expTail = exp.split("/").pop(); // 期望的 id 尾段
  const expHead = exp.split("/")[0]; // 期望的 provider 首段
  // id 尾段必须一致，provider 首段或任意段包含当前 provider 尾段即可
  return idTail === expTail && (expHead === pTail || exp.includes("/" + pTail + "/") || exp.endsWith("/" + pTail));
}

// ── 日志轮询（有状态 I/O，但读逻辑可测） ──

/**
 * 日志尾随读取器：记住上次读的位置，只读新增行。
 */
export class LogTail {
  constructor({ logsDir }) {
    this.logsDir = logsDir;
    this._lastFile = null;
    this._lastOffset = 0;
  }

  _latestFile() {
    if (!this.logsDir) return null;
    let entries;
    try {
      entries = fs.readdirSync(this.logsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".log") && e.name.startsWith("20"))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(this.logsDir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  }

  /** 读取自上次以来的新增行（注意：跨文件切换时从头读新文件） */
  readNewLines() {
    const file = this._latestFile();
    if (!file) return [];
    if (this._lastFile !== file.name) {
      this._lastFile = file.name;
      this._lastOffset = 0;
    }
    const p = path.join(this.logsDir, file.name);
    let size;
    try {
      size = fs.statSync(p).size;
    } catch {
      return [];
    }
    if (size < this._lastOffset) {
      // 文件被截断/轮转 → 重置
      this._lastOffset = 0;
    }
    if (size === this._lastOffset) return [];
    let buf;
    try {
      const fd = fs.openSync(p, "r");
      try {
        buf = Buffer.alloc(size - this._lastOffset);
        fs.readSync(fd, buf, 0, buf.length, this._lastOffset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
    this._lastOffset = size;
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/);
    // 最后一行可能不完整（没有换行符结尾），回退 offset 留到下一轮
    if (text.length > 0 && !text.endsWith("\n") && lines.length > 0) {
      this._lastOffset -= Buffer.byteLength(lines.pop() || "", "utf-8");
    }
    return lines.filter(Boolean);
  }
}

// ── 消耗量监测 ──

/**
 * 从 usage-ledger.json 解析消耗统计。
 * @param {object} ledger usage-ledger.json 的 parsed JSON
 * @param {object} opts { sinceMs, agentId, subsystem }
 * @returns {object} { requests, totalTokens, inputTokens, outputTokens, cacheReadTokens, failed, byModel }
 */
export function summarizeUsage(ledger, opts = {}) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const since = opts.sinceMs || 0;
  const agentId = opts.agentId || null;
  const subsystem = opts.subsystem || null;
  const out = {
    requests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    failed: 0,
    byModel: {},
  };
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (since && (!e.startedAt || Date.parse(e.startedAt) < since)) continue;
    if (agentId && e.attribution?.agentId !== agentId) continue;
    if (subsystem && e.source?.subsystem !== subsystem) continue;
    const usage = e.usage || {};
    const input = usage.input?.totalTokens || 0;
    const output = usage.output?.totalTokens || 0;
    const cacheRead = usage.cache?.readTokens || 0;
    const total = usage.totalTokens || (input + output + cacheRead);
    out.requests += 1;
    out.totalTokens += total;
    out.inputTokens += input;
    out.outputTokens += output;
    out.cacheReadTokens += cacheRead;
    if (e.status && e.status !== "ok") out.failed += 1;
    const modelKey = e.model ? `${e.model.provider || "?"}/${e.model.modelId || "?"}` : "unknown";
    if (!out.byModel[modelKey]) out.byModel[modelKey] = { requests: 0, totalTokens: 0 };
    out.byModel[modelKey].requests += 1;
    out.byModel[modelKey].totalTokens += total;
  }
  return out;
}

/** 读取并解析 usage-ledger.json（读不到返回 null，不抛） */
export function readUsageLedger(ledgerPath) {
  try {
    const raw = fs.readFileSync(ledgerPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

