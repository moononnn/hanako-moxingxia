// 模型匣 —— 核心逻辑单元测试（node:test，零依赖）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildHidePatch,
  buildShowPatch,
  extractModelIds,
  inspectRuntimeModelOrder,
  inspectRuntimeProviderOrder,
  inspectRuntimeProviderOrderDetailed,
  listProviders,
  reorderModelEntries,
  reorderProvidersObject,
  resolveProviderKind,
  snapshotProvider,
  validateReorder,
} from "../lib/catalog.js";
import {
  dropHiddenRecord,
  getHiddenRecord,
  pruneHiddenRecords,
  readStore,
  setHiddenRecord,
  writeStore,
} from "../lib/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEffectiveCatalog } from "../lib/host-api.js";
import { getDragAutoScrollStep } from "../lib/page.js";

// ── extractModelIds：混合条目（string / {id} / 脏数据） ──
test("extractModelIds 混合条目归一", () => {
  const models = ["a", { id: "b" }, { id: "  c  " }, null, 42, { id: "" }];
  assert.deepEqual(extractModelIds(models), ["a", "b", "c"]);
});

// ── 快照与隐藏/恢复 patch ──
test("snapshotProvider 记录 models 与 projection", () => {
  const p = {
    models: ["m1", { id: "m2", name: "M2" }],
    capabilities: { chat: { projection: "sdk-auth-alias" }, media: { k: 1 } },
  };
  const snap = snapshotProvider(p);
  assert.deepEqual(snap.models, ["m1", { id: "m2", name: "M2" }]);
  assert.equal(snap.projection, "sdk-auth-alias");
});

test("buildHidePatch：models 置空 + projection none，其他 capabilities 保留", () => {
  const p = {
    models: ["m1"],
    capabilities: { chat: { projection: "models-json", runtimeProviderId: "x" }, media: { items: [] } },
  };
  const patch = buildHidePatch(p);
  assert.deepEqual(patch.models, []);
  assert.equal(patch.capabilities.chat.projection, "none");
  assert.equal(patch.capabilities.chat.runtimeProviderId, "x");
  assert.deepEqual(patch.capabilities.media, { items: [] });
});

test("buildHidePatch：无 capabilities 时不造垃圾", () => {
  const p = { models: ["m1"] };
  const patch = buildHidePatch(p);
  assert.deepEqual(patch.models, []);
  assert.equal(patch.capabilities.chat.projection, "none");
});

test("buildShowPatch：恢复 models + projection 回退", () => {
  const p = { models: [], capabilities: { chat: { projection: "none" } } };
  const snap = { models: ["m1", "m2"], projection: "sdk-auth-alias" };
  const patch = buildShowPatch(p, snap);
  assert.deepEqual(patch.models, ["m1", "m2"]);
  assert.equal(patch.capabilities.chat.projection, "sdk-auth-alias");
});

test("buildShowPatch：快照无 projection 时写 null（回退插件默认）", () => {
  const p = { models: [] };
  const snap = { models: ["m1"], projection: null };
  const patch = buildShowPatch(p, snap);
  assert.equal(patch.capabilities.chat.projection, null);
});

// ── validateReorder ──
test("validateReorder 通过：排列相同集合", () => {
  assert.equal(validateReorder(["a", "b", "c"], ["c", "a", "b"]), null);
  assert.equal(validateReorder(["a", "a", "b"], ["b", "a", "a"]), null);
});

test("validateReorder 拒绝：缺/多/重名", () => {
  assert.ok(validateReorder(["a", "b"], ["a", "b", "c"]));
  assert.ok(validateReorder(["a", "b", "d"], ["a", "b", "c"]));
  assert.ok(validateReorder(["a", "a", "b"], ["a", "b", "c"]));
  assert.ok(validateReorder(["a", "b", ""], ["a", "b", "c"]));
  assert.ok(validateReorder("nope", ["a", "b"]));
});

test("inspectRuntimeModelOrder：直连 provider 对账运行时顺序", () => {
  const result = inspectRuntimeModelOrder(
    [{ provider: "deepseek", id: "b" }, { provider: "deepseek", id: "a" }],
    "deepseek",
    ["a", "b"],
  );
  assert.deepEqual(result, {
    runtimeProviderId: "deepseek",
    actualIds: ["b", "a"],
    matches: false,
  });
});

test("inspectRuntimeModelOrder：provider alias 按完整模型集合匹配", () => {
  const result = inspectRuntimeModelOrder(
    [{ provider: "openai-codex", id: "a" }, { provider: "openai-codex", id: "b" }],
    "openai-codex-oauth",
    ["b", "a"],
  );
  assert.equal(result.runtimeProviderId, "openai-codex");
  assert.deepEqual(result.actualIds, ["a", "b"]);
  assert.equal(result.matches, false);
});

