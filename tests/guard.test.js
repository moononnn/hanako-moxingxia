// FailwatchGuard 集成测试（依赖注入，不真跑定时器）

import { test } from "node:test";
import assert from "node:assert/strict";

import { FailwatchGuard } from "../lib/failwatch-guard.js";

function makeGuard(overrides = {}) {
  let store = {
    failwatch: {
      backup: { utility: "command code/deepseek/deepseek-v4-flash" },
      degraded: true,
      degradedAt: Date.now() - 1000,
    },
  };
  const deps = {
    readLogLines: () => [],
    discoverServer: () => ({ port: 1, token: "x" }),
    apiFetch: async () => ({ ok: true }),
    readStore: () => store,
    writeStore: (_, s) => { store = s; },
    dataDir: () => "/tmp/data",
    backup: store.failwatch.backup,
    getBackupThinkingLevel: async () => "max",
    ...overrides,
  };
  const guard = new FailwatchGuard(deps);
  return { guard, getStore: () => store };
}

/** 模拟降级前的状态：非降级态 + 有备用 */
function makeFreshGuard(overrides = {}) {
  let store = {
    failwatch: {
      backup: { utility: "command code/deepseek/deepseek-v4-flash" },
    },
  };
  const deps = {
    readLogLines: () => [],
    discoverServer: () => ({ port: 1, token: "x" }),
    apiFetch: async () => ({ ok: true }),
    readStore: () => store,
    writeStore: (_, s) => { store = s; },
    dataDir: () => "/tmp/data",
    backup: store.failwatch.backup,
    getBackupThinkingLevel: async () => "max",
    getMainThinkingLevel: async () => null, // 默认保守不兼容
    ...overrides,
  };
  const guard = new FailwatchGuard(deps);
  return { guard, getStore: () => store };
}

test("降级态 + empty 失败 + 深度思考备胎 → thinking-capped，不累计 standbyFailures", async () => {
  const { guard, getStore } = makeGuard();
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: 模型未回复正文，请检查思考内容或稍后重试。"];

  const r = await guard.tick(lines);
  assert.equal(r.action, "standby-thinking-capped");
  assert.equal(r.capped, true);

  const fw = getStore().failwatch;
  assert.equal(fw.thinkingCapped, 1);
  assert.equal(fw.standbyFailures, undefined); // 没累计
  assert.equal(fw.degraded, true); // 继续降级态
});

test("降级态 + quota 失败（真坏）→ 正常累计 standbyFailures", async () => {
  const { guard, getStore } = makeGuard();
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: Monthly usage limit reached."];

  const r = await guard.tick(lines);
  assert.equal(r.action, "standby-degrading");
  assert.equal(r.reason, "standby-pending");

  const fw = getStore().failwatch;
  assert.equal(fw.standbyFailures, 1); // 累计了
  assert.equal(fw.thinkingCapped, undefined); // 没记 capped
});

test("降级态 + 连续两次真坏 → 停止降级", async () => {
  const { guard, getStore } = makeGuard();
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: Monthly usage limit reached."];

  await guard.tick(lines); // 第一次：standbyFailures=1
  const r2 = await guard.tick(lines); // 第二次：触发停止
  assert.equal(r2.action, "standby-failed-stop");
  const fw = getStore().failwatch;
  assert.equal(fw.standbyFailed, true);
  assert.equal(fw.degraded, false);
});

test("备胎思考档位读不到 → 保守走原判定（empty 也累计）", async () => {
  const { guard, getStore } = makeGuard({
    getBackupThinkingLevel: async () => null,
  });
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: 模型未回复正文，请检查思考内容或稍后重试。"];

  const r = await guard.tick(lines);
  assert.equal(r.action, "standby-degrading"); // 走原 standby 逻辑
  const fw = getStore().failwatch;
  assert.equal(fw.standbyFailures, 1);
});

// ── 快照-恢复制（2026-09-01 产品决策）──

test("降级触发时：读当前配置存快照 + 写备用模型", async () => {
  const putBodies = [];
  const { guard, getStore } = makeFreshGuard({
    apiFetch: async (server, pathname, init) => {
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(init.body));
        return { ok: true };
      }
      // GET /api/preferences/models → 返回当前配置
      return {
        ok: true,
        body: {
          models: {
            utility: { id: "gpt-5.6-luna", provider: "openai-codex" },
            vision: { id: "mimo-v2.5", provider: "opencode-go" },
          },
        },
      };
    },
  });
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: Monthly usage limit reached."];

  await guard.tick(lines); // 第一次：consecutiveFailures=1
  const r = await guard.tick(lines); // 第二次：触发降级
  assert.equal(r.action, "degraded");

  const fw = getStore().failwatch;
  // 快照存了用户原配置
  assert.deepEqual(fw.snapshot, {
    utility: { id: "gpt-5.6-luna", provider: "openai-codex" },
    vision: { id: "mimo-v2.5", provider: "opencode-go" },
  });
  // 降级 patch 写备用
  assert.deepEqual(putBodies[0], {
    models: { utility: "command code/deepseek/deepseek-v4-flash" },
  });
});

