// failwatch 核心逻辑测试（node:test，零依赖）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseFailureSignal,
  collectFailures,
  decideDegrade,
  decideRestore,
  decideNotify,
  decideStandbyFailure,
  buildDegradePatch,
  buildRestorePatch,
  isStandbyConfig,
  summarizeUsage,
  isDeepThinkingModel,
  isThinkingCappedFailure,
} from "../lib/failwatch.js";

// ── parseFailureSignal ──

test("识别空响应失败（记忆编译）", () => {
  const sig = parseFailureSignal("[16:13:15.311] [ERROR] [memory-ticker] 滚动摘要 ... 失败: 模型未回复正文，请检查思考内容或稍后重试。");
  assert.ok(sig);
  assert.equal(sig.kind, "empty");
});

test("识别 compileFacts 失败（大工具模型）", () => {
  const sig = parseFailureSignal("[16:13:53.197] [ERROR] [memory-ticker] compileFacts 失败: 模型未回复正文，请检查思考内容或稍后重试。");
  assert.ok(sig);
  assert.equal(sig.kind, "empty");
});

test("识别 utility 调用空响应", () => {
  const sig = parseFailureSignal("[ERROR] [llm] LLM_EMPTY_RESPONSE utility call failed");
  assert.ok(sig);
  assert.equal(sig.kind, "empty");
});

test("识别超时", () => {
  const sig = parseFailureSignal("[ERROR] [llm] LLM_TIMEOUT after 60000ms (utility)");
  assert.ok(sig);
  assert.equal(sig.kind, "timeout");
});

test("识别认证失败", () => {
  const sig = parseFailureSignal("[ERROR] [llm] LLM_AUTH_FAILED provider key invalid");
  assert.ok(sig);
  assert.equal(sig.kind, "auth");
});

test("识别限流", () => {
  const sig = parseFailureSignal("[ERROR] [llm] LLM_RATE_LIMITED 429");
  assert.ok(sig);
  assert.equal(sig.kind, "rate");
});

test("识别额度用尽（没充值最常见）", () => {
  const sig = parseFailureSignal("[21:49:42.768] [ERROR] [memory-ticker] 滚动摘要 (2026-08-31T13-36-45-465Z_01a05809-6399-7af2-ab34-861ab580360b.jsonl) 失败: Monthly usage limit reached. Resets in 17 days.");
  assert.ok(sig);
  assert.equal(sig.kind, "quota");
});

test("识别额度用尽（memory 双通道）", () => {
  const sig = parseFailureSignal("[21:49:42.768] [ERROR] [memory] 滚动摘要 (xxx.jsonl) failed: Monthly usage limit reached. Resets in 17 days.");
  assert.ok(sig);
  assert.equal(sig.kind, "quota");
});

test("识别网络层失败（fetch failed，带工具上下文）", () => {
  const sig = parseFailureSignal("[21:37:10.985] [ERROR] [llm-utils] summarizeTitle failed: fetch failed — caused by: Client network socket disconnected before secure TLS connection was established [ECONNRESET]");
  assert.ok(sig);
  assert.equal(sig.kind, "network");
});

test("识别网络层失败（memory 滚动摘要 fetch failed）", () => {
  const sig = parseFailureSignal("[21:23:59.784] [ERROR] [memory-ticker] 滚动摘要 (2026-08-31T01-37-27-131Z_01a05576-d85b-704a-99b0-5a935a4a7dd4.jsonl) 失败: fetch failed");
  assert.ok(sig);
  assert.equal(sig.kind, "network");
});

test("网络层失败但上下文是 session/reply（主对话）→ 不算", () => {
  const sig = parseFailureSignal("[21:40:00.000] [ERROR] [session] reply failed: fetch failed");
  assert.equal(sig, null);
});

test("网络层失败但上下文是 session/reply（主对话）→ 不算", () => {
  const sig = parseFailureSignal("[ERROR] [session] chat: ECONNRESET");
  assert.equal(sig, null);
});

test("主对话失败不算（scope 排除）", () => {
  // 空响应但上下文是 session/reply（主对话模型），不是工具模型
  const sig = parseFailureSignal("[ERROR] [session] reply failed: 模型未回复正文");
  assert.equal(sig, null);
});

test("普通业务日志不算", () => {
  const sig = parseFailureSignal("[INFO] [server] started, 22 models found");
  assert.equal(sig, null);
});

