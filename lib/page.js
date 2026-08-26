// 模型匣 —— 设置页面（服务端渲染完整 HTML）
// 纪律（坑 41/8/51）：客户端 JS 内联、零外部资源、不用反引号模板里的 ${} 语法

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 视口边缘拖动时的单帧滚动步长，纯函数便于回归测试。 */
export function getDragAutoScrollStep(
  clientY,
  viewportHeight,
  scrollTop,
  scrollHeight,
  clientHeight,
  edge = 72,
  maxStep = 12,
) {
  const y = Number(clientY);
  const viewport = Number(viewportHeight);
  const top = Number(scrollTop);
  const height = Number(scrollHeight);
  const visible = Number(clientHeight);
  const edgeSize = Number(edge);
  const frameMax = Number(maxStep);
  if (![y, viewport, top, height, visible, edgeSize, frameMax].every(Number.isFinite)
    || viewport <= 0 || height <= visible || edgeSize <= 0 || frameMax <= 0) return 0;
  const maxScroll = Math.max(0, height - visible);
  const clampedTop = Math.max(0, Math.min(maxScroll, top));
  if (y < edgeSize && clampedTop > 0) {
    const intensity = Math.min(1, Math.max(0, (edgeSize - y) / edgeSize));
    return -Math.min(clampedTop, Math.max(1, Math.ceil(frameMax * intensity)));
  }
  if (y > viewport - edgeSize && clampedTop < maxScroll) {
    const intensity = Math.min(1, Math.max(0, (y - (viewport - edgeSize)) / edgeSize));
    return Math.min(maxScroll - clampedTop, Math.max(1, Math.ceil(frameMax * intensity)));
  }
  return 0;
}

