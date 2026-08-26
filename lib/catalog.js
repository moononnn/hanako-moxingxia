// 模型匣 —— 供应商配置业务核心
//
// 隐藏原理（源码调研结论）：
//   Hana 把「模型列表三态」写进设计：缺省=用默认；非空=用户白名单；空数组=明确关闭。
//   关闭的供应商不会写进 models.json，主对话框模型菜单里就消失，但配置（key/地址）原样
//   保留。再把 capabilities.chat.projection 覆盖为 "none"（硬隐藏，兜住 sdk-auth-alias
//   这类不走白名单的供应商），恢复时写回 null 即回退默认。
//
//   排序原理：模型菜单顺序 = provider-catalog.json 的 providers 键序 + 各家 models 数组序
//   （syncModels 保序生成 models.json）。所以重排这两个结构再触发刷新，菜单就跟上。

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 模型条目归一：string → string，{id} → id */
export function extractModelId(entry) {
  if (typeof entry === "string") return entry.trim();
  if (isPlainObject(entry) && typeof entry.id === "string") return entry.id.trim();
  return "";
}

export function extractModelIds(models) {
  if (!Array.isArray(models)) return [];
  return models.map(extractModelId).filter(Boolean);
}

function sameIdMultiset(left, right) {
  if (left.length !== right.length) return false;
  const counts = new Map();
  for (const id of left) counts.set(id, (counts.get(id) || 0) + 1);
  for (const id of right) {
    const next = (counts.get(id) || 0) - 1;
    if (next < 0) return false;
    if (next === 0) counts.delete(id);
    else counts.set(id, next);
  }
  return counts.size === 0;
}

/**
 * 对账 Hana /api/models 的运行时模型顺序。
 * provider-plugins / OAuth 供应商可能使用不同的 runtime provider id，
 * 因此 direct provider 找不到时，只在模型集合完全相同的候选中做保守匹配。
 */
export function inspectRuntimeModelOrder(runtimeModels, providerId, requestedIds) {
  if (!Array.isArray(runtimeModels) || !Array.isArray(requestedIds)) return null;
  const groups = new Map();
  for (const model of runtimeModels) {
    const provider = typeof model?.provider === "string" ? model.provider : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(id);
  }

  const candidates = providerId && groups.has(providerId)
    ? [[providerId, groups.get(providerId)]]
    : [...groups.entries()].filter(([, ids]) => sameIdMultiset(ids, requestedIds));
  if (candidates.length === 0) return null;
  const [runtimeProviderId, actualIds] = candidates[0];
  return {
    runtimeProviderId,
    actualIds: [...actualIds],
    matches: actualIds.length === requestedIds.length
      && actualIds.every((id, index) => id === requestedIds[index]),
  };
}

/**
 * 对账 Hana /api/models 的运行时供应商首次出现顺序。
 * 对 runtime provider alias 先看显式 runtimeProviderId，再按完整模型集合匹配。
 */
export function inspectRuntimeProviderOrder(runtimeModels, requestedProviderIds, providerConfigs) {
  if (!Array.isArray(runtimeModels) || !Array.isArray(requestedProviderIds)) return null;
  const groups = new Map();
  const runtimeOrder = [];
  for (const model of runtimeModels) {
    const provider = typeof model?.provider === "string" ? model.provider : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    if (!groups.has(provider)) {
      groups.set(provider, []);
      runtimeOrder.push(provider);
    }
    groups.get(provider).push(id);
  }

  const resolvedOrder = [];
  for (const providerId of requestedProviderIds) {
    const config = providerConfigs?.[providerId] || {};
    const explicitRuntimeId = config?.capabilities?.chat?.runtimeProviderId;
    let runtimeProviderId = explicitRuntimeId && groups.has(explicitRuntimeId)
      ? explicitRuntimeId
      : groups.has(providerId) ? providerId : null;
    if (!runtimeProviderId) {
      const requestedIds = extractModelIds(config.models);
      if (requestedIds.length > 0) {
        const candidate = [...groups.entries()].find(([, ids]) => sameIdMultiset(ids, requestedIds));
        runtimeProviderId = candidate?.[0] || null;
      }
    }
    if (runtimeProviderId && !resolvedOrder.includes(runtimeProviderId)) resolvedOrder.push(runtimeProviderId);
  }

  const actualOrder = runtimeOrder.filter((providerId) => resolvedOrder.includes(providerId));
  return {
    actualOrder,
    requestedRuntimeOrder: resolvedOrder,
    matches: actualOrder.length === resolvedOrder.length
      && actualOrder.every((providerId, index) => providerId === resolvedOrder[index]),
  };
}

/** 快照 provider 配置里用于恢复的关键字段 */
export function snapshotProvider(providerConfig) {
  const caps = isPlainObject(providerConfig?.capabilities) ? providerConfig.capabilities : {};
  const chat = isPlainObject(caps.chat) ? caps.chat : {};
  return {
    models: Array.isArray(providerConfig?.models) ? structuredClone(providerConfig.models) : [],
    projection: typeof chat.projection === "string" ? chat.projection : null,
  };
}

/** 生成「隐藏」patch：models 置空 + chat 投影覆盖为 none（保留原 capabilities 其他部分） */
export function buildHidePatch(providerConfig) {
  const caps = isPlainObject(providerConfig?.capabilities) ? providerConfig.capabilities : {};
  const chat = isPlainObject(caps.chat) ? caps.chat : {};
  return {
    models: [],
    capabilities: {
      ...structuredClone(caps),
      chat: { ...structuredClone(chat), projection: "none" },
    },
  };
}