test("非字符串返回 null", () => {
  assert.equal(parseFailureSignal(null), null);
  assert.equal(parseFailureSignal(""), null);
});

// ── collectFailures ──

test("collectFailures 收集带时间戳", () => {
  const now = 1000;
  const out = collectFailures([
    "[ERROR] [memory] compileFacts 失败: 模型未回复正文",
    "[INFO] 普通行",
    "[ERROR] [llm] LLM_TIMEOUT utility",
  ], now);
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.at === now));
});

// ── decideDegrade ──

test("一次失败不触发（未达阈值）", () => {
  const r = decideDegrade({}, { threshold: 2 });
  assert.equal(r.shouldDegrade, false);
  assert.equal(r.nextState.consecutiveFailures, 1);
  assert.equal(r.reason, "pending");
});

test("连续两次失败触发降级", () => {
  let state = {};
  const r1 = decideDegrade(state, { threshold: 2 });
  const r2 = decideDegrade(r1.nextState, { threshold: 2 });
  assert.equal(r2.shouldDegrade, true);
  assert.equal(r2.nextState.degraded, true);
  assert.ok(r2.nextState.degradedAt);
});

test("已降级不重复触发（一次性语义）", () => {
  const r = decideDegrade({ degraded: true, degradedAt: Date.now() }, { threshold: 2 });
  assert.equal(r.shouldDegrade, false);
  assert.equal(r.reason, "already-degraded");
});

test("窗口过期重置计数", () => {
  // 第一次失败在 10 分钟前（超过 5 分钟窗口）
  const stale = { consecutiveFailures: 1, lastFailureAt: Date.now() - 10 * 60 * 1000 };
  const r = decideDegrade(stale, { threshold: 2, windowMs: 5 * 60 * 1000 });
  // 旧计数被清零，本次算第 1 次，未触发
  assert.equal(r.shouldDegrade, false);
  assert.equal(r.nextState.consecutiveFailures, 1);
});

test("降级态不触发（等坚持期满切回试探）", () => {
  const recent = { degraded: true, degradedAt: Date.now() - 60 * 1000 };
  const r = decideDegrade(recent, { threshold: 2 });
  assert.equal(r.shouldDegrade, false);
  assert.equal(r.reason, "already-degraded");
});

test("降级轮次计数递增", () => {
  let state = {};
  const r1 = decideDegrade(state, { threshold: 2 });
  const r2 = decideDegrade(r1.nextState, { threshold: 2 });
  assert.equal(r2.shouldDegrade, true);
  assert.equal(r2.nextState.cycles, 1);
  // 恢复后再次触发 → 第二轮
  const r3 = decideDegrade({ ...r2.nextState, degraded: false, degradedAt: null }, { threshold: 2 });
  const r4 = decideDegrade(r3.nextState, { threshold: 2 });
  assert.equal(r4.shouldDegrade, true);
  assert.equal(r4.nextState.cycles, 2);
});

// ── buildDegradePatch / buildRestorePatch ──

test("降级 patch 只含已配置的槽位", () => {
  const patch = buildDegradePatch({ utility: "a/b", vision: "c/d" });
  assert.deepEqual(patch, { models: { utility: "a/b", vision: "c/d" } });
});

test("降级 patch 空配置返回空对象", () => {
  assert.deepEqual(buildDegradePatch({}), { models: {} });
  assert.deepEqual(buildDegradePatch(null), { models: {} });
});

test("降级 patch：backup 无 vision 时只切大小工具（识图不兜底，2026-09-01 拍板）", () => {
  const patch = buildDegradePatch({ utility: "command code/deepseek/deepseek-v4-flash", utility_large: "command code/deepseek/deepseek-v4-flash" });
  assert.deepEqual(patch, {
    models: {
      utility: "command code/deepseek/deepseek-v4-flash",
      utility_large: "command code/deepseek/deepseek-v4-flash",
    },
  });
  assert.equal(patch.models.vision, undefined); // 不切 vision
});

test("恢复 patch 清空已配置的槽位（null 回退 chat）", () => {
  const patch = buildRestorePatch({ utility: "a/b", utility_large: "x/y", vision: "c/d" });
  assert.deepEqual(patch, { models: { utility: null, utility_large: null, vision: null } });
});