const CSS = `
:root{
  --primary:#5dae8e; --primary-deep:#3e8a6d; --primary-soft:#e3f2ec;
  --accent:#e89bb0; --accent-soft:#fbeef2;
  --bg:#faf6ef; --card:#fffdf8; --ink:#5c6f66; --ink-strong:#3d4f47;
  --line:#e8e0d2; --muted:#a89f90; --danger:#d97a7a;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--bg); color:var(--ink);
  font-family:'KaiTi','楷体','Noto Sans SC','Microsoft YaHei',system-ui,sans-serif;
  padding:20px 18px 40px; max-width:720px; margin:0 auto;
}
.page-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.page-head .logo{
  width:38px;height:38px;border-radius:12px;background:var(--primary-soft);
  display:flex;align-items:center;justify-content:center;color:var(--primary-deep);
  font-size:20px;flex:none
}
.page-head h1{font-size:22px;color:var(--ink-strong);letter-spacing:1px}
.page-sub{font-size:13px;color:var(--muted);margin-bottom:16px;padding-left:48px}
#provider-list{
  max-height:calc(100vh - 184px);overflow-y:auto;overscroll-behavior:contain;
  padding:2px 6px 4px 2px;scrollbar-gutter:stable
}
.status-bar{
  border-radius:12px;padding:10px 14px;font-size:13px;margin-bottom:16px;
  background:var(--primary-soft);color:var(--primary-deep)
}
.status-bar.err{background:var(--accent-soft);color:#c96a84}
.status-bar .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor;margin-right:8px}
.provider-card{
  background:var(--card);border-radius:18px;box-shadow:0 2px 12px rgba(0,0,0,.06);
  padding:14px 16px;margin-bottom:12px;transition:box-shadow .2s,transform .2s;
  user-select:none
}
.provider-card[draggable="true"]{cursor:grab}
.provider-card[draggable="true"]:active{cursor:grabbing}
.provider-card:hover{box-shadow:0 4px 18px rgba(0,0,0,.09);transform:translateY(-1px)}
.provider-card.hidden{opacity:.62}
.provider-card.in-use{border:1px solid var(--accent)}
.provider-card.dragging{opacity:.5;transform:scale(.99)}
.provider-card.drag-over{box-shadow:inset 0 3px 0 var(--primary),0 2px 12px rgba(0,0,0,.06)}
.p-row{display:flex;align-items:center;gap:12px}
.drag-grip{
  flex:none;width:17px;color:var(--muted);font-size:16px;line-height:1;
  letter-spacing:-4px;cursor:grab;user-select:none;opacity:.78
}
.p-badge{
  width:34px;height:34px;border-radius:10px;flex:none;
  background:var(--primary-soft);color:var(--primary-deep);
  display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700
}
.p-name{font-size:16px;color:var(--ink-strong);font-weight:600;display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.p-name .alias{font-size:12px;color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{
  font-size:11px;padding:2px 8px;border-radius:99px;flex:none
}
.tag.count{background:var(--primary-soft);color:var(--primary-deep)}
.tag.inuse{background:var(--accent-soft);color:#c96a84}
.tag.hidden-tag{background:#efe9dd;color:var(--muted)}
.tag.builtin-tag{background:#f3e9d8;color:#9a7b4f}
.tag.custom-tag{background:var(--primary-soft);color:var(--primary-deep)}
.switch{position:relative;width:48px;height:28px;flex:none;cursor:pointer}
.switch input{opacity:0;width:0;height:0}
.switch .track{
  position:absolute;inset:0;border-radius:99px;background:#eadfcc;
  box-shadow:inset 0 2px 4px rgba(93,110,102,.16);transition:background .2s
}
.switch .knob{
  position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:50%;
  background:#fdf9ee;
  box-shadow:0 1px 3px rgba(93,110,102,.3),inset 0 -1px 2px rgba(93,110,102,.12),inset 0 1px 0 #fff;
  transition:transform .22s cubic-bezier(.34,1.56,.64,1)
}
.switch:hover .track{background:#e2d5bd}
.switch input:checked + .track{background:var(--primary);box-shadow:inset 0 2px 4px rgba(40,90,72,.22)}
.switch input:checked:hover + .track{background:var(--primary-deep)}
.switch input:checked + .track + .knob{transform:translateX(20px)}
.model-list{border-top:1px solid var(--line);margin-top:12px;padding-top:10px;display:none}
.provider-card.open .model-list{display:block}
.model-row{
  display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px dashed var(--line);
  font-size:13px;cursor:grab;user-select:none;transition:background .15s,opacity .15s,transform .15s
}
.model-row:last-child{border-bottom:none}
.model-row:active{cursor:grabbing}
.model-row.dragging{opacity:.5;transform:scale(.99)}
.model-row.drag-over{background:var(--primary-soft);box-shadow:inset 0 2px 0 var(--primary)}
.model-row .m-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.model-row .m-name code{font-size:11px;color:var(--muted);font-family:inherit}
.expand-btn{
  border:none;background:none;color:var(--muted);font-size:12px;cursor:pointer;
  padding:4px 6px;border-radius:8px;flex:none
}
.expand-btn:hover{background:var(--primary-soft);color:var(--primary-deep)}
.toast-wrap{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99;display:flex;flex-direction:column;gap:8px;align-items:center}
.toast{
  background:var(--ink-strong);color:#fdf8ef;font-size:13px;padding:9px 18px;border-radius:99px;
  box-shadow:0 4px 16px rgba(0,0,0,.18);animation:toast-in .25s ease
}
.toast.err{background:var(--danger)}
@keyframes toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.page-foot{margin-top:22px;padding-top:14px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.page-foot a,.page-foot button{
  font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--line);
  padding:5px 14px;border-radius:99px;background:var(--card);cursor:pointer;font-family:inherit
}
.page-foot a:hover,.page-foot button:hover{color:var(--primary-deep);border-color:var(--primary)}
.note{font-size:12px;color:var(--muted);text-align:center;margin-top:10px;line-height:1.7}
.update-result{font-size:12px;color:var(--muted);text-align:center;margin-top:6px;line-height:1.7;word-break:break-all}
.update-result a{color:var(--primary-deep);text-decoration:underline}
.empty-tip{
  text-align:center;padding:40px 20px;color:var(--muted);font-size:14px;background:var(--card);
  border-radius:18px;box-shadow:0 2px 12px rgba(0,0,0,.06)
}
.defs{display:none}
*::-webkit-scrollbar{width:8px;height:8px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--bg)}
*::-webkit-scrollbar-thumb:hover{background:var(--primary)}
*{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
`;

