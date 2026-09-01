// FailwatchGuard 集成测试（依赖注入，不真跑定时器）

import { test } from "node:test";
import assert from "node:assert/strict";

import { FailwatchGuard } from "../lib/failwatch-guard.js";

const MAIN = {
  utility: { provider: "main", id: "utility-main" },
  utility_large: { provider: "main", id: "large-main" },
  vision: { provider: "main", id: "vision-main" },
};
const BACKUP = {
  utility: "backup/utility-standby",
  utility_large: "backup/large-standby",
  vision: "backup/vision-standby",
};

function makeGuard({
  backup = BACKUP,
  current = MAIN,
  initialFailwatch = {},
  emptyFailwatch = false,
  mainLevels = {},
  backupLevels = {},
  sendNotify = true,
  putResult,
} = {}) {
  let store = {
    failwatch: emptyFailwatch ? null : {
      backup: { ...backup },
      ...initialFailwatch,
    },
  };
  const currentModels = structuredClone(current);
  const putBodies = [];
  const notifications = [];
  const apiCalls = [];

  const deps = {
    readLogLines: () => [],
    discoverServer: () => ({ port: 1, token: "x" }),
    apiFetch: async (server, pathname, init) => {
      apiCalls.push({ pathname, init });
      if (init?.method === "PUT") {
        const patch = JSON.parse(init.body);
        putBodies.push(patch);
        if (putResult) return putResult(patch);
        Object.assign(currentModels, patch.models || {});
        return { ok: true, status: 200 };
      }
      return { ok: true, body: { models: structuredClone(currentModels) } };
    },
    readStore: () => store,
    writeStore: (_, next) => { store = next; },
    dataDir: () => "/tmp/moxingxia-test",
    backup,
    policy: { threshold: 2, visionThreshold: 1, standbyThreshold: 2 },
    getMainThinkingLevel: async (slot) => mainLevels[slot] || null,
    getBackupThinkingLevel: async (_, slot) => backupLevels[slot] || null,
    sendNotify: sendNotify ? async (info) => { notifications.push(info); } : undefined,
  };
  const guard = new FailwatchGuard(deps);
  return {
    guard,
    getStore: () => store,
    currentModels,
    putBodies,
    notifications,
    apiCalls,
  };
}

const utilityTimeout = "[ERROR] [llm-utils] summarizeTitle failed: LLM_TIMEOUT utility";
const largeTimeout = "[ERROR] [memory-ticker] 滚动摘要 (x.jsonl) 失败: LLM_TIMEOUT";
const visionFailure = "[WARN] [session] vision context injection diagnostic: {\"code\":\"VISION_CONTEXT_INJECTION_FAILED\"}";

// ── 切换触发 ──

test("明确认证故障一次就切换小工具备用模型，并弹提个醒通知", async () => {
  const { guard, getStore, currentModels, putBodies, notifications } = makeGuard();
  const r = await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);

  assert.equal(r.action, "switched-to-backup");
  assert.equal(r.slot, "utility");
  assert.equal(currentModels.utility, BACKUP.utility);
  assert.deepEqual(putBodies, [{ models: { utility: BACKUP.utility } }]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /小工具模型/);
  assert.match(notifications[0].message, /认证或密钥失败/);
  assert.match(notifications[0].message, /backup\/utility-standby/);
  assert.equal(getStore().failwatch.slots.utility.mode, "backup");
});

test("临时超时第一次只累计，第二次才切换", async () => {
  const { guard, getStore, currentModels, putBodies } = makeGuard();
  const r1 = await guard.tick([utilityTimeout]);
  assert.equal(r1.action, "pending");
  assert.equal(getStore().failwatch.slots.utility.consecutiveFailures, 1);
  assert.equal(putBodies.length, 0);

  const r2 = await guard.tick([utilityTimeout]);
  assert.equal(r2.action, "switched-to-backup");
  assert.equal(currentModels.utility, BACKUP.utility);
  assert.equal(putBodies.length, 1);
});