/** 生成「恢复」patch：models 还原 + 投影写回 null（null 会回退插件/默认投影） */
export function buildShowPatch(providerConfig, snapshot) {
  const caps = isPlainObject(providerConfig?.capabilities) ? providerConfig.capabilities : {};
  const chat = isPlainObject(caps.chat) ? caps.chat : {};
  return {
    models: Array.isArray(snapshot?.models) ? snapshot.models : [],
    capabilities: {
      ...structuredClone(caps),
      chat: { ...structuredClone(chat), projection: snapshot?.projection || null },
    },
  };
}

/** 校验重排后的 ids 与现有顺序是否同一批（多重集相等），返回错误文案或 null */
export function validateReorder(ids, currentIds) {
  if (!Array.isArray(ids) || !Array.isArray(currentIds)) return "参数不对";
  if (ids.length !== currentIds.length) return "数量对不上，请刷新后再试";
  const countA = new Map();
  const countB = new Map();
  for (const id of currentIds) countA.set(id, (countA.get(id) || 0) + 1);
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) return "订单里有空项";
    countB.set(id, (countB.get(id) || 0) + 1);
  }
  for (const [id, n] of countA) {
    if (countB.get(id) !== n) return "订单和当前列表不一样，请刷新后再试";
  }
  return null;
}

/**
 * 组装页面用的供应商列表。
 * @param catalog provider-catalog.json 内容（保序）
 * @param store 插件数据（隐藏快照）
 * @param modelState { current, activeModel } 当前模型信息
 */
/** 按新顺序重建 providers 对象（保留原配置），返回新 catalog 副本 */
export function reorderProvidersObject(catalog, ids) {
  const providers = isPlainObject(catalog?.providers) ? catalog.providers : {};
  const currentIds = Object.keys(providers);
  const invalid = validateReorder(ids, currentIds);
  if (invalid) return { error: invalid };
  const nextProviders = {};
  for (const id of ids) nextProviders[id] = providers[id];
  return { catalog: { ...catalog, providers: nextProviders } };
}

/** 按 ids 重排模型条目，保留每个条目的原始字段与重复 id */
export function reorderModelEntries(entries, ids) {
  const current = Array.isArray(entries) ? entries : [];
  const invalid = validateReorder(ids, extractModelIds(current));
  if (invalid) return { error: invalid };

  const remaining = current.slice();
  const models = [];
  for (const id of ids) {
    const index = remaining.findIndex((entry) => extractModelId(entry) === id);
    if (index < 0) return { error: "订单和当前列表不一样，请刷新后再试" };
    models.push(remaining.splice(index, 1)[0]);
  }
  return { models };
}

/** 模型条目显示名：对象带 name 用 name，否则用 id */
export function extractModelDisplay(entry) {
  if (isPlainObject(entry) && typeof entry.name === "string" && entry.name.trim()) {
    return entry.name.trim();
  }
  return extractModelId(entry);
}

/** 供应商类型：内置（Pi SDK 目录里，顺序定死）/ 自定义（顺序可跟随配置）/ 未知（名单不可用） */
export function resolveProviderKind(providerId, providerConfig, builtinIds) {
  if (!builtinIds || !(builtinIds instanceof Set)) return null;
  const chat = isPlainObject(providerConfig?.capabilities?.chat) ? providerConfig.capabilities.chat : {};
  const runtimeId = typeof chat.runtimeProviderId === "string" && chat.runtimeProviderId
    ? chat.runtimeProviderId
    : providerId;
  return builtinIds.has(runtimeId) ? "builtin" : "custom";
}

/**
 * 逐家对账供应商顺序：每家返回 ok / moved（位置变了）/ missing（没出现在菜单）。
 * 基于 inspectRuntimeProviderOrder 的结果，不重复计算。
 */
export function inspectRuntimeProviderOrderDetailed(runtimeModels, requestedProviderIds, providerConfigs) {
  const base = inspectRuntimeProviderOrder(runtimeModels, requestedProviderIds, providerConfigs);
  if (!base) return null;
  // 原函数会跳过完全不在运行时的 provider，这里按请求顺序逐家补齐结果
  const runtimeForRequest = new Map();
  base.requestedRuntimeOrder.forEach((runtimeId, index) => runtimeForRequest.set(requestedProviderIds[index], runtimeId));
  const providerResults = requestedProviderIds.map((requestedId, index) => {
    const runtimeId = runtimeForRequest.has(requestedId) ? runtimeForRequest.get(requestedId) : requestedId;
    const actualIndex = base.actualOrder.indexOf(runtimeId);
    return {
      requestedId,
      runtimeId,
      state: actualIndex < 0 ? "missing" : actualIndex === index ? "ok" : "moved",
      actualIndex,
      requestedIndex: index,
    };
  });
  return { ...base, providerResults };
}

/**
 * 组装页面用的供应商列表。
 * @param catalog provider-catalog.json 内容（保序）
 * @param store 插件数据（隐藏快照）
 * @param modelState { current, activeModel } 当前模型信息
 * @param builtinIds 内置供应商名单（Set），可缺省（缺省时 kind 为 null）
 */
export function listProviders(catalog, store, modelState = {}, builtinIds) {
  const providers = isPlainObject(catalog?.providers) ? catalog.providers : {};
  const list = [];
  for (const [id, config] of Object.entries(providers)) {
    const models = Array.isArray(config?.models) ? config.models : [];
    const hidden = !!store?.hidden?.[id];
    const currentProvider = modelState?.activeModel?.provider || modelState?.current?.provider || null;
    list.push({
      id,
      displayName: config?.display_name || config?.displayName || id,
      kind: resolveProviderKind(id, config, builtinIds),
      models: models.map((entry) => ({
        id: extractModelId(entry),
        name: extractModelDisplay(entry),
      })),
      modelCount: models.length,
      hidden,
      inUse: currentProvider === id,
    });
  }
  return list;
}