test("inspectRuntimeProviderOrder：按首次出现顺序发现供应商错位", () => {
  const result = inspectRuntimeProviderOrder(
    [
      { provider: "deepseek", id: "d" },
      { provider: "minimax", id: "m" },
      { provider: "command code", id: "c" },
    ],
    ["deepseek", "command code", "minimax"],
    {
      deepseek: { models: ["d"] },
      "command code": { models: ["c"] },
      minimax: { models: ["m"] },
    },
  );
  assert.deepEqual(result.actualOrder, ["deepseek", "minimax", "command code"]);
  assert.deepEqual(result.requestedRuntimeOrder, ["deepseek", "command code", "minimax"]);
  assert.equal(result.matches, false);
});

test("inspectRuntimeProviderOrder：支持 OAuth runtime provider alias", () => {
  const result = inspectRuntimeProviderOrder(
    [
      { provider: "deepseek", id: "d" },
      { provider: "openai-codex", id: "a" },
    ],
    ["openai-codex-oauth", "deepseek"],
    {
      "openai-codex-oauth": { models: ["a"] },
      deepseek: { models: ["d"] },
    },
  );
  assert.deepEqual(result.requestedRuntimeOrder, ["openai-codex", "deepseek"]);
  assert.deepEqual(result.actualOrder, ["deepseek", "openai-codex"]);
  assert.equal(result.matches, false);
});

// ── 拖动边缘自动滚动 ──
test("getDragAutoScrollStep：上下边缘滚动，中心与边界不越界", () => {
  assert.ok(getDragAutoScrollStep(4, 600, 120, 1800, 600) < 0);
  assert.ok(getDragAutoScrollStep(596, 600, 120, 1800, 600) > 0);
  assert.equal(getDragAutoScrollStep(300, 600, 120, 1800, 600), 0);
  assert.equal(getDragAutoScrollStep(4, 600, 0, 1800, 600), 0);
  assert.equal(getDragAutoScrollStep(596, 600, 1200, 1800, 600), 0);
});

// ── reorderProvidersObject ──
test("reorderProvidersObject 重排键序且不丢配置", () => {
  const catalog = {
    providers: { deepseek: { api_key: "k1" }, minimax: { api_key: "k2" }, gemini: { api_key: "k3" } },
  };
  const out = reorderProvidersObject(catalog, ["gemini", "deepseek", "minimax"]);
  assert.equal(out.error, undefined);
  assert.deepEqual(Object.keys(out.catalog.providers), ["gemini", "deepseek", "minimax"]);
  assert.equal(out.catalog.providers.deepseek.api_key, "k1");
  assert.equal(out.catalog.providers.gemini.api_key, "k3");
});

test("reorderProvidersObject 拒绝错集合且不改原对象", () => {
  const catalog = { providers: { a: {}, b: {} } };
  const out = reorderProvidersObject(catalog, ["a", "c"]);
  assert.ok(out.error);
  assert.deepEqual(Object.keys(catalog.providers), ["a", "b"]);
});

// ── reorderModelEntries ──
test("reorderModelEntries 重排模型且保留对象字段", () => {
  const current = [
    "m1",
    { id: "m2", name: "模型二", reasoning: true },
    { id: "m3", context: 1000000 },
  ];
  const out = reorderModelEntries(current, ["m3", "m1", "m2"]);
  assert.deepEqual(out.models, [current[2], current[0], current[1]]);
  assert.equal(out.models[0].context, 1000000);
  assert.equal(out.models[2].reasoning, true);
});

test("reorderModelEntries 处理重复 id 时不丢条目", () => {
  const current = [{ id: "same", name: "第一条" }, { id: "same", name: "第二条" }];
  const out = reorderModelEntries(current, ["same", "same"]);
  assert.deepEqual(out.models, current);
});

// ── listProviders ──
test("listProviders 组装 hidden/inUse/模型数", () => {
  const catalog = {
    providers: {
      deepseek: { models: ["v4-pro", { id: "v4-flash", name: "Flash" }] },
      minimax: { models: ["M3"] },
    },
  };
  const store = { hidden: { minimax: { models: ["M3"] } } };
  const list = listProviders(catalog, store, { activeModel: { provider: "deepseek", id: "v4-pro" } });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "deepseek");
  assert.equal(list[0].hidden, false);
  assert.equal(list[0].inUse, true);
  assert.equal(list[0].modelCount, 2);
  assert.deepEqual(list[0].models.map((m) => m.name), ["v4-pro", "Flash"]);
  assert.equal(list[1].id, "minimax");
  assert.equal(list[1].hidden, true);
  assert.equal(list[1].inUse, false);
});

// ── 内置/自定义判定 ──
test("resolveProviderKind：命中内置名单=builtin，未命中=custom", () => {
  const builtinIds = new Set(["deepseek", "minimax", "openai-codex"]);
  assert.equal(resolveProviderKind("deepseek", {}, builtinIds), "builtin");
  assert.equal(resolveProviderKind("command code", {}, builtinIds), "custom");
  assert.equal(resolveProviderKind("minimax", undefined, builtinIds), "builtin");
});