test("识图失败一次就切识图备用模型，且只写 vision 槽", async () => {
  const { guard, getStore, currentModels, putBodies, notifications } = makeGuard();
  const r = await guard.tick([visionFailure]);

  assert.equal(r.action, "switched-to-backup");
  assert.equal(r.slot, "vision");
  assert.equal(currentModels.vision, BACKUP.vision);
  assert.deepEqual(putBodies, [{ models: { vision: BACKUP.vision } }]);
  assert.equal(getStore().failwatch.slots.utility.mode, "primary");
  assert.match(notifications[0].title, /识图模型/);
});

test("两个槽位可在同一轮独立切换，patch 不互相覆盖", async () => {
  const { guard, getStore, currentModels, putBodies } = makeGuard();
  const r = await guard.tick([
    "[ERROR] [llm] LLM_AUTH_FAILED utility",
    visionFailure,
  ]);

  assert.equal(r.action, "batch-switched");
  assert.equal(currentModels.utility, BACKUP.utility);
  assert.equal(currentModels.vision, BACKUP.vision);
  assert.equal(putBodies.length, 2);
  assert.deepEqual(putBodies.map((x) => x.models), [
    { utility: BACKUP.utility },
    { vision: BACKUP.vision },
  ]);
  assert.equal(getStore().failwatch.slots.utility.mode, "backup");
  assert.equal(getStore().failwatch.slots.vision.mode, "backup");
});

test("小工具和大工具分别计数、分别切换", async () => {
  const { guard, getStore, currentModels, putBodies } = makeGuard();

  const first = await guard.tick([utilityTimeout, largeTimeout]);
  assert.equal(first.action, "batch-processed");
  assert.equal(getStore().failwatch.slots.utility.consecutiveFailures, 1);
  assert.equal(getStore().failwatch.slots.utility_large.consecutiveFailures, 1);
  assert.equal(putBodies.length, 0);

  const second = await guard.tick([utilityTimeout]);
  assert.equal(second.action, "switched-to-backup");
  assert.equal(currentModels.utility, BACKUP.utility);
  assert.equal(currentModels.utility_large.provider, "main");
  assert.deepEqual(putBodies, [{ models: { utility: BACKUP.utility } }]);
});

test("同一轮多条同槽位失败只切一次，不把剩余旧日志当成备用失败", async () => {
  const { guard, getStore, putBodies } = makeGuard();
  const r = await guard.tick([utilityTimeout, utilityTimeout, utilityTimeout]);

  assert.equal(r.action, "switched-to-backup");
  assert.equal(putBodies.length, 1);
  assert.equal(getStore().failwatch.slots.utility.mode, "backup");
  assert.equal(getStore().failwatch.slots.utility.standbyFailures || 0, 0);
});

// ── 手动恢复与接管 ──

test("切换后保持备用，maybeRestore 不会自动切回", async () => {
  const { guard, currentModels, putBodies } = makeGuard();
  await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);
  const before = putBodies.length;

  const result = await guard.maybeRestore();
  assert.deepEqual(result, { action: "manual-only", reason: "manual-restore-required" });
  assert.equal(putBodies.length, before);
  assert.equal(currentModels.utility, BACKUP.utility);
});

test("切换后用户手动改了槽位，后续失败不再覆盖", async () => {
  const { guard, getStore, currentModels, putBodies } = makeGuard();
  await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);
  currentModels.utility = { provider: "user-choice", id: "user-picked" };
  const before = putBodies.length;

  const r = await guard.tick([utilityTimeout]);
  assert.equal(r.action, "manual-takeover");
  assert.equal(putBodies.length, before);
  assert.equal(getStore().failwatch.slots.utility.mode, "manual");
  assert.equal(currentModels.utility.id, "user-picked");
});

test("手动切回时仍保持备用的槽位才允许恢复，其他槽位跳过", () => {
  // 纯函数计划的行为在 failwatch.test.js 覆盖；这里确认守护不会自行调用恢复。
  const { guard } = makeGuard();
  return guard.maybeRestore().then((r) => assert.equal(r.action, "manual-only"));
});

// ── 备用模型自身故障 ──