test("恢复 patch 兼容已包 models 层的降级 patch", () => {
  const patch = buildRestorePatch({ models: { utility: "a/b", vision: "c/d" } });
  assert.deepEqual(patch, { models: { utility: null, vision: null } });
});

// ── 快照-恢复制（2026-09-01 产品决策）──

test("恢复 patch 有快照时写回原值（对象格式原样保留）", () => {
  const snapshot = {
    utility: { id: "gpt-5.6-luna", provider: "openai-codex" },
    utility_large: null,
    vision: { id: "mimo-v2.5", provider: "opencode-go" },
  };
  const patch = buildRestorePatch({ models: { utility: "backup/x", utility_large: "backup/y", vision: "backup/z" } }, snapshot);
  assert.deepEqual(patch, {
    models: {
      utility: { id: "gpt-5.6-luna", provider: "openai-codex" },
      utility_large: null,
      vision: { id: "mimo-v2.5", provider: "opencode-go" },
    },
  });
});

test("恢复 patch 有快照时写回原值（字符串格式原样保留）", () => {
  const snapshot = { utility: "deepseek/deepseek-v4-flash" };
  const patch = buildRestorePatch({ models: { utility: "backup/x" } }, snapshot);
  assert.deepEqual(patch, { models: { utility: "deepseek/deepseek-v4-flash" } });
});

test("恢复 patch 快照里没有的槽位（旧数据）→ 清空", () => {
  const snapshot = { utility: "a/b" };
  const patch = buildRestorePatch({ models: { utility: "backup/x", vision: "backup/z" } }, snapshot);
  assert.deepEqual(patch, { models: { utility: "a/b", vision: null } });
});

test("恢复 patch 快照为 null → 清空（原本没配）", () => {
  const snapshot = { utility: null };
  const patch = buildRestorePatch({ models: { utility: "backup/x" } }, snapshot);
  assert.deepEqual(patch, { models: { utility: null } });
});

test("恢复 patch：降级没动过的槽位（vision）不写回，保持用户当前选择", () => {
  // 识图不兜底（2026-09-01 产品决策）：降级只切 utility/utility_large，patch 里没有 vision。
  // 即使快照里有 vision，恢复时也不该覆盖用户手动改过的 vision。
  const snapshot = {
    utility: { id: "gpt-5.6-luna", provider: "openai-codex" },
    vision: { id: "mimo-v2.5", provider: "opencode-go" },
  };
  const patch = buildRestorePatch({ models: { utility: "command code/deepseek/deepseek-v4-flash" } }, snapshot);
  assert.deepEqual(patch, { models: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } } });
  assert.equal(patch.models.vision, undefined); // 不动 vision
});

// ── vision 失败 1 次阈值（2026-09-01 产品决策）──

test("vision 失败 1 次 → 触发降级（低频单次调用）", () => {
  const r = decideDegrade({}, { failureKind: "vision", visionThreshold: 1 });
  assert.equal(r.shouldDegrade, true);
  assert.equal(r.reason, "vision-threshold");
  assert.equal(r.nextState.degraded, true);
  assert.equal(r.nextState.visionFailures, 0); // 触发后清零
});

test("vision 失败与 utility 计数独立（vision 触发前不累加 utility 计数）", () => {
  // 先来一次 utility 失败（计数 1）
  const r1 = decideDegrade({}, {});
  assert.equal(r1.nextState.consecutiveFailures, 1);
  // vision 失败 1 次触发降级（降级态统一清零计数）
  const r2 = decideDegrade(r1.nextState, { failureKind: "vision" });
  assert.equal(r2.shouldDegrade, true);
  assert.equal(r2.reason, "vision-threshold");
  // vision 失败本身不累加 utility 计数（触发前 r1 后是 1，触发后清零）
  assert.equal(r2.nextState.consecutiveFailures, 0);
});

test("vision 失败但没到 1 次（visionThreshold=2 时）→ 不触发", () => {
  const r = decideDegrade({}, { failureKind: "vision", visionThreshold: 2 });
  assert.equal(r.shouldDegrade, false);
  assert.equal(r.reason, "vision-pending");
  assert.equal(r.nextState.visionFailures, 1);
});

test("utility 失败仍走 2 次阈值（不受 vision 改动影响）", () => {
  const r1 = decideDegrade({}, {});
  assert.equal(r1.shouldDegrade, false);
  const r2 = decideDegrade(r1.nextState, {});
  assert.equal(r2.shouldDegrade, true);
  assert.equal(r2.reason, "threshold");
});

