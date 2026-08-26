// 模型匣 —— Hana 内置供应商名单解析
//
// 主菜单顺序的真相（0.712.5 源码调研结论）：
//   Pi SDK 的 ModelRegistry 先按内置目录（pi-ai 的 models.generated.js MODELS 键）
//   构建模型列表，models.json 只能原位替换（provider+id 命中）或尾部追加（新增）。
//   「内置 vs 自定义」是拖动排序能否生效的分水岭：
//     - 内置（MODELS 键里）：顺序由 Hana/Pi SDK 目录定死，拖动保存不会跟着换
//     - 自定义（不在 MODELS 键）：运行时顺序 = models.json 自定义条目顺序，拖动有效
//
// 名单来源：Hana 服务端组件解包目录
//   <hanakoHome>/artifacts/server/<version>/node_modules/@earendil-works/pi-ai/dist/models.generated.js
// Hana 更新后目录带新版本号，这里按版本扫描取最新可用的一份。

import fs from "node:fs";
import path from "node:path";

const PI_AI_MODELS_FILE = path.join("node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");
const SERVER_ARTIFACTS_DIR = path.join("artifacts", "server");

/** 版本目录排序：按数字段比较（0.712.5-win32-x64 → 0.712.5） */
function compareVersionDirs(a, b) {
  const num = (name) => name.replace(/-.*$/, "").split(".").map(Number);
  const pa = num(a);
  const pb = num(b);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return a.localeCompare(b);
}

/** 从 models.generated.js 文本提取 MODELS 对象键（provider id 集合） */
export function extractPiProviderIds(sourceText) {
  const ids = new Set();
  const re = /^\s*"([A-Za-z0-9._-]+)"\s*:/gm;
  let m;
  while ((m = re.exec(sourceText))) ids.add(m[1]);
  return ids;
}

/**
 * 解析 Hana 内置供应商名单；找不到/解析失败返回 null（调用方降级为「未知」，
 * 不猜测、不误标，宁可不显示徽标也不标错）。
 */
export function resolveBuiltinProviderIds(hanakoHome) {
  try {
    const root = path.join(hanakoHome, SERVER_ARTIFACTS_DIR);
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(compareVersionDirs)
      .reverse();
    for (const dir of dirs) {
      const file = path.join(root, dir, PI_AI_MODELS_FILE);
      if (!fs.existsSync(file)) continue;
      const ids = extractPiProviderIds(fs.readFileSync(file, "utf-8"));
      if (ids.size > 0) return ids;
    }
  } catch {
    /* 目录不存在/权限问题等一律视为未知 */
  }
  return null;
}