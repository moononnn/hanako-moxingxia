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
.rename-btn{border:none;background:none;color:var(--muted);font-size:12px;cursor:pointer;padding:2px 5px;border-radius:6px;flex:none;line-height:1}
.rename-btn:hover{color:var(--primary-deep);background:var(--primary-soft)}
.rename-actions{display:flex;gap:4px;align-items:center;flex:1;min-width:0}
.rename-input{flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-family:inherit;font-size:13px;padding:4px 8px}
.rename-actions button{border:none;background:none;cursor:pointer;font-size:12px;padding:3px 8px;border-radius:6px;flex:none}
.rename-actions .save{color:#2e7d5b;background:var(--primary-soft)}
.rename-actions .cancel{color:var(--muted)}
.rename-actions .cancel:hover{color:var(--ink-strong);background:#efe9dd}
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
/* ── 降级保护面板 ── */
.fw-panel{
  background:var(--card);border-radius:18px;box-shadow:0 2px 12px rgba(0,0,0,.06);
  padding:16px 18px;margin-bottom:16px
}
.fw-panel h2{font-size:16px;color:var(--ink-strong);margin-bottom:4px;display:flex;align-items:center;gap:8px}
.fw-panel .fw-sub{font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.7}
.fw-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.fw-row label{font-size:13px;color:var(--ink);min-width:88px;flex-shrink:0}
/* 两级下拉：供应商 + 模型并排，尽量伸展（不再限死 280px）
   注意：beautifySelect 会把 select 包进 .dd，拉伸规则要作用在 .dd 上，
   否则 .dd 默认 flex:0 1 auto 宽度只跟内容走，下拉就窄成一团 */
.fw-pair{flex:1 1 320px;display:flex;gap:8px;min-width:0}
.fw-pair .dd{flex:1 1 0;min-width:0}
.fw-pair .fw-select{min-width:0}
.fw-select{
  border:1px solid var(--line);border-radius:8px;background:var(--bg);
  color:var(--ink);font-family:inherit;font-size:13px;padding:6px 10px
}
.fw-select:focus{outline:none;border-color:var(--primary)}
.fw-select:disabled{opacity:.6;cursor:not-allowed}
/* 测试结果：固定宽度占位，放在按钮左侧，按钮位置不动（不再贴按钮右边挤它） */
.fw-row-result{margin:0;font-size:12px;color:var(--muted);line-height:1.4;white-space:nowrap;flex-shrink:0;
  width:88px;text-align:left;overflow:hidden;text-overflow:ellipsis}
.fw-row .fw-btn[data-fw-test]{flex-shrink:0}
.fw-btn{
  border:1px solid var(--line);background:var(--card);color:var(--ink);font-family:inherit;
  font-size:12px;padding:6px 14px;border-radius:99px;cursor:pointer
}
.fw-btn:hover{color:var(--primary-deep);border-color:var(--primary)}
.fw-btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}
.fw-btn.primary:hover{background:var(--primary-deep)}
.fw-state{
  border-radius:12px;padding:10px 14px;font-size:13px;margin-top:10px;line-height:1.7;
  background:var(--primary-soft);color:var(--primary-deep)
}
.fw-state.degraded{background:var(--accent-soft);color:#c96a84}
.fw-state .fw-stat{display:flex;gap:18px;flex-wrap:wrap;margin-top:6px}
.fw-stat-item{font-size:12px;color:var(--ink)}
.fw-stat-item b{color:var(--ink-strong);font-size:14px}
.fw-events{margin-top:10px;font-size:12px;color:var(--muted);line-height:1.8;max-height:120px;overflow-y:auto}
.fw-events .ev{padding:2px 0;border-bottom:1px dashed var(--line)}
.fw-events .ev:last-child{border-bottom:none}
.fw-usage{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.fw-usage h3{font-size:13px;color:var(--ink-strong);margin-bottom:8px}
.usage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.usage-cell{
  background:var(--bg);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--muted)
}
.usage-cell b{display:block;font-size:16px;color:var(--ink-strong);margin-top:2px}
.defs{display:none}
*::-webkit-scrollbar{width:8px;height:8px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--bg)}
*::-webkit-scrollbar-thumb:hover{background:var(--primary)}
*{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
/* ── beautify-select 手帐风自定义下拉（plugin-kit 内联） ── */
.dd{position:relative;min-width:0}
.dd-native{display:none}
.dd-trigger{
  width:100%;min-height:38px;display:flex;align-items:center;justify-content:space-between;gap:8px;
  border:1px solid var(--line);border-radius:10px;background:var(--card);
  padding:8px 12px;cursor:pointer;font-family:inherit;font-size:13px;color:var(--ink);
  text-align:left;transition:border-color .16s,background-color .16s,box-shadow .16s
}
.dd-trigger:hover{border-color:var(--accent);background-color:var(--accent-soft)}
.dd.open .dd-trigger{border-color:var(--accent);box-shadow:0 0 0 2px rgba(93,174,142,.16)}
.dd-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dd-caret{width:14px;height:14px;flex-shrink:0;color:var(--primary-deep);transition:transform .18s ease}
.dd.open .dd-caret{transform:rotate(180deg)}
.dd-panel{
  position:absolute;left:0;right:0;top:calc(100% + 5px);z-index:40;
  background:var(--card);border:1px dashed var(--line);border-radius:13px;
  box-shadow:0 12px 28px rgba(69,75,67,.16);padding:5px;max-height:248px;overflow-y:auto;display:none
}
.dd.open .dd-panel{display:block}
.dd-opt{
  display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;
  font-size:13px;color:var(--ink);min-width:0;transition:background-color .12s
}
.dd-opt:hover{background:var(--accent-soft)}
.dd-opt.on{background:var(--accent-soft);color:var(--primary-deep);font-weight:600}
.dd-check{width:15px;flex-shrink:0;color:var(--primary-deep);font-size:12px;visibility:hidden}
.dd-opt.on .dd-check{visibility:visible}
.dd-opt-text{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dd-panel::-webkit-scrollbar{width:8px;height:8px}
.dd-panel::-webkit-scrollbar-track{background:transparent}
.dd-panel::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--card)}
.dd-panel::-webkit-scrollbar-thumb:hover{background:#5dae8e}
.dd-panel{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
.dd-open-card{position:relative;z-index:30}
.dd:has(.dd-native:disabled) .dd-trigger{opacity:.55;cursor:not-allowed}
.dd:has(.dd-native:disabled) .dd-trigger:hover{border-color:var(--line);background:var(--card)}
`;

function clientJs(apiBase) {
  const dragScrollHelper = getDragAutoScrollStep.toString();
  // 页面 URL 上带着宿主给的 surface token，客户端请求要手动带回去（坑 6）。
  // 注意：iframe URL 可能同时有 token（主 API query token）和 pluginSurfaceSession，
  // 只取 pluginSurfaceSession，两个不能拼接（拼接会让服务端拆包失败）。
  return `
/* beautify-select · 手帐风自定义下拉组件（plugin-kit 内联） */
(function(){function escapeText(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function beautifySelect(sel){if(!sel||sel.dataset.ddReady)return;sel.dataset.ddReady="1";
var wrap=document.createElement("div");wrap.className="dd";
var inline=sel.getAttribute("style");if(inline){wrap.setAttribute("style",inline);sel.removeAttribute("style");}
sel.classList.add("dd-native");sel.parentNode.insertBefore(wrap,sel);wrap.appendChild(sel);
var trigger=document.createElement("button");trigger.type="button";trigger.className="dd-trigger";
trigger.innerHTML='<span class="dd-label"></span><svg class="dd-caret" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.25 5.25 7 9l3.75-3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
wrap.appendChild(trigger);
var panel=document.createElement("div");panel.className="dd-panel";wrap.appendChild(panel);
var lifted=null;
function currentLabel(){var i=sel.selectedIndex;if(i>=0&&sel.options[i])return sel.options[i].textContent;return "";}
function updateLabel(){var label=currentLabel();var labelEl=trigger.querySelector(".dd-label");if(labelEl)labelEl.textContent=label;trigger.title=label;}
function renderPanel(){updateLabel();var html="";
for(var i=0;i<sel.options.length;i++){var o=sel.options[i];var on=i===sel.selectedIndex;
html+='<div class="dd-opt'+(on?" on":"")+'" data-i="'+i+'"><span class="dd-check">✓</span><span class="dd-opt-text">'+escapeText(o.textContent)+"</span></div>";}
panel.innerHTML=html;
var cur=panel.querySelector(".dd-opt.on");if(cur){var pt=cur.offsetTop;var ph=cur.offsetHeight;if(pt<panel.scrollTop)panel.scrollTop=pt;else if(pt+ph>panel.scrollTop+panel.clientHeight)panel.scrollTop=pt+ph-panel.clientHeight;}}
function findLiftTarget(){var el=wrap.parentElement;while(el&&el!==document.body){if(el.classList&&(el.classList.contains("card")||(el.getAttribute&&el.getAttribute("data-dd-lift")!==null)))return el;el=el.parentElement;}return null;}
function lift(){if(!lifted)lifted=findLiftTarget();if(lifted)lifted.classList.add("dd-open-card");}
function unlift(){if(lifted){lifted.classList.remove("dd-open-card");lifted=null;}}
function close(){wrap.classList.remove("open");updateLabel();unlift();}
function open(){renderPanel();var all=document.querySelectorAll(".dd.open");for(var i=0;i<all.length;i++){if(all[i]!==wrap&&all[i]._ddClose)all[i]._ddClose();}wrap.classList.add("open");lift();}
wrap._ddClose=close;wrap._ddRefresh=renderPanel;
trigger.addEventListener("click",function(){if(wrap.classList.contains("open"))close();else open();});
panel.addEventListener("click",function(e){var opt=e.target&&e.target.closest?e.target.closest(".dd-opt"):null;if(!opt)return;sel.selectedIndex=Number(opt.dataset.i);close();sel.dispatchEvent(new Event("change",{bubbles:true}));});
document.addEventListener("click",function(e){if(!wrap.contains(e.target))close();});
document.addEventListener("keydown",function(e){if(e.key==="Escape")close();});
var mo=new MutationObserver(function(){renderPanel();setTimeout(renderPanel,0);});
mo.observe(sel,{childList:true,attributes:true,subtree:true});
renderPanel();}
if(typeof window!=="undefined")window.beautifySelect=beautifySelect;if(typeof globalThis!=="undefined")globalThis.beautifySelect=beautifySelect;})();

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
          + '<button class="rename-btn" data-act="rename-model" data-provider-id="' + esc(p.id) + '" data-model-id="' + esc(m.id) + '" title="改显示名（只改名字，不影响调用）">✎</button>'
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
        + '<button class="rename-btn" data-act="rename-provider" data-id="' + esc(p.id) + '" title="改显示名（模型匣内显示，主菜单分组名不变）">✎</button>'
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

  // ── 改名（模型 / 供应商）──
  function enterRename(container, currentName, onSave) {
    const wrap = document.createElement("span");
    wrap.className = "rename-actions";
    const input = document.createElement("input");
    input.className = "rename-input";
    input.value = currentName;
    input.maxLength = 60;
    const save = document.createElement("button");
    save.className = "save";
    save.textContent = "✓";
    save.title = "保存";
    const cancel = document.createElement("button");
    cancel.className = "cancel";
    cancel.textContent = "✕";
    cancel.title = "取消（留空保存=还原默认名）";
    wrap.appendChild(input);
    wrap.appendChild(save);
    wrap.appendChild(cancel);
    container.replaceWith(wrap);
    input.focus();
    input.select();
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      wrap.replaceWith(container);
    };
    save.addEventListener("click", () => {
      const value = input.value.trim();
      close();
      onSave(value);
    });
    cancel.addEventListener("click", close);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") save.click();
      else if (ev.key === "Escape") close();
    });
  }

  async function saveModelRename(providerId, modelId, name) {
    try {
      const data = await post("/providers/" + encodeURIComponent(providerId) + "/models/rename", { modelId, name });
      toast(data.restored
        ? "已还原默认名"
        : (data.applied === false ? (data.warning || "名字已保存，但菜单暂未显示") : "名字更新了，主菜单跟着变了"));
      await refresh();
    } catch (err) {
      toast(err.message, true);
      await refresh();
    }
  }

  async function saveProviderRename(providerId, displayName) {
    try {
      const data = await post("/providers/" + encodeURIComponent(providerId) + "/rename", { displayName });
      toast(data.restored ? "已还原原名" : "供应商名字更新了");
      await refresh();
    } catch (err) {
      toast(err.message, true);
      await refresh();
    }
  }

  function onListClick(ev) {
    const btn = ev.target && typeof ev.target.closest === "function" ? ev.target.closest("[data-act]") : null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "rename-model") {
      const row = btn.closest(".model-row");
      const nameEl = row && row.querySelector(".m-name");
      if (!row || !nameEl) return;
      const currentName = nameEl.childNodes[0]?.nodeValue ? nameEl.childNodes[0].nodeValue.trim() : "";
      enterRename(nameEl, currentName, (value) => saveModelRename(btn.dataset.providerId, btn.dataset.modelId, value));
    } else if (act === "rename-provider") {
      const card = btn.closest(".provider-card");
      const nameEl = card && card.querySelector(".p-name");
      if (!card || !nameEl) return;
      const currentName = nameEl.childNodes[0]?.nodeValue ? nameEl.childNodes[0].nodeValue.trim() : "";
      enterRename(nameEl, currentName, (value) => saveProviderRename(btn.dataset.id, value));
    }
  }

  listEl.addEventListener("click", onListClick);

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

  // ── 降级保护面板 ──
  const fwEl = $("#fw-panel");
  const fwStateEl = $("#fw-state");
  const fwEventsEl = $("#fw-events");
  const fwUsageEl = $("#fw-usage");

  async function refreshFw() {
    if (!fwEl) return;
    const res = await fetch(api + "/failwatch/status" + qs, { signal: AbortSignal.timeout(8000) });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) return;

    // 状态区：切换后保持备用，恢复动作只由用户点击完成。
    if (fwStateEl) {
      const active = Array.isArray(data.activeSlots) ? data.activeSlots : [];
      const labels = { utility: "小工具", utility_large: "大工具", vision: "识图" };
      const activeText = active.map((key) => labels[key] || key).join("、");
      const failed = active.filter((key) => data.slots?.[key]?.mode === "backup-failed");
      const failedText = failed.map((key) => labels[key] || key).join("、");
      const cls = active.length > 0 ? "fw-state degraded" : "fw-state";
      const degradeInfo = failed.length > 0
        ? failedText + "备用模型也在失败，请手动处理"
        : active.length > 0
          ? activeText + "模型正在使用备用，保持到你手动切回"
          : (data.enabled ? "保护已开启，备用模型就位" : "尚未配置备用模型，自动切换未启用");
      const cappedTip = (data.thinkingCapped || 0) > 0
        ? '<div class="fw-capped">⚙️ 深度思考模型有 ' + (data.thinkingCapped || 0) + ' 次只思考没输出正文，已忽略，不当成模型故障</div>'
        : "";
      const configured = data.backup
        ? ["utility", "utility_large", "vision"].filter((key) => data.backup[key]).map((key) => labels[key] + "：" + data.backup[key]).join("；")
        : "";
      fwStateEl.className = cls;
      fwStateEl.innerHTML = '<div>' + esc(degradeInfo) + '</div>'
        + '<div class="fw-stat">'
        + '<span class="fw-stat-item">当前失败累计 <b>' + (data.consecutiveFailures || 0) + '</b> 次</span>'
        + '<span class="fw-stat-item">明确故障立即切换，临时波动连续 2 次切换</span>'
        + (configured ? '<span class="fw-stat-item">备用 <b>' + esc(configured) + '</b></span>' : '')
        + '</div>'
        + cappedTip;
    }

    // 事件列表
    if (fwEventsEl) {
      const evs = data.events || [];
      const labels = { utility: "小工具", utility_large: "大工具", vision: "识图" };
      const eventText = (e) => {
        if (e.type === "switch-to-backup") {
          return (labels[e.slot] || e.slot || "模型") + "已切备用：" + (e.reason || "检测到故障");
        }
        if (e.type === "backup-failed") {
          return (labels[e.slot] || e.slot || "模型") + "备用也失败了，请手动处理";
        }
        if (e.type === "manual-takeover") {
          return (labels[e.slot] || e.slot || "模型") + "已由你手动接管";
        }
        if (e.type === "manual-restore") {
          return "已手动切回" + ((e.labels || []).join("、") || "主模型");
        }
        return e.type || "模型状态变化";
      };
      fwEventsEl.innerHTML = evs.length === 0
        ? '<div class="ev">还没有自动切换记录</div>'
        : evs.map((e) => '<div class="ev">' + esc(eventText(e)) + " · " + esc(new Date(e.at).toLocaleString()) + "</div>").join("");
    }

    // 消耗统计
    if (fwUsageEl && data.usage) {
      const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
      const u = data.usage;
      const cells = [
        ["24h 总请求", u.total24h.requests + " 次"],
        ["24h 总 token", fmt(u.total24h.totalTokens)],
        ["工具模型 24h", fmt(u.utility24h.totalTokens)],
        ["插件 24h", fmt(u.plugin24h.totalTokens)],
      ].map(([label, val]) => '<div class="usage-cell">' + esc(label) + '<b>' + esc(val) + '</b></div>').join("");
      fwUsageEl.innerHTML = '<h3>消耗监测（近 24 小时）</h3><div class="usage-grid">' + cells + '</div>';
    }
  }

  const fwSaveBtn = $("#fw-save");

  // 加载 Hana 模型列表，填充小工具 / 大工具 / 识图三个备用槽位
  async function loadFwModels(selected, current) {
    const selects = [$("#fw-util"), $("#fw-util-large"), $("#fw-vision")].filter(Boolean);
    if (selects.length === 0) return;
    const res = await fetch(api + "/failwatch/models" + qs, { signal: AbortSignal.timeout(8000) });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok || !Array.isArray(data.models)) return;
    const sel = selected || {};
    // 每个槽位：供应商下拉 + 模型下拉，两级联动
    const slots = [
      { key: "utility", id: "fw-util", label: "工具模型" },
      { key: "utility_large", id: "fw-util-large", label: "大工具模型" },
      { key: "vision", id: "fw-vision", label: "视觉模型" },
    ];
    for (const slot of slots) {
      const providerSel = $("#" + slot.id + "-provider");
      const modelSel = $("#" + slot.id);
      if (!providerSel || !modelSel) continue;
      const cur = sel[slot.key] || "";
      // 识图备用只列能看图的模型；两个工具备用列全部文本模型
      const list = (slot.id === "fw-vision") ? data.models.filter((m) => m.vision) : data.models;
      // 先按供应商聚合（保序去重），供应商下拉第一项是空档
      const providers = [];
      const seen = new Set();
      for (const m of list) {
        const p = m.provider || "";
        if (p && !seen.has(p)) { seen.add(p); providers.push(p); }
      }
      const emptyText = "— 不设置备用 —";
      const curProvider = cur.split("/")[0] || "";
      // 供应商下拉：空档 + 各家供应商
      providerSel.innerHTML = "<option value=''>" + esc(emptyText) + "</option>"
        + providers.map((p) => "<option value='" + esc(p) + "'" + (p === curProvider ? " selected" : "") + ">" + esc(p) + "</option>").join("");
      // 模型下拉：跟随当前供应商，占位提示 + 该家模型
      const slotModels = curProvider ? list.filter((m) => (m.provider || "") === curProvider) : [];
      modelSel.innerHTML = slotModels.length === 0
        ? "<option value=''>" + (curProvider ? "这家没有可用模型" : "先选供应商") + "</option>"
        : "<option value=''>" + (curProvider ? "选一个模型" : "先选供应商") + "</option>"
          + slotModels.map((m) => {
            const v = m.ref || (m.provider ? m.provider + "/" + m.id : m.id);
            return "<option value='" + esc(v) + "'" + (v === cur ? " selected" : "") + ">" + esc(m.name) + "</option>";
          }).join("");
      modelSel.disabled = !curProvider;
      // 供应商切换 → 重建模型下拉
      providerSel.onchange = () => {
        const p = providerSel.value;
        const slotModels2 = p ? list.filter((m) => (m.provider || "") === p) : [];
        modelSel.innerHTML = slotModels2.length === 0
          ? "<option value=''>" + (p ? "这家没有可用模型" : "先选供应商") + "</option>"
          : "<option value=''>" + (p ? "选一个模型" : "先选供应商") + "</option>"
            + slotModels2.map((m) => {
              const v = m.ref || (m.provider ? m.provider + "/" + m.id : m.id);
              return "<option value='" + esc(v) + "'>" + esc(m.name) + "</option>";
            }).join("");
        modelSel.disabled = !p;
        if (window.beautifySelect) {
          const pw = providerSel.closest(".dd"); if (pw && pw._ddRefresh) pw._ddRefresh();
          const mw = modelSel.closest(".dd"); if (mw && mw._ddRefresh) mw._ddRefresh();
        }
      };
      // 初始同步 beautify 面板
      if (window.beautifySelect) {
        const pw = providerSel.closest(".dd"); if (pw && pw._ddRefresh) pw._ddRefresh();
        const mw = modelSel.closest(".dd"); if (mw && mw._ddRefresh) mw._ddRefresh();
      }
    }
    return data;
  }

  if (fwSaveBtn) {
    fwSaveBtn.addEventListener("click", async () => {
      const body = {};
      const utilInput = $("#fw-util");
      const utilLargeInput = $("#fw-util-large");
      const visionInput = $("#fw-vision");
      if (utilInput && utilInput.value) body.utility = utilInput.value;
      if (utilLargeInput && utilLargeInput.value) body.utility_large = utilLargeInput.value;
      if (visionInput && visionInput.value) body.vision = visionInput.value;
      if (Object.keys(body).length === 0) {
        toast("至少选一个备用模型", true);
        return;
      }
      try {
        await post("/failwatch/backup", body);
        toast("备用模型已保存，降级保护开启");
        await refreshFw();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // 每个槽位独立测试按钮：点哪个测哪个，结果显示在自己行内
  document.querySelectorAll("[data-fw-test]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const selId = btn.dataset.fwTest;
      const sel = $("#" + selId);
      const resultEl = $("#fw-result-" + selId.replace("fw-", ""));
      const label = selId === "fw-util" ? "小工具" : selId === "fw-util-large" ? "大工具" : "识图";
      const ref = sel && sel.value ? sel.value.trim() : "";
      if (!ref) {
        toast("先选一个模型再测试", true);
        return;
      }
      btn.disabled = true;
      if (resultEl) resultEl.textContent = "正在测试…";
      try {
        const res = await fetch(api + "/failwatch/test" + qs, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ ref }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
          if (resultEl) resultEl.textContent = "✓ 连通正常";
          toast(label + "模型可用，可以放心设成备用");
        } else {
          if (resultEl) resultEl.textContent = "✗ " + (data.error || "测试失败");
          toast((data.error || "测试失败"), true);
        }
      } catch (err) {
        if (resultEl) resultEl.textContent = "✗ " + (err?.message || String(err));
        toast(err?.message || "测试失败", true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  const fwResetBtn = $("#fw-reset");
  if (fwResetBtn) {
    fwResetBtn.addEventListener("click", async () => {
      try {
        const data = await post("/failwatch/reset", {});
        toast(data.message || (data.restored ? "已手动切回主模型" : "当前没在降级态，不用恢复"));
        await refreshFw();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // 手帐风自定义下拉：所有 fw-select 走 beautify-select（含供应商/模型两级联动）
  if (window.beautifySelect) {
    document.querySelectorAll("select.fw-select").forEach((sel) => beautifySelect(sel));
  }

  refresh().catch((err) => {
    statusEl.className = "status-bar err";
    statusEl.innerHTML = '<span class="dot"></span>加载失败：' + esc(err.message || String(err));
  });
  refreshFw().catch(() => {});
  // 等 status 拿到 backup 再填下拉（refreshFw 里也有 backup，这里直接拉一次）
  (async () => {
    try {
      const res = await fetch(api + "/failwatch/status" + qs, { signal: AbortSignal.timeout(8000) });
      const data = await res.json().catch(() => null);
      await loadFwModels(data?.ok ? data.backup || {} : {});
    } catch {}
  })();
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
  <div class="fw-panel" id="fw-panel">
    <h2>🛟 备用模型自动切换</h2>
    <div class="fw-sub">小工具、大工具或识图模型遇到明确故障会立刻切换；网络、超时等临时波动连续两次才切换。切过去后会一直使用备用模型，直到你点“手动切回主模型”。如果装了提个醒，切换时会弹一条说明。</div>
    <div class="fw-row">
      <label>工具模型</label>
      <div class="fw-pair">
        <select class="fw-select" id="fw-util-provider"><option value="">— 不设置备用 —</option></select>
        <select class="fw-select" id="fw-util" disabled><option value="">先选供应商</option></select>
      </div>
      <span class="fw-row-result" id="fw-result-util"></span>
      <button class="fw-btn" data-fw-test="fw-util">测试</button>
    </div>
    <div class="fw-row">
      <label>大工具模型</label>
      <div class="fw-pair">
        <select class="fw-select" id="fw-util-large-provider"><option value="">— 不设置备用 —</option></select>
        <select class="fw-select" id="fw-util-large" disabled><option value="">先选供应商</option></select>
      </div>
      <span class="fw-row-result" id="fw-result-util-large"></span>
      <button class="fw-btn" data-fw-test="fw-util-large">测试</button>
    </div>
    <div class="fw-row">
      <label>识图模型</label>
      <div class="fw-pair">
        <select class="fw-select" id="fw-vision-provider"><option value="">— 不设置备用 —</option></select>
        <select class="fw-select" id="fw-vision" disabled><option value="">先选供应商</option></select>
      </div>
      <span class="fw-row-result" id="fw-result-vision"></span>
      <button class="fw-btn" data-fw-test="fw-vision">测试</button>
    </div>
    <div class="fw-row">
      <button class="fw-btn primary" id="fw-save">保存备用模型</button>
      <button class="fw-btn" id="fw-reset">手动切回主模型</button>
    </div>
    <div id="fw-state" class="fw-state">保护未启用</div>
    <div id="fw-events" class="fw-events"></div>
    <div id="fw-usage" class="fw-usage"></div>
  </div>
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