test("parseFailureSignal 识别 VISION_CONTEXT_INJECTION_FAILED", () => {
  const sig = parseFailureSignal('[WARN] [session] vision context injection diagnostic: {"code":"VISION_CONTEXT_INJECTION_FAILED","message":"vision auxiliary model is required for image input with the current text-only model"}');
  assert.ok(sig);
  assert.equal(sig.kind, "vision");
});

test("parseFailureSignal 识别 vision 额度失败（Monthly usage limit + vision 上下文）", () => {
  // 额度用尽本质是 quota；但 vision 上下文让它也能进入降级判定（scope 含 vision）
  const sig = parseFailureSignal('[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: Monthly usage limit reached. vision auxiliary model');
  assert.ok(sig);
  assert.equal(sig.kind, "quota"); // 命中 quota marker（在 vision 前）
});

test("parseFailureSignal：纯 vision 失败（无额度字样）识别为 vision", () => {
  const sig = parseFailureSignal('[WARN] [session] vision context injection diagnostic: {"code":"VISION_CONTEXT_INJECTION_FAILED","message":"vision auxiliary model must support image input"}');
  assert.ok(sig);
  assert.equal(sig.kind, "vision");
});

// ── decideRestore ──

test("降级态 + 坚持期满 → 切回试探（不再需要探测通过）", () => {
  const state = { degraded: true, degradedAt: Date.now() - 6 * 60 * 1000 };
  const r = decideRestore(true, state, { holdMs: 5 * 60 * 1000 });
  assert.equal(r.shouldRestore, true);
  assert.equal(r.nextState.degraded, false);
});

test("降级态 + 坚持期满 + 探测失败 → 仍然切回（用真实调用当试金石）", () => {
  const state = { degraded: true, degradedAt: Date.now() - 6 * 60 * 1000 };
  const r = decideRestore(false, state, { holdMs: 5 * 60 * 1000 });
  assert.equal(r.shouldRestore, true);
});

test("快速失败切换：默认 60 秒顶班后切回主模型", () => {
  // 备用刚顶上 10 秒 → 不切回
  const fresh = { degraded: true, degradedAt: Date.now() - 10 * 1000 };
  const r1 = decideRestore(true, fresh);
  assert.equal(r1.shouldRestore, false);
  // 备用顶上 61 秒 → 切回（默认 holdMs=60s）
  const old = { degraded: true, degradedAt: Date.now() - 61 * 1000 };
  const r2 = decideRestore(true, old);
  assert.equal(r2.shouldRestore, true);
  assert.equal(r2.nextState.degraded, false);
});

test("降级态但坚持期未满 → 不切回", () => {
  const state = { degraded: true, degradedAt: Date.now() - 60 * 1000 };
  const r = decideRestore(true, state, { holdMs: 5 * 60 * 1000 });
  assert.equal(r.shouldRestore, false);
});

test("非降级态 → 不切回", () => {
  const r = decideRestore(true, {}, { holdMs: 5 * 60 * 1000 });
  assert.equal(r.shouldRestore, false);
});

// ── decideNotify ──

test("一轮未坏满两轮 → 不通知", () => {
  const r = decideNotify({ cycles: 1 }, { notifyAfterCycles: 2 });
  assert.equal(r.shouldNotify, false);
});

test("连续两轮都坏 → 触发通知", () => {
  const r = decideNotify({ cycles: 2 }, { notifyAfterCycles: 2 });
  assert.equal(r.shouldNotify, true);
  assert.equal(r.nextState.notifiedCycles, 2);
});

test("已通知过同轮次 → 不重复通知", () => {
  const r = decideNotify({ cycles: 2, notifiedCycles: 2 }, { notifyAfterCycles: 2 });
  assert.equal(r.shouldNotify, false);
});

test("三轮都坏 → 每轮都通知（3 轮通知 3 次）", () => {
  const r1 = decideNotify({ cycles: 2, notifiedCycles: 0 }, { notifyAfterCycles: 2 });
  assert.equal(r1.shouldNotify, true);
  assert.equal(r1.nextState.notifiedCycles, 2);
  const r2 = decideNotify({ cycles: 3, notifiedCycles: 2 }, { notifyAfterCycles: 2 });
  assert.equal(r2.shouldNotify, true);
  assert.equal(r2.nextState.notifiedCycles, 3);
  const r3 = decideNotify({ cycles: 3, notifiedCycles: 3 }, { notifyAfterCycles: 2 });
  assert.equal(r3.shouldNotify, false);
});

// ── decideStandbyFailure ──

test("非降级态 → 备用兜底不触发", () => {
  const r = decideStandbyFailure({ degraded: false }, { standbyThreshold: 2 });
  assert.equal(r.shouldStop, false);
});

test("降级态第一次失败 → 计数，不停止", () => {
  const r = decideStandbyFailure({ degraded: true }, { standbyThreshold: 2 });
  assert.equal(r.shouldStop, false);
  assert.equal(r.nextState.standbyFailures, 1);
});

test("降级态连续两次失败 → 停止降级循环", () => {
  const r1 = decideStandbyFailure({ degraded: true }, { standbyThreshold: 2 });
  const r2 = decideStandbyFailure(r1.nextState, { standbyThreshold: 2 });
  assert.equal(r2.shouldStop, true);
  assert.equal(r2.nextState.standbyFailed, true);
  assert.equal(r2.nextState.degraded, false);
});

// ── summarizeUsage ──

function mkEntry({ startedAt, agentId, subsystem, status, input, output, cacheRead, provider, modelId }) {
  return {
    startedAt,
    status: status || "ok",
    source: { subsystem },
    attribution: { agentId },
    model: { provider, modelId },
    usage: {
      input: { totalTokens: input },
      output: { totalTokens: output },
      cache: { readTokens: cacheRead },
      totalTokens: input + output + cacheRead,
    },
  };
}

test("summarizeUsage 统计总量与按模型分组", () => {
  const ledger = { entries: [
    mkEntry({ startedAt: "2026-08-31T00:00:00Z", agentId: "hanako", subsystem: "utility", input: 100, output: 50, cacheRead: 30, provider: "deepseek", modelId: "deepseek-v4-flash" }),
    mkEntry({ startedAt: "2026-08-31T00:01:00Z", agentId: "hanako", subsystem: "utility", input: 200, output: 100, cacheRead: 60, provider: "deepseek", modelId: "deepseek-v4-flash" }),
    mkEntry({ startedAt: "2026-08-31T00:02:00Z", agentId: "yumi", subsystem: "utility", input: 10, output: 10, cacheRead: 0, provider: "minimax", modelId: "MiniMax-M3" }),
  ] };
  const r = summarizeUsage(ledger, { sinceMs: 0 });
  assert.equal(r.requests, 3);
  assert.equal(r.totalTokens, 100 + 50 + 30 + 200 + 100 + 60 + 10 + 10);
  assert.equal(r.inputTokens, 310);
  assert.equal(r.outputTokens, 160);
  assert.equal(r.cacheReadTokens, 90);
  assert.equal(r.byModel["deepseek/deepseek-v4-flash"].requests, 2);
  assert.equal(r.byModel["minimax/MiniMax-M3"].requests, 1);
});

test("summarizeUsage 按 agent 过滤", () => {
  const ledger = { entries: [
    mkEntry({ startedAt: "2026-08-31T00:00:00Z", agentId: "hanako", subsystem: "utility", input: 100, output: 0, cacheRead: 0, provider: "a", modelId: "m1" }),
    mkEntry({ startedAt: "2026-08-31T00:00:00Z", agentId: "yumi", subsystem: "utility", input: 999, output: 0, cacheRead: 0, provider: "a", modelId: "m1" }),
  ] };
  const r = summarizeUsage(ledger, { sinceMs: 0, agentId: "hanako" });
  assert.equal(r.requests, 1);
  assert.equal(r.totalTokens, 100);
});

test("summarizeUsage 按时间过滤 + 统计失败", () => {
  const ledger = { entries: [
    mkEntry({ startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), agentId: "hanako", subsystem: "utility", input: 100, output: 0, cacheRead: 0, provider: "a", modelId: "m1" }),
    mkEntry({ startedAt: new Date(Date.now() - 100 * 60 * 1000).toISOString(), agentId: "hanako", subsystem: "utility", input: 50, output: 0, cacheRead: 0, provider: "a", modelId: "m1", status: "error" }),
  ] };
  const since = Date.now() - 60 * 60 * 1000;
  const r = summarizeUsage(ledger, { sinceMs: since });
  assert.equal(r.requests, 1);
  assert.equal(r.failed, 0); // 旧条目被时间过滤掉
});