test("降级已触发过（有快照）→ 不重复快照覆盖", async () => {
  const { guard, getStore } = makeGuard({
    // 已有快照 + 已降级
    readStore: () => ({
      failwatch: {
        backup: { utility: "command code/deepseek/deepseek-v4-flash" },
        degraded: false,
        snapshot: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } },
      },
    }),
    apiFetch: async (server, pathname, init) => {
      if (init?.method === "PUT") return { ok: true };
      // 万一又读了，返回不同的值，验证不被覆盖
      return { ok: true, body: { models: { utility: { id: "SOMETHING-ELSE", provider: "x" } } } };
    },
  });
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: Monthly usage limit reached."];

  await guard.tick(lines); // 第一次：累计 1
  await guard.tick(lines); // 第二次：触发降级
  const fw = getStore().failwatch;
  assert.deepEqual(fw.snapshot, { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } }); // 未被覆盖
});

test("恢复时：写回快照原值（而不是清空）", async () => {
  const putBodies = [];
  const { guard, getStore } = makeGuard({
    readStore: () => ({
      failwatch: {
        backup: { utility: "command code/deepseek/deepseek-v4-flash" },
        degraded: true,
        degradedAt: Date.now() - 6 * 60 * 1000, // 坚持期满
        lastDegradePatch: { models: { utility: "command code/deepseek/deepseek-v4-flash" } },
        snapshot: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } },
      },
    }),
    apiFetch: async (server, pathname, init) => {
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(init.body));
        return { ok: true };
      }
      return { ok: true, body: { models: {} } };
    },
  });

  const r = await guard.maybeRestore();
  assert.equal(r.action, "restored");
  // 写回快照原值，不是 null
  assert.deepEqual(putBodies[0], {
    models: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } },
  });
  // 恢复后快照被清掉
  const fw = getStore().failwatch;
  assert.equal(fw.degraded, false);
  assert.equal(fw.snapshot, undefined);
});

test("手动接管：降级态期间用户改了配置 → 恢复时不覆盖，退出降级", async () => {
  const putBodies = [];
  const { guard, getStore } = makeGuard({
    readStore: () => ({
      failwatch: {
        backup: { utility: "command code/deepseek/deepseek-v4-flash" },
        degraded: true,
        degradedAt: Date.now() - 6 * 60 * 1000, // 坚持期满
        lastDegradePatch: { models: { utility: "command code/deepseek/deepseek-v4-flash" } },
        snapshot: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } },
      },
    }),
    apiFetch: async (server, pathname, init) => {
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(init.body));
        return { ok: true };
      }
      // 用户已经手动把 utility 改成别的模型（不是降级的备用，也不是快照原值）
      return { ok: true, body: { models: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" }, vision: { id: "mimo-v2.5", provider: "opencode-go" } } } };
    },
  });

  const r = await guard.maybeRestore();
  assert.equal(r.action, "manual-takeover");
  assert.equal(putBodies.length, 0); // 没写任何配置
  const fw = getStore().failwatch;
  assert.equal(fw.degraded, false); // 退出降级态
  assert.equal(fw.manualTakenOver, true); // 标记手动接管
  assert.equal(fw.snapshot, undefined); // 快照已清
});

test("手动接管：降级态期间用户改配置后又有失败 → 不再自动降级覆盖", async () => {
  const putBodies = [];
  const { guard, getStore } = makeFreshGuard({
    readStore: () => ({
      failwatch: {
        backup: { utility: "command code/deepseek/deepseek-v4-flash" },
        // 降级态残留 + 快照（上次降级存的）
        degraded: true,
        degradedAt: Date.now() - 10 * 1000,
        snapshot: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } },
        lastDegradePatch: { models: { utility: "command code/deepseek/deepseek-v4-flash" } },
      },
    }),
    apiFetch: async (server, pathname, init) => {
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(init.body));
        return { ok: true };
      }
      // 用户手动把 utility 改成了别的模型（既不是备用也不是快照原值）
      return { ok: true, body: { models: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" } } } };
    },
  });
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: Monthly usage limit reached."];

  const r = await guard.tick(lines); // 失败 → 但用户已手动改配置 → 手动接管，不再降级
  assert.equal(r.action, "manual-takeover");
  assert.equal(putBodies.length, 0); // 没写任何配置
  const fw = getStore().failwatch;
  assert.equal(fw.degraded, false);
  assert.equal(fw.manualTakenOver, true);
});