test("备用模型连续失败后进入 backup-failed，仍保持备用等待用户处理", async () => {
  const { guard, getStore, currentModels, putBodies } = makeGuard();
  await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);
  assert.equal(currentModels.utility, BACKUP.utility);

  const r1 = await guard.tick([utilityTimeout]);
  const r2 = await guard.tick([utilityTimeout]);
  assert.equal(r1.action, "standby-failing");
  assert.equal(r2.action, "backup-failed");
  assert.equal(getStore().failwatch.slots.utility.mode, "backup-failed");
  assert.equal(getStore().failwatch.degraded, true);
  assert.equal(currentModels.utility, BACKUP.utility);
  assert.equal(putBodies.length, 1);
});

test("备用模型空响应若只是深度思考耗尽，不累计备用故障", async () => {
  const { guard, getStore, currentModels } = makeGuard({ backupLevels: { utility: "max" } });
  await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);

  const r = await guard.tick(["[ERROR] [llm] LLM_EMPTY_RESPONSE utility"]);
  assert.equal(r.action, "standby-thinking-capped");
  assert.equal(getStore().failwatch.slots.utility.standbyFailures || 0, 0);
  assert.equal(getStore().failwatch.slots.utility.mode, "backup");
  assert.equal(currentModels.utility, BACKUP.utility);
});

// ── 归因与 fail-open ──

test("主模型深度思考导致空响应时不切备用", async () => {
  const { guard, getStore, currentModels, putBodies } = makeGuard({ mainLevels: { utility_large: "max" } });
  const lines = [
    "[ERROR] [memory-ticker] 滚动摘要 (a.jsonl) 失败: 模型未回复正文",
    "[ERROR] [memory-ticker] 滚动摘要 (b.jsonl) 失败: 模型未回复正文",
  ];
  const r = await guard.tick(lines);

  assert.equal(r.action, "main-thinking-capped");
  assert.equal(putBodies.length, 0);
  assert.equal(currentModels.utility_large.provider, "main");
  assert.equal(getStore().failwatch.slots.utility_large.thinkingCapped, 2);
});

test("没有配置备用模型时只记录切换失败，不改变主模型", async () => {
  const { guard, getStore, currentModels, putBodies } = makeGuard({ backup: {} });
  const r = await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);

  assert.equal(r.action, "switch-failed");
  assert.equal(r.error, "no-backup-configured");
  assert.equal(putBodies.length, 0);
  assert.equal(currentModels.utility.provider, "main");
  assert.equal(getStore().failwatch.degraded, false);
});

test("首次运行时 failwatch 为空也会建立可持久化的三槽状态", async () => {
  const { guard, getStore, putBodies } = makeGuard({ backup: {}, emptyFailwatch: true });
  const r = await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);

  assert.equal(r.action, "switch-failed");
  assert.equal(putBodies.length, 0);
  assert.ok(getStore().failwatch);
  assert.equal(getStore().failwatch.slots.utility.mode, "primary");
});

test("旧版单一 degraded 状态能迁移成当前槽位的备用状态", async () => {
  const { guard, getStore, currentModels } = makeGuard({
    initialFailwatch: {
      degraded: true,
      degradedAt: Date.now() - 1000,
      lastDegradePatch: { models: { utility: BACKUP.utility } },
      snapshot: { utility: MAIN.utility },
    },
    current: { ...MAIN, utility: BACKUP.utility },
  });
  const r = await guard.tick([utilityTimeout]);

  assert.equal(r.action, "standby-failing");
  assert.equal(getStore().failwatch.slots.utility.mode, "backup");
  assert.equal(currentModels.utility, BACKUP.utility);
});

test("未安装提个醒时切换仍然完成，不阻断主流程", async () => {
  const { guard, currentModels, notifications } = makeGuard({ sendNotify: false });
  const r = await guard.tick(["[ERROR] [llm] LLM_AUTH_FAILED utility"]);

  assert.equal(r.action, "switched-to-backup");
  assert.equal(currentModels.utility, BACKUP.utility);
  assert.equal(notifications.length, 0);
});