test("summarizeUsage 空输入返回零", () => {
  const r = summarizeUsage({ entries: [] }, { sinceMs: 0 });
  assert.equal(r.requests, 0);
  assert.equal(r.totalTokens, 0);
});

// ── 思考型备胎兼容（thinking-capped）──

test("isDeepThinkingModel：max/high/xhigh 算深度思考", () => {
  assert.equal(isDeepThinkingModel("max"), true);
  assert.equal(isDeepThinkingModel("high"), true);
  assert.equal(isDeepThinkingModel("xhigh"), true);
});

test("isDeepThinkingModel：medium/low/off 不算", () => {
  assert.equal(isDeepThinkingModel("medium"), false);
  assert.equal(isDeepThinkingModel("low"), false);
  assert.equal(isDeepThinkingModel("off"), false);
});

test("isDeepThinkingModel：空/缺失/未知返回 false", () => {
  assert.equal(isDeepThinkingModel(null), false);
  assert.equal(isDeepThinkingModel(""), false);
  assert.equal(isDeepThinkingModel(undefined), false);
  assert.equal(isDeepThinkingModel("weird"), false);
});

test("isThinkingCappedFailure：empty + 深度思考备胎 → true", () => {
  assert.equal(isThinkingCappedFailure({ kind: "empty" }, "max"), true);
  assert.equal(isThinkingCappedFailure({ kind: "empty" }, "high"), true);
});

test("isThinkingCappedFailure：empty + 非深度思考备胎 → false", () => {
  assert.equal(isThinkingCappedFailure({ kind: "empty" }, "medium"), false);
  assert.equal(isThinkingCappedFailure({ kind: "empty" }, null), false);
  assert.equal(isThinkingCappedFailure({ kind: "empty" }, "off"), false);
});

test("isThinkingCappedFailure：quota/network/auth 绝不放过", () => {
  // 真故障：即使备胎是深度思考型，也不算兼容，必须累计
  assert.equal(isThinkingCappedFailure({ kind: "quota" }, "max"), false);
  assert.equal(isThinkingCappedFailure({ kind: "network" }, "max"), false);
  assert.equal(isThinkingCappedFailure({ kind: "auth" }, "max"), false);
  assert.equal(isThinkingCappedFailure({ kind: "timeout" }, "max"), false);
  assert.equal(isThinkingCappedFailure({ kind: "rate" }, "max"), false);
});

test("isThinkingCappedFailure：非法入参返回 false", () => {
  assert.equal(isThinkingCappedFailure(null, "max"), false);
  assert.equal(isThinkingCappedFailure(undefined, "max"), false);
  assert.equal(isThinkingCappedFailure("empty", "max"), false);
});

// ── isStandbyConfig（手动接管检测）──

test("isStandbyConfig：当前配置 == 备用配置 → true（没人动）", () => {
  const current = { utility: { id: "deepseek-v4-flash", provider: "command code" } };
  const patch = { models: { utility: "command code/deepseek/deepseek-v4-flash" } };
  assert.equal(isStandbyConfig(current, patch), true);
});

test("isStandbyConfig：当前配置被手动改过 → false", () => {
  const current = { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } };
  const patch = { models: { utility: "command code/deepseek/deepseek-v4-flash" } };
  assert.equal(isStandbyConfig(current, patch), false);
});

test("isStandbyConfig：patch 未覆盖的槽位不比较", () => {
  const current = { utility: { id: "deepseek-v4-flash", provider: "command code" }, vision: { id: "mimo-v2.5", provider: "opencode-go" } };
  const patch = { models: { utility: "command code/deepseek/deepseek-v4-flash" } }; // 只降级了 utility
  assert.equal(isStandbyConfig(current, patch), true); // vision 不管
});

test("isStandbyConfig：字符串格式当前配置也兼容", () => {
  const current = { utility: "command code/deepseek/deepseek-v4-flash" };
  const patch = { models: { utility: "command code/deepseek/deepseek-v4-flash" } };
  assert.equal(isStandbyConfig(current, patch), true);
});

test("isStandbyConfig：非法入参返回 false", () => {
  assert.equal(isStandbyConfig(null, null), false);
  assert.equal(isStandbyConfig({}, null), false);
  assert.equal(isStandbyConfig(null, {}), false);
});