test("vision 失败 1 次 → guard 触发降级（vision 低频单次调用）", async () => {
  const { guard, getStore } = makeFreshGuard({
    apiFetch: async (server, pathname, init) => {
      if (init?.method === "PUT") return { ok: true };
      // GET /api/preferences/models → 返回当前配置（供快照）
      return { ok: true, body: { models: { utility: { id: "gpt-5.6-luna", provider: "openai-codex" }, vision: { id: "mimo-v2.5", provider: "opencode-go" } } } };
    },
  });
  const lines = ['[WARN] [session] vision context injection diagnostic: {"code":"VISION_CONTEXT_INJECTION_FAILED","message":"vision auxiliary model is required for image input with the current text-only model"}'];

  const r = await guard.tick(lines); // 1 次 vision 失败就触发
  assert.equal(r.action, "degraded");
  assert.equal(r.reason, "vision-threshold");
  const fw = getStore().failwatch;
  assert.equal(fw.degraded, true);
  assert.deepEqual(fw.snapshot, { utility: { id: "gpt-5.6-luna", provider: "openai-codex" }, vision: { id: "mimo-v2.5", provider: "opencode-go" } }); // 快照存了
});

test("多条失败一次 tick 逐条累计（3 条 → 一次触发降级，不卡 1 次）", async () => {
  const { guard, getStore } = makeFreshGuard();
  const lines = [
    "[ERROR] [memory-ticker] 滚动摘要 (a.jsonl) 失败: Monthly usage limit reached.",
    "[ERROR] [memory-ticker] 滚动摘要 (b.jsonl) 失败: Monthly usage limit reached.",
    "[ERROR] [memory-ticker] 滚动摘要 (c.jsonl) 失败: Monthly usage limit reached.",
  ];
  const r = await guard.tick(lines); // 3 条 → 一次 tick 就累计 3 → 触发降级
  assert.equal(r.action, "degraded");
  const fw = getStore().failwatch;
  assert.equal(fw.degraded, true);
});

test("recovered 恢复行不算失败（排除误报）", async () => {
  const { guard, getStore } = makeFreshGuard();
  const lines = [
    "[INFO] [memory-ticker] 滚动摘要 恢复正常（之前: 滚动摘要 (x.jsonl)|Monthly usage limit reached）",
    "[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: 模型未回复正文，请检查思考内容或稍后重试。",
  ];
  const r = await guard.tick(lines); // recovered 不算，只有 1 条真失败
  assert.equal(r.action, "pending"); // 未到阈值
  const fw = getStore().failwatch;
  assert.equal(fw.consecutiveFailures, 1); // 只累计 1
});

test("主模型 thinking-capped：空响应 + 主模型深度思考 → 不降级，记 capped", async () => {
  const { guard, getStore } = makeFreshGuard({
    getMainThinkingLevel: async () => "max", // 主模型是深度思考型（如 command code）
  });
  const lines = [
    "[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: 模型未回复正文，请检查思考内容或稍后重试。",
    "[ERROR] [memory-ticker] 滚动摘要 (y.jsonl) 失败: 模型未回复正文，请检查思考内容或稍后重试。",
  ];
  const r = await guard.tick(lines); // 2 条空响应 + 主模型深度思考 → 全部归因 thinking-capped
  assert.equal(r.action, "main-thinking-capped");
  const fw = getStore().failwatch;
  assert.ok(!fw.degraded, "不应进入降级态"); // 不降级
  assert.equal(fw.thinkingCapped, 1); // 记了一次 capped
  assert.equal(fw.consecutiveFailures ?? 0, 0); // 没累计失败
});

test("主模型非深度思考：空响应仍按真失败累计（不误赦免）", async () => {
  const { guard, getStore } = makeFreshGuard({
    getMainThinkingLevel: async () => "low", // 主模型非深度思考
  });
  const lines = ["[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: 模型未回复正文，请检查思考内容或稍后重试。"];
  await guard.tick(lines); // 第一次：累计 1
  const r2 = await guard.tick(lines); // 第二次：触发降级
  assert.equal(r2.action, "degraded");
  const fw = getStore().failwatch;
  assert.equal(fw.degraded, true);
});