function clientJs(apiBase) {
  const dragScrollHelper = getDragAutoScrollStep.toString();
  // 页面 URL 上带着宿主给的 surface token，客户端请求要手动带回去（坑 6）。
  // 注意：iframe URL 可能同时有 token（主 API query token）和 pluginSurfaceSession，
  // 只取 pluginSurfaceSession，两个不能拼接（拼接会让服务端拆包失败）。
  return `
(() => {
  const api = "${apiBase}";
  const pss = new URLSearchParams(location.search).get("pluginSurfaceSession") || "";
  const qs = pss ? "?pluginSurfaceSession=" + encodeURIComponent(pss) : "";
  const $ = (s) => document.querySelector(s);
  const listEl = $("#provider-list");
  const statusEl = $("#status");
  const toastWrap = $("#toast-wrap");
  const dragScrollStep = ${dragScrollHelper};
  let state = null;

  function toast(text, isErr) {
    const el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.textContent = text;
    toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function badgeText(id) {
    const c = String(id || "?").trim();
    return esc(c.charAt(0).toUpperCase() || "?");
  }

  function renderProviders() {
    const list = state.list || [];
    const openIds = new Set(Array.from(listEl.querySelectorAll(".provider-card.open"))
      .map((el) => el.dataset.id));
    if (list.length === 0) {
      listEl.innerHTML = '<div class="empty-tip">匣子是空的。<br>去 Hana 设置里配置模型供应商，它们就会出现在这里。</div>';
      return;
    }
    listEl.innerHTML = list.map((p) => {
      const isOpen = openIds.has(p.id);
      const modelRows = (p.models || []).map((m) => {
        return '<div class="model-row" draggable="true" data-drag-kind="model" data-provider-id="' + esc(p.id) + '" data-model-id="' + esc(m.id) + '">'
          + '<span class="drag-grip" title="拖动模型排序" aria-hidden="true">⋮⋮</span>'
          + '<span class="m-name">' + esc(m.name) + '<code> · ' + esc(m.id) + '</code></span>'
          + '</div>';
      }).join("");
      const tags =
        (p.hidden ? '<span class="tag hidden-tag">已收进匣底</span>' : "")
        + (p.inUse ? '<span class="tag inuse">正在用</span>' : "")
        + (p.kind === "builtin" ? '<span class="tag builtin-tag" title="Hana 内置供应商：顺序由内置目录决定，拖动保存后菜单不会跟着换（可以隐藏）">Hana 内置</span>' : "")
        + (p.kind === "custom" ? '<span class="tag custom-tag" title="自定义供应商：拖动排序保存后能真正生效">可排序</span>' : "")
        + '<span class="tag count">' + p.modelCount + ' 个模型</span>';
      return '<div class="provider-card' + (p.hidden ? " hidden" : "") + (p.inUse ? " in-use" : "") + (isOpen ? " open" : "") + '" draggable="true" data-drag-kind="provider" data-id="' + esc(p.id) + '">'
        + '<div class="p-row">'
        + '<span class="drag-grip" title="拖动供应商排序" aria-hidden="true">⋮⋮</span>'
        + '<div class="p-badge">' + badgeText(p.id) + '</div>'
        + '<div class="p-name">' + esc(p.displayName || p.id)
        + (p.displayName && p.displayName !== p.id ? '<span class="alias">' + esc(p.id) + "</span>" : "")
        + '</div>'
        + tags
        + '<label class="switch" title="' + (p.hidden ? "打开后重新出现在模型菜单" : "收起来，不再出现在模型菜单") + '">'
        + '<input type="checkbox" data-act="toggle" ' + (p.hidden ? "" : "checked") + ">"
        + '<span class="track"></span><span class="knob"></span>'
        + '</label>'
        + '</div>'
        + '<button class="expand-btn" data-act="expand">' + (isOpen ? "收起模型明细 ▴" : "模型明细（" + p.modelCount + "） ▾") + '</button>'
        + (modelRows ? '<div class="model-list">' + modelRows + '</div>' : "")
        + "</div>";
    }).join("");
  }

  function renderStatus() {
    if (!state.serverOk) {
      statusEl.className = "status-bar err";
      statusEl.innerHTML = '<span class="dot"></span>连不上 Hana 服务（' + esc(state.error || "未知原因") + "），改不了配置";
      return;
    }
    statusEl.className = "status-bar";
    const hiddenN = (state.list || []).filter((p) => p.hidden).length;
    statusEl.innerHTML = '<span class="dot"></span>'
      + (hiddenN > 0
        ? "有 " + hiddenN + " 家供应商收在匣底，模型菜单里看不到它们，配置原样保留"
        : "所有供应商都在模型菜单里。关掉不用的，菜单立刻清爽");
  }

  async function refresh() {
    const res = await fetch(api + "/state" + qs, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data.ok) {
      statusEl.className = "status-bar err";
      statusEl.innerHTML = '<span class="dot"></span>' + esc(data.error || "加载失败");
      return;
    }
    state = data;
    renderStatus();
    renderProviders();
  }

  async function post(pathname, body) {
    const res = await fetch(api + pathname + qs, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || "操作失败（HTTP " + res.status + "）");
    return data;
  }

  let dragState = null;
  let dragOverEl = null;
  let reorderBusy = false;
  let autoScrollTimer = 0;
  let autoScrollY = null;

  function scrollRoot() {
    return document.scrollingElement || document.documentElement || document.body;
  }

  function scrollTarget() {
    const root = scrollRoot();
    // Hana 页面 iframe 的外层高度可能会随内容撑开；把列表做成自己的滚动容器，
    // 不依赖宿主外层是否把滚轮交给 iframe。
    if (listEl && listEl.scrollHeight > listEl.clientHeight + 1) return listEl;
    if (root && root.scrollHeight > root.clientHeight + 1) return root;
    return null;
  }

  function stopAutoScroll() {
    autoScrollY = null;
    if (autoScrollTimer) clearInterval(autoScrollTimer);
    autoScrollTimer = 0;
  }

  function runAutoScroll() {
    if (!dragState || autoScrollY == null) {
      stopAutoScroll();
      return;
    }
    const target = scrollTarget();
    if (!target) {
      stopAutoScroll();
      return;
    }
    const root = scrollRoot();
    const rect = target === root
      ? { top: 0, height: window.innerHeight }
      : target.getBoundingClientRect();
    const step = dragScrollStep(
      autoScrollY - rect.top,
      rect.height,
      target.scrollTop,
      target.scrollHeight,
      target.clientHeight,
      96,
      18,
    );
    if (!step) return;
    const before = target.scrollTop;
    const windowBefore = window.scrollY;
    target.scrollTop = Math.max(0, Math.min(target.scrollHeight - target.clientHeight, before + step));
    if (target === root && target.scrollTop === before) window.scrollBy(0, step);
    if (target.scrollTop === before && (target !== root || window.scrollY === windowBefore)) stopAutoScroll();
  }

  function updateAutoScroll(ev) {
    if (!dragState) return;
    autoScrollY = ev.clientY;
    if (!autoScrollTimer) {
      runAutoScroll();
      autoScrollTimer = setInterval(runAutoScroll, 16);
    }
  }

  function directChildren(parent, selector) {
    return Array.from(parent.children).filter((el) => el.matches(selector));
  }

  function clearDragOver() {
    if (dragOverEl) dragOverEl.classList.remove("drag-over");
    dragOverEl = null;
  }

  function itemForDragEvent(target, kind) {
    if (!target || typeof target.closest !== "function") return null;
    return kind === "provider"
      ? target.closest('.provider-card[draggable="true"]')
      : target.closest('.model-row[draggable="true"]');
  }

  function dropTargetFor(ev) {
    if (!dragState) return null;
    const target = itemForDragEvent(ev.target, dragState.kind);
    if (!target || target === dragState.item) return null;
    if (dragState.kind === "model"
      && target.closest(".provider-card") !== dragState.item.closest(".provider-card")) return null;
    return target;
  }

  function setDragOver(target) {
    if (dragOverEl === target) return;
    clearDragOver();
    dragOverEl = target;
    if (target) target.classList.add("drag-over");
  }

  function placeByPointer(item, target, ev) {
    const rect = target.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height / 2;
    target.parentNode.insertBefore(item, after ? target.nextSibling : target);
  }

  function dragOrder(item, kind) {
    const selector = kind === "provider" ? ".provider-card" : ".model-row";
    return directChildren(item.parentNode, selector).map((el) =>
      kind === "provider" ? el.dataset.id : el.dataset.modelId);
  }

  async function persistDragOrder(kind, providerId, ids) {
    if (reorderBusy) return;
    reorderBusy = true;
    toast(kind === "provider" ? "正在保存供应商顺序…" : "正在保存模型顺序…");
    try {
      const pathname = kind === "provider"
        ? "/providers/reorder"
        : "/providers/" + encodeURIComponent(providerId) + "/models/reorder";
      const data = await post(pathname, { ids });
      toast(kind === "provider"
        ? (data.applied === false
          ? (data.warning || "顺序已保存，但 Hana 菜单暂未完全采用")
          : data.applied ? "供应商顺序已更新，模型菜单跟着变了" : "供应商顺序已保存")
        : (data.applied === false
          ? (data.warning || "顺序已保存，但 Hana 菜单暂未采用")
          : "模型顺序已更新"));
      await refresh();
    } catch (err) {
      toast(err.message, true);
      await refresh();
    } finally {
      reorderBusy = false;
    }
  }

  function onDragStart(ev) {
    if (reorderBusy) {
      ev.preventDefault();
      return;
    }
    const marker = ev.target && typeof ev.target.closest === "function"
      ? ev.target.closest("[data-drag-kind]") : null;
    const kind = marker && marker.dataset.dragKind;
    const item = itemForDragEvent(ev.target, kind);
    if (!item || (kind !== "provider" && kind !== "model")) return;
    dragState = {
      kind,
      item,
      providerId: kind === "model" ? item.dataset.providerId : null,
    };
    item.classList.add("dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      try { ev.dataTransfer.setData("text/plain", kind); } catch {}
    }
  }

  function onDragOver(ev) {
    if (!dragState) return;
    updateAutoScroll(ev);
    // 原生 DnD 期间滚轮事件常被浏览器接管；document 级 dragover + 定时器
    // 让指针停在滚动容器边缘时页面持续让路，且不要求目标必须是某一张卡片。
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    const target = dropTargetFor(ev);
    if (!target) {
      clearDragOver();
      return;
    }
    setDragOver(target);
  }

  function onDragEnter(ev) {
    const target = dropTargetFor(ev);
    if (target) setDragOver(target);
  }

  function onDragLeave(ev) {
    const target = dropTargetFor(ev);
    if (target && target === dragOverEl
      && (!ev.relatedTarget || !target.contains(ev.relatedTarget))) clearDragOver();
  }

  function onDrop(ev) {
    if (!dragState) return;
    ev.preventDefault();
    ev.stopPropagation();
    stopAutoScroll();
    const target = dropTargetFor(ev);
    if (!target) return;
    const { item, kind, providerId } = dragState;
    placeByPointer(item, target, ev);
    const ids = dragOrder(item, kind);
    clearDragOver();
    item.classList.remove("dragging");
    persistDragOrder(kind, providerId, ids);
  }

  function onDragEnd() {
    stopAutoScroll();
    if (dragState?.item) dragState.item.classList.remove("dragging");
    clearDragOver();
    dragState = null;
  }

  async function actToggle(providerId, checked) {
    try {
      const data = await post("/providers/" + encodeURIComponent(providerId) + (checked ? "/show" : "/hide"), {});
      toast(data.error || (checked ? "已打开，回到模型菜单了" : "已收起来，模型菜单看不到它了"));
      await refresh();
    } catch (err) {
      toast(err.message, true);
      await refresh();
    }
  }

  listEl.addEventListener("dragstart", onDragStart);
  listEl.addEventListener("dragenter", onDragEnter);
  listEl.addEventListener("dragleave", onDragLeave);
  listEl.addEventListener("dragend", onDragEnd);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop);

  listEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn || btn.dataset.act !== "expand") return;
    const card = btn.closest(".provider-card");
    card.classList.toggle("open");
    btn.textContent = card.classList.contains("open")
      ? "收起模型明细 ▴"
      : "模型明细（" + card.querySelectorAll(".model-row").length + "） ▾";
  });

  listEl.addEventListener("change", async (ev) => {
    const input = ev.target;
    if (input.dataset.act !== "toggle") return;
    const card = input.closest(".provider-card");
    try {
      await actToggle(card.dataset.id, input.checked);
    } catch (err) {
      toast(err.message, true);
      await refresh();
    }
  });

  const updateBtn = $("#check-update");
  const updateResultEl = $("#update-result");
  if (updateBtn) {
    updateBtn.addEventListener("click", async () => {
      if (!updateResultEl) return;
      updateBtn.disabled = true;
      updateResultEl.textContent = "检查更新在路上…";
      try {
        const res = await fetch(api + "/check-update");
        const data = await res.json().catch(() => null);
        if (!data || data.success === false) {
          updateResultEl.innerHTML = (data?.error ? esc(data.error) + "，" : "检查失败，") + '<a href="' + (data?.repoUrl || "https://github.com/moononnn/hanako-moxingxia") + '" target="_blank" rel="noopener">去仓库看看</a>';
        } else if (data.hasUpdate) {
          updateResultEl.innerHTML = "发现新版本 v" + esc(data.latest) + "！当前 v" + esc(data.current) + "，<a href='" + esc(data.downloadUrl || "") + "' target='_blank' rel='noopener'>下载新版本</a>";
        } else {
          updateResultEl.textContent = data.apiDown ? data.message : (data.message || "已是最新版本 ✓");
          if (data.apiDown) {
            updateResultEl.innerHTML += ' <a href="' + esc(data.repoUrl || "") + '" target="_blank" rel="noopener">去仓库看看</a>';
          }
        }
      } catch (err) {
        updateResultEl.textContent = "检查失败：" + (err?.message || String(err));
      } finally {
        updateBtn.disabled = false;
      }
    });
  }

  refresh().catch((err) => {
    statusEl.className = "status-bar err";
    statusEl.innerHTML = '<span class="dot"></span>加载失败：' + esc(err.message || String(err));
  });
})();
`;
}

/** 组装完整页面 HTML */
export function renderPage(ctx, { serverOk, serverError }) {
  const apiBase = `/api/plugins/${encodeURIComponent(ctx.pluginId)}/api`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>模型匣</title>
<style>${CSS}</style>
</head>
<body>
  <div class="page-head">
    <div class="logo">匣</div>
    <h1>模型匣</h1>
  </div>
  <div class="page-sub">拖动供应商，或展开后拖动具体模型，把菜单顺序摆成你顺手的样子</div>
  <div id="status" class="status-bar"><span class="dot"></span>加载中…</div>
  <div id="provider-list"></div>
  <div class="page-foot">
    <a href="https://github.com/moononnn/hanako-moxingxia/issues" target="_blank" rel="noopener">反馈 / 提 issue</a>
    <button id="check-update">检查更新</button>
  </div>
  <div id="update-result" class="update-result"></div>
  <div class="note">收进匣底的供应商只是不再出现在模型菜单，配置、密钥原样保留，随时能打开。</div>
  <div id="toast-wrap" class="toast-wrap"></div>
  <script>
  ${clientJs(apiBase)}
  </script>
</body>
</html>`;
}