test("resolveProviderKind：runtimeProviderId 投影参与判定（oauth 别名）", () => {
  const builtinIds = new Set(["openai-codex"]);
  const oauth = { capabilities: { chat: { runtimeProviderId: "openai-codex" } } };
  assert.equal(resolveProviderKind("openai-codex-oauth", oauth, builtinIds), "builtin");
  assert.equal(resolveProviderKind("openai-codex-oauth", {}, builtinIds), "custom");
});

test("resolveProviderKind：名单不可用（null/非 Set）时返回 null（未知）", () => {
  assert.equal(resolveProviderKind("deepseek", {}, null), null);
  assert.equal(resolveProviderKind("deepseek", {}, undefined), null);
  assert.equal(resolveProviderKind("deepseek", {}, new Map()), null);
});

test("listProviders 带名单时输出 kind 字段，缺省时 kind=null", () => {
  const catalog = { providers: { deepseek: { models: [] }, "command code": { models: [] } } };
  const builtinIds = new Set(["deepseek"]);
  const list = listProviders(catalog, {}, {}, builtinIds);
  assert.equal(list[0].kind, "builtin");
  assert.equal(list[1].kind, "custom");
  const without = listProviders(catalog, {}, {});
  assert.equal(without[0].kind, null);
});

// ── 逐家对账 ──
test("inspectRuntimeProviderOrderDetailed：ok/moved/missing 三态", () => {
  const runtime = [
    { provider: "deepseek", id: "d1" },
    { provider: "minimax", id: "m1" },
    { provider: "command code", id: "c1" },
  ];
  const configs = {
    deepseek: { models: ["d1"] },
    minimax: { models: ["m1"] },
    "command code": { models: ["c1"] },
    hidden: { models: ["h1"] },
  };
  const result = inspectRuntimeProviderOrderDetailed(
    runtime,
    ["deepseek", "command code", "minimax", "hidden"],
    configs,
  );
  assert.equal(result.matches, false);
  assert.deepEqual(result.providerResults, [
    { requestedId: "deepseek", runtimeId: "deepseek", state: "ok", actualIndex: 0, requestedIndex: 0 },
    { requestedId: "command code", runtimeId: "command code", state: "moved", actualIndex: 2, requestedIndex: 1 },
    { requestedId: "minimax", runtimeId: "minimax", state: "moved", actualIndex: 1, requestedIndex: 2 },
    { requestedId: "hidden", runtimeId: "hidden", state: "missing", actualIndex: -1, requestedIndex: 3 },
  ]);
});

// ── store：原子读写、快照增删、死记录清理 ──
function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moxingxia-test-"));
}

test("readEffectiveCatalog 补齐已迁移本地供应商的模型", () => {
  const dir = tmpDataDir();
  try {
    fs.writeFileSync(path.join(dir, "provider-catalog.json"), JSON.stringify({
      catalogVersion: 2,
      providers: { "local-demo": { api_key: "secret-ref" }, regular: { models: ["r1"] } },
    }));
    const providerDir = path.join(dir, "provider-plugins", "local-demo");
    fs.mkdirSync(path.join(providerDir, "providers"), { recursive: true });
    fs.writeFileSync(path.join(providerDir, "manifest.json"), JSON.stringify({ provider: "local-demo" }));
    fs.writeFileSync(path.join(providerDir, "providers", "local-demo.json"), JSON.stringify({
      displayName: "本地示例",
      models: [{ id: "l1", context: 1000000 }, "l2"],
    }));

    const out = readEffectiveCatalog(dir);
    assert.deepEqual(out.providers["local-demo"].models, [
      { id: "l1", context: 1000000 },
      "l2",
    ]);
    assert.equal(out.providers["local-demo"].display_name, "本地示例");
    assert.equal(out.providers["local-demo"].api_key, "secret-ref");
    assert.deepEqual(Object.keys(out.providers), ["local-demo", "regular"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store 读写与快照增删", () => {
  const dir = tmpDataDir();
  try {
    const s0 = readStore(dir);
    assert.deepEqual(s0.hidden, {});
    setHiddenRecord(dir, s0, "deepseek", { models: ["a"], projection: null, hiddenAt: "t" });
    const s1 = readStore(dir);
    assert.equal(getHiddenRecord(s1, "deepseek").models[0], "a");
    dropHiddenRecord(dir, s1, "deepseek");
    assert.equal(getHiddenRecord(readStore(dir), "deepseek"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store 损坏/缺失时回退默认", () => {
  const dir = tmpDataDir();
  try {
    fs.writeFileSync(path.join(dir, "store.json"), "{broken json");
    const s = readStore(dir);
    assert.deepEqual(s.hidden, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneHiddenRecords 清掉供应商已不存在的快照", () => {
  const dir = tmpDataDir();
  try {
    const store = { hidden: { alive: { models: [] }, dead: { models: [] } } };
    const changed = pruneHiddenRecords(store, ["alive"]);
    assert.equal(changed, true);
    assert.deepEqual(Object.keys(store.hidden), ["alive"]);
    writeStore(dir, store);
    assert.deepEqual(readStore(dir).hidden, { alive: { models: [] } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});