/**
 * Easy CN Prompt — 前端扩展（最小 demo / M1.1）
 *
 * 本 demo 的目标是验证一个技术风险点（见开发文档 §6.2）：
 *   把 ComfyUI 原生多行 STRING widget 隐藏，在上面叠加自绘 contenteditable 编辑器，
 *   编辑器序列化结果写回 widget.value，并保证工作流能正常保存/执行。
 *
 * demo 覆盖：文本框、搜索 API、智能提示框、词块渲染、逗号成块、删除/禁用/tooltip。
 */

import { app } from "../../scripts/app.js";

const EXT = "easy_cn_prompt";
const LOG = (...a) => console.log("[EasyCNPrompt]", ...a);

const STYLE = `
.ecp-wrap { display:flex; flex-direction:column; width:100%; height:100%; box-sizing:border-box; }

/* 顶部工具条 */
.ecp-bar { display:flex; align-items:center; gap:6px; padding:0 0 6px; flex:0 0 auto; }
.ecp-bar-btn {
  background:#33415a; color:#dbe6f5; border:1px solid #46587a; border-radius:4px;
  padding:3px 10px; font-size:11.5px; cursor:pointer; font-family:inherit;
}
.ecp-bar-btn:hover { background:#3f5271; border-color:#5b78a8; }
.ecp-bar-btn:active { background:#2b3650; }
.ecp-bar-ghost { background:transparent; color:#8b93a3; border-color:#3a3a44; }
/* 不可用的工具条按钮（如未设默认词库时的「一键收录」） */
.ecp-bar-btn:disabled, .ecp-bar-btn.ecp-bar-disabled {
  opacity:.4; cursor:not-allowed; filter:grayscale(.7);
}
.ecp-bar-btn:disabled:hover, .ecp-bar-btn.ecp-bar-disabled:hover {
  background:#33415a; border-color:#46587a;
}
.ecp-bar-ghost:hover { background:#2a2a33; color:#c5ccd8; }
.ecp-bar-info { margin-left:auto; color:#7b8496; font-size:11px; white-space:nowrap; }

.ecp-editor {
  flex:1 1 auto; min-height:96px; overflow-y:auto; outline:none;
  background:#1a1a1e; color:#e8e8ec; border:1px solid #3a3a44; border-radius:6px;
  padding:8px 10px; font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;
  font-size:13px; line-height:1.9; white-space:pre-wrap; word-break:break-word;
  user-select:text; cursor:text;
}
.ecp-editor:focus { border-color:#5b8dd6; }
.ecp-editor:empty::before { content:attr(data-placeholder); color:#66666f; pointer-events:none; }

.ecp-chunk {
  display:inline-block; position:relative; margin:0 1px; padding:0 6px;
  border-radius:4px; cursor:pointer; user-select:none; white-space:nowrap;
  border:1px solid transparent; line-height:1.6; vertical-align:baseline;
}
.ecp-chunk.ecp-disabled { opacity:.45; text-decoration:line-through; }
/* ★ 视觉体系：外框 = 收录状态，填充 = 类型 ★
     未收录 → 橙色虚线外框（.ecp-unlisted）
     已收录 → 无外框
   填充色始终由类型决定（见 paintChunk）。 */
.ecp-chunk.ecp-unlisted { border-color:#d6a24a; border-style:dashed; }
.ecp-chunk .ecp-del {
  display:none; position:absolute; top:-6px; right:-6px; width:14px; height:14px;
  line-height:12px; text-align:center; border-radius:50%; background:#d64545;
  color:#fff; font-size:11px; cursor:pointer; border:none; padding:0;
}
.ecp-chunk:hover .ecp-del { display:block; }

/* ---- 拖动排序 ---- */
/* 被拖动的原词块：留在原位但淡化，作为"挖空"的视觉提示 */
.ecp-chunk.ecp-dragging { opacity:.28; }

/* 跟随鼠标的半透明幽灵 */
.ecp-drag-ghost {
  position:fixed; z-index:100003; pointer-events:none;
  display:flex; align-items:center; justify-content:center;
  box-sizing:border-box; padding:0 6px; border-radius:4px;
  font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif; font-size:13px;
  opacity:.75; transform:scale(1.04);
  box-shadow:0 6px 18px rgba(0,0,0,.55);
  border:1px dashed rgba(255,255,255,.55);
}

/* 虚线插入位指示器 */
.ecp-drop-marker {
  display:inline-block; width:3px; height:1.55em;
  margin:0 2px; border-radius:2px; vertical-align:middle;
  background:#5b8dd6; box-shadow:0 0 6px #5b8dd6;
  animation:ecp-marker-pulse .8s ease-in-out infinite;
}
@keyframes ecp-marker-pulse {
  0%,100% { opacity:1; }
  50%     { opacity:.45; }
}
/* 纵向列表（词库行）用的插入线：横向细线 */
.ecp-drop-marker.ecp-drop-marker-v {
  display:block; width:auto; height:3px; margin:3px 0;
  vertical-align:baseline;
}

/* 拖动进行中：全局禁止选中，避免拖出蓝色选区 */
body.ecp-dragging-active { user-select:none; }
body.ecp-dragging-active .ecp-editor { cursor:grabbing; }

.ecp-inline-input {
  background:#111116; color:#e8e8ec; border:1px solid #5b8dd6; border-radius:4px;
  padding:1px 5px; font-size:13px; font-family:inherit; outline:none; margin:0 1px;
}

.ecp-ac {
  position:fixed; z-index:99999; max-height:280px; overflow-y:auto;
  background:#232328; border:1px solid #4a4a55; border-radius:6px;
  box-shadow:0 8px 24px rgba(0,0,0,.5); font-size:12px; min-width:300px;
}
.ecp-ac-item { display:flex; gap:10px; align-items:baseline; padding:4px 8px; cursor:pointer; }
.ecp-ac-item:hover, .ecp-ac-item.ecp-sel { background:#3a4a63; }
.ecp-ac-cn { flex:0 0 130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ecp-ac-cn.ecp-nocn { color:#8888a0; font-style:italic; }
.ecp-ac-en { flex:1 1 auto; color:#8fb8e8; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ecp-ac-cnt { flex:0 0 auto; color:#888893; font-size:11px; }
.ecp-ac-empty { background:#2c2c22; }
.ecp-ac-empty .ecp-ac-en { color:#d6a24a; }

/* 词块操作菜单 */
.ecp-menu {
  position:fixed; z-index:100001; min-width:190px; padding:4px;
  background:#232328; border:1px solid #4a4a55; border-radius:6px;
  box-shadow:0 8px 24px rgba(0,0,0,.55); font-size:12.5px; color:#e0e0e6;
}
.ecp-menu-head {
  padding:4px 8px 6px; color:#8fb8e8; font-family:monospace;
  border-bottom:1px solid #3a3a44; margin-bottom:4px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px;
}
.ecp-menu-item {
  display:flex; align-items:center; gap:8px; padding:5px 8px;
  border-radius:4px; cursor:pointer; white-space:nowrap;
}
.ecp-menu-item:hover { background:#3a4a63; }
.ecp-menu-item.ecp-menu-cur { color:#8fb8e8; }
.ecp-menu-item.ecp-menu-danger { color:#e08a8a; }
.ecp-menu-hint {
  margin-left:auto; color:#8888a0; font-size:11px; font-family:monospace;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:150px;
}
.ecp-menu-sep { height:1px; background:#3a3a44; margin:4px 2px; }

/* ---- 子菜单 ---- */
.ecp-menu-item.ecp-has-sub { position:relative; }
.ecp-menu-arrow { margin-left:auto; padding-left:8px; opacity:.7; }
.ecp-submenu { max-height:320px; overflow-y:auto; }

/* ---- 词库管理弹窗 ---- */
.ecp-modal-mask {
  position:fixed; inset:0; background:rgba(0,0,0,.55);
  display:flex; align-items:center; justify-content:center; z-index:10002;
}
.ecp-modal {
  width:min(760px, 92vw); max-height:80vh; display:flex; flex-direction:column;
  background:#252a33; color:#e6e9ee; border:1px solid #3a4150;
  border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,.5); font-size:13px;
}
.ecp-modal-head {
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 14px; border-bottom:1px solid #3a4150; font-size:15px; font-weight:600;
}
.ecp-modal-close {
  background:none; border:none; color:#9aa4b2; font-size:20px;
  cursor:pointer; line-height:1; padding:0 4px;
}
.ecp-modal-close:hover { color:#fff; }
.ecp-modal-tip { padding:8px 14px; color:#8f9aab; font-size:12px; }
.ecp-modal-tip b { color:#e0b24a; }
.ecp-dict-list { flex:1; overflow-y:auto; padding:0 10px 10px; }
.ecp-dict-row {
  display:flex; align-items:center; gap:8px; padding:8px 10px;
  border:1px solid #333a47; border-radius:6px; margin-bottom:6px; background:#2b313b;
}
.ecp-dict-row.ecp-dict-off { opacity:.5; }
.ecp-dict-num {
  width:22px; height:22px; line-height:22px; text-align:center;
  background:#39414f; border-radius:50%; font-size:11px; color:#9fb6d6; flex:0 0 auto;
}
.ecp-dict-name { flex:1; font-weight:600; display:flex; align-items:center; gap:6px; }
.ecp-dict-builtin {
  font-size:10px; padding:1px 5px; border-radius:3px;
  background:#4a3f2a; color:#d8b46a; font-weight:400;
}
.ecp-dict-count { color:#8f9aab; font-size:12px; flex:0 0 auto; }
.ecp-dict-btn {
  background:#39414f; border:1px solid #48505f; color:#cfd6e0;
  border-radius:4px; padding:3px 8px; font-size:12px; cursor:pointer;
}
.ecp-dict-btn:hover:not(:disabled) { background:#465061; }
.ecp-dict-btn:disabled { opacity:.35; cursor:not-allowed; }
.ecp-dict-btn.ecp-dict-on { background:#2f5d3a; border-color:#3d7a4a; color:#c8f0d2; }
/* 默认词库（一键收录的目标） */
.ecp-dict-btn.ecp-dict-default { background:#5a4a1f; border-color:#8a7429; color:#f0dfa0; }
.ecp-dict-btn.ecp-dict-danger { background:#5a2f2f; border-color:#7a3d3d; color:#f0c8c8; }
.ecp-modal-foot {
  display:flex; gap:8px; padding:10px 14px; border-top:1px solid #3a4150;
}

/* ---- 设置页面：分区 ---- */
.ecp-settings-body { overflow-y:auto; padding:4px 0 8px; }
.ecp-sec { padding:10px 14px 4px; }
.ecp-sec + .ecp-sec { border-top:1px solid #3a4150; margin-top:6px; }
.ecp-sec-title {
  margin:0 0 6px; font-size:13px; font-weight:600; color:#cfd6e0;
}
.ecp-sec-foot { display:flex; gap:8px; padding:8px 0 4px; }

/* ---- 置信度滑块 ---- */
.ecp-conf-row {
  display:flex; align-items:center; gap:12px; padding:6px 2px;
}
.ecp-conf-range {
  flex:1; height:4px; -webkit-appearance:none; appearance:none;
  background:#39414f; border-radius:2px; outline:none; cursor:pointer;
}
.ecp-conf-range::-webkit-slider-thumb {
  -webkit-appearance:none; appearance:none;
  width:16px; height:16px; border-radius:50%;
  background:#5b8dd6; border:2px solid #cfd6e0; cursor:grab;
}
.ecp-conf-range::-moz-range-thumb {
  width:16px; height:16px; border-radius:50%;
  background:#5b8dd6; border:2px solid #cfd6e0; cursor:grab;
}
.ecp-conf-val {
  min-width:44px; text-align:right; font-variant-numeric:tabular-nums;
  color:#9fb6d6; font-size:13px; font-weight:600;
}

/* ---- 类型顺序：渲染成「词块」样式，横向自动换行 ---- */
.ecp-catorder-list {
  display:flex; flex-wrap:wrap; gap:6px; align-content:flex-start;
  padding:8px; min-height:60px;
  border:1px solid #333a47; border-radius:6px; background:#242a34;
}
.ecp-catorder-chip {
  display:inline-flex; align-items:center; gap:4px;
  padding:3px 10px; border-radius:4px;
  font-size:12.5px; line-height:1.7; white-space:nowrap;
  cursor:grab; user-select:none;
  border:1px solid transparent;
  transition:transform .08s, box-shadow .08s;
}
.ecp-catorder-chip:hover { box-shadow:0 0 0 2px rgba(255,255,255,.18); }
.ecp-catorder-chip.ecp-catorder-locked { cursor:not-allowed; opacity:.72; }
.ecp-catorder-chip.ecp-dragging { opacity:.28; }
.ecp-catorder-lock { font-size:10px; opacity:.85; }

/* 拖拽时跟着鼠标的幽灵 */
.ecp-drag-ghost {
  position:fixed; z-index:10010; pointer-events:none;
  opacity:.85; transform:translate(-6px,-6px);
  box-shadow:0 6px 18px rgba(0,0,0,.45); border-radius:4px;
}

/* 词库行：拖动把手 */
.ecp-drag-grip {
  color:#7b8496; font-size:14px; cursor:grab; padding:0 2px 0 0;
  user-select:none; flex:0 0 auto;
}
.ecp-dict-row { cursor:default; }

/* ---- 内联输入 ---- */
.ecp-inline-mask {
  position:fixed; inset:0; background:rgba(0,0,0,.45);
  display:flex; align-items:center; justify-content:center; z-index:10005;
}
.ecp-inline-box {
  background:#252a33; border:1px solid #3a4150; border-radius:6px;
  padding:14px 16px; min-width:300px; color:#e6e9ee;
}
.ecp-inline-label { margin-bottom:8px; font-size:13px; }
.ecp-inline-input {
  width:100%; box-sizing:border-box; padding:6px 8px; border-radius:4px;
  border:1px solid #48505f; background:#1e222a; color:#e6e9ee; font-size:13px;
}
.ecp-inline-row { display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
.ecp-dot { width:9px; height:9px; border-radius:50%; display:inline-block; flex:0 0 auto; }

/* 带权重的词块：加一圈虚点边框以示区分 */
.ecp-chunk.ecp-weighted { border-color:#d6c24a; border-style:dotted; }

/* 权重设置面板 */
.ecp-weight { min-width:260px; padding:8px; }
.ecp-weight-row { display:flex; gap:8px; align-items:center; margin:6px 0; }
.ecp-weight-input {
  width:66px; background:#111116; color:#e8e8ec; border:1px solid #4a4a55;
  border-radius:4px; padding:3px 6px; font-size:12.5px; font-family:monospace; outline:none;
}
.ecp-weight-input:focus { border-color:#5b8dd6; }
.ecp-weight-slider { flex:1 1 auto; accent-color:#5b8dd6; }
.ecp-weight-quick { display:flex; flex-wrap:wrap; gap:4px; margin:6px 0; }
.ecp-weight-chip {
  background:#33415a; color:#dbe6f5; border:1px solid #46587a; border-radius:4px;
  padding:2px 7px; font-size:11px; cursor:pointer; font-family:monospace;
}
.ecp-weight-chip:hover { background:#3f5271; border-color:#5b78a8; }
.ecp-weight-actions { display:flex; gap:6px; margin-top:8px; }
.ecp-weight-btn {
  flex:1 1 auto; background:#33415a; color:#dbe6f5; border:1px solid #46587a;
  border-radius:4px; padding:4px 10px; font-size:12px; cursor:pointer;
}
.ecp-weight-btn:hover { background:#3f5271; }
.ecp-weight-ok { background:#2f5d43; border-color:#3f7a56; }
.ecp-weight-ok:hover { background:#3a7152; }
.ecp-weight-clear { background:transparent; color:#9aa3b3; border-color:#3a3a44; }

/* 轻提示 */
.ecp-toast {
  position:fixed; left:50%; bottom:36px; transform:translateX(-50%);
  z-index:100002; background:#2c3a4a; color:#e8f2fb; padding:8px 16px;
  border-radius:6px; font-size:12.5px; display:none;
  box-shadow:0 6px 20px rgba(0,0,0,.5); border:1px solid #4a5a6a;
}
.ecp-toast.ecp-toast-err { background:#4a2c2c; border-color:#6a4a4a; color:#fbecec; }

.ecp-tip {
  position:fixed; z-index:100000; background:#111116; color:#ddd;
  border:1px solid #4a4a55; border-radius:6px; padding:6px 9px;
  font-size:11.5px; line-height:1.7; pointer-events:none; max-width:320px;
}
.ecp-tip b { color:#8fb8e8; font-family:monospace; font-weight:600; }
.ecp-tip .ecp-tip-k { color:#8888a0; display:inline-block; min-width:38px; }
`;

let _styleInjected = false;
function injectStyle() {
  if (_styleInjected) return;
  const el = document.createElement("style");
  el.textContent = STYLE;
  document.head.appendChild(el);
  _styleInjected = true;
}

/* ------------------------------------------------------------------ */
/* 后端 API                                                            */
/* ------------------------------------------------------------------ */

// 注意：不能用 api.fetchApi —— 它会给路径加上 `/api` 前缀，
// 而自定义路由是挂在根路径下的（与 PreviewBridge 等插件一致）。
async function apiGet(path) {
  const r = await fetch(`/${EXT}${path}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function apiSearch(q, limit = 30) {
  return apiGet(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

async function apiLookup(params) {
  return apiGet(`/lookup?${new URLSearchParams(params).toString()}`);
}

async function apiStatus() {
  return apiGet(`/status`);
}

/* ------------------------------------------------------------------ */
/* 序列化 / 反序列化                                                    */
/* ------------------------------------------------------------------ */

// 21 类配色（与 分类体系.md 一致）
const CATEGORY_STYLE = {
  0:  { bg: "#5a5f66", fg: "#eef0f2" },   // 其他
  1:  { bg: "#8a3636", fg: "#fbecec" },   // 艺术家
  2:  { bg: "#7a5fb0", fg: "#f2ecfb" },   // 风格
  3:  { bg: "#6a4a8a", fg: "#f2ecfb" },   // 版权/作品
  4:  { bg: "#3d7a4a", fg: "#ecfbef" },   // 角色
  5:  { bg: "#b8860b", fg: "#fdf6e3" },   // 质量词
  6:  { bg: "#c06a9a", fg: "#fdeef5" },   // 头饰
  7:  { bg: "#a8622c", fg: "#fbeee6" },   // 头发
  8:  { bg: "#2f7fb5", fg: "#e8f4fb" },   // 眼睛
  9:  { bg: "#b58a3a", fg: "#fbf4e3" },   // 耳朵
  10: { bg: "#c25b5b", fg: "#fbecec" },   // 表情
  11: { bg: "#4a8a86", fg: "#e6f5f4" },   // 姿势
  12: { bg: "#4a7a3a", fg: "#ecf5e6" },   // 背景
  13: { bg: "#6b6b8a", fg: "#eeeff5" },   // 形式
  14: { bg: "#3a6ea5", fg: "#e8f0fa" },   // 镜头
  15: { bg: "#5a8ab5", fg: "#eaf2fa" },   // 视角
  16: { bg: "#9a6a3a", fg: "#f8efe6" },   // 画面效果
  17: { bg: "#5566a0", fg: "#eaedf8" },   // 服装
  18: { bg: "#b0784a", fg: "#faf0e8" },   // 配饰
  19: { bg: "#7a7a5a", fg: "#f2f2ea" },   // 道具
  20: { bg: "#a06a6a", fg: "#f8ecec" },   // 身体特征
  21: { bg: "#8a8a3a", fg: "#f6f6e0" },   // 待确认（机器分类待复核）
};
const CATEGORY_FALLBACK = { bg: "#5a5f66", fg: "#eef0f2" };
// 自定义词库 / 未收录词的颜色
const CATEGORY_CUSTOM = { bg: "#8a6a2b", fg: "#fbf5e8" };

/**
 * 把任意来源的剪贴板内容归一成**纯文本**。
 *
 * 为什么需要：从网页/Word/富文本编辑器复制时，剪贴板里同时有
 * text/html 和 text/plain，浏览器默认会按 HTML 插入 ——
 * 结果是编辑器里混进 <span>、<b>、<div> 等标签，或保留换行/缩进/不间断空格，
 * 既污染词块解析，也让序列化结果变脏。
 *
 * 这里只保留纯文本，并做必要清洗：
 *   · \r\n / \r  → \n
 *   · 不间断空格 \u00A0、零宽字符 → 普通空格 / 删除
 *   · 折叠多余空白（连续空格、制表符）
 *   · 去掉首尾空白
 *
 * @param {DataTransfer} dt 剪贴板数据
 * @returns {string} 规范化后的纯文本
 */
function readClipboardText(dt) {
  if (!dt) return "";

  let text = "";

  // ① 优先 text/plain —— 它天然是纯文本
  try {
    text = dt.getData("text/plain") || "";
  } catch (_) {
    text = "";
  }

  // ② 有些应用只给 text/html（或 text/plain 为空），
  //    这时从 HTML 里**抽取纯文本**，而不是把 HTML 插进去。
  if (!text.trim()) {
    let html = "";
    try {
      html = dt.getData("text/html") || "";
    } catch (_) {
      html = "";
    }
    if (html) {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      // 块级元素之间补换行，避免 "第一行第二行" 糊成一坨
      tmp.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
      tmp.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6").forEach((el) => {
        el.appendChild(document.createTextNode("\n"));
      });
      text = tmp.textContent || "";
    }
  }

  if (!text) return "";

  // ③ 归一化：换行符、特殊空白、零宽字符
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00A0\u2007\u202F]/g, " ")   // 各种不间断空格
    .replace(/[\u200B-\u200D\uFEFF]/g, "")   // 零宽字符
    .replace(/\t/g, " ")                      // 制表符
    .replace(/[ ]{2,}/g, " ")                  // 折叠连续空格
    .replace(/ *\n */g, "\n")                 // 去掉行首行尾空格
    .replace(/\n{3,}/g, "\n\n")               // 折叠多余空行
    .trim();

  return text;
}

/** 词块显示文本：中文优先，无中文则显示英文；有权重时追加 (1.2) */
function chunkLabel(span) {
  const base = span.dataset.cn || span.dataset.en;
  const w = span.dataset.weight;
  if (w && Math.abs(Number(w) - 1) > 1e-9) {
    return `${base} (${fmtWeight(w)})`;
  }
  return base;
}

/** 权重数字格式化：1.20 -> 1.2 */
function fmtWeight(w) {
  const n = Number(w);
  if (!isFinite(n)) return String(w);
  return String(parseFloat(n.toFixed(4)));
}

/** 重绘词块外观（颜色、禁用态、删除按钮、显示文本） */
function paintChunk(span) {
  const cat = Number(span.dataset.category || 0);

  // ★ 两个维度彼此独立 ★
  //   填充色  ← 类型（category）
  //   外框    ← 收录状态（unlisted）
  //
  // 这样"给未收录的词指定类型"会立刻变色（填充），
  // 而虚线外框仍在 —— 提醒它还没进词库。
  const st = CATEGORY_STYLE[cat] ?? CATEGORY_FALLBACK;
  span.style.background = st.bg;
  span.style.color = st.fg;

  span.classList.toggle("ecp-disabled", !!span.dataset.disabled);
  span.classList.toggle("ecp-unlisted", span.dataset.unlisted === "1");
  span.classList.toggle("ecp-weighted", !!chunkWeight(span));

  const del = span.querySelector(".ecp-del");
  span.textContent = chunkLabel(span);
  if (del) span.appendChild(del);
}

function makeChunkEl({ en, cn, category, disabled, source, unlisted, weight, typed }) {
  const span = document.createElement("span");
  span.className = "ecp-chunk";
  span.contentEditable = "false";
  span.dataset.en = en;
  span.dataset.cn = cn ?? "";
  span.dataset.category = String(category ?? 0);
  span.dataset.source = source || "builtin";
  if (unlisted) span.dataset.unlisted = "1";
  if (typed) span.dataset.typed = "1";
  if (disabled) span.dataset.disabled = "1";
  if (weight != null && Math.abs(Number(weight) - 1) > 1e-9) {
    span.dataset.weight = fmtWeight(weight);
  }

  const del = document.createElement("button");
  del.className = "ecp-del";
  del.textContent = "×";
  del.title = "删除词块";
  del.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeChunkWithComma(span);
  });
  span.appendChild(del);
  paintChunk(span);
  return span;
}

/** 取词块权重；未设置或等于 1 时返回 null */
function chunkWeight(span) {
  const w = span.dataset.weight;
  if (!w) return null;
  const n = Number(w);
  if (!isFinite(n) || Math.abs(n - 1) < 1e-9) return null;
  return n;
}

/** 词块 → <chunk>payload</chunk>（含它自带的英文逗号） */
function serializeChunk(span) {
  const parts = [span.dataset.en];
  if (span.dataset.cn) parts.push(`cn=${span.dataset.cn.replace(/\|/g, "\\|")}`);
  if (span.dataset.category && span.dataset.category !== "0") {
    parts.push(`cat=${span.dataset.category}`);
  }
  if (span.dataset.source && span.dataset.source !== "builtin") {
    parts.push(`src=${span.dataset.source}`);
  }
  if (span.dataset.weight) parts.push(`w=${span.dataset.weight}`);
  if (span.dataset.unlisted === "1") {
    parts.push("unlisted");
    // 注：早期的 typed 标记已废弃 —— 现在填充色永远按类型，
    // 不再需要单独记录"是否手动指定过类型"。读取仍兼容（见 deserializeInto）。
  }
  if (span.dataset.disabled) parts.push("disabled");
  return `<chunk>${parts.join("|")}</chunk>,`;
}

function serializeEditor(editor) {
  let out = "";
  for (const node of editor.childNodes) {
    // 剔除零宽空格锚点：它只用于给输入法/光标提供锚定，不应进入输出
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent.replace(/\u200B/g, "");
    else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains("ecp-chunk")) out += serializeChunk(node);
      else if (node.tagName === "BR") out += "\n";
      else out += node.textContent;
    }
  }
  // 浏览器删除后会留下 BR（序列化成 "\n"），它不该进入提示词：
  //   · 完全没有词块时，只剩空白 → 归一为空串
  //   · 有词块时，清掉多余的换行与首尾空白
  //     （编辑器里换行本身不是有效分隔，标签之间固定用 ", " 连接）
  if (!editor.querySelector(".ecp-chunk")) return out.trim() ? out : "";
  return out.replace(/\n/g, "").trim();
}

const CHUNK_RE = /<chunk>([\s\S]*?)<\/chunk>/g;

function deserializeInto(editor, text) {
  editor.textContent = "";
  if (!text) return;
  let pos = 0;
  let m;
  CHUNK_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();

  const pushText = (t) => {
    if (!t) return;
    const lines = t.split("\n");
    lines.forEach((ln, i) => {
      if (i > 0) frag.appendChild(document.createElement("br"));
      if (ln) frag.appendChild(document.createTextNode(ln));
    });
  };

  while ((m = CHUNK_RE.exec(text)) !== null) {
    pushText(text.slice(pos, m.index));
    const raw = m[1];
    const fields = raw.split("|");
    const en = (fields.shift() || "").replace(/\\\|/g, "|").trim();
    let cn = "", disabled = false, source = "builtin", unlisted = false, category = 0, weight = null, typed = false;
    for (const f of fields) {
      if (f === "disabled") disabled = true;
      else if (f === "unlisted") unlisted = true;
      else if (f === "typed") typed = true;
      else if (f.startsWith("cn=")) cn = f.slice(3).replace(/\\\|/g, "|");
      else if (f.startsWith("cat=")) category = Number(f.slice(4)) || 0;
      else if (f.startsWith("w=")) weight = Number(f.slice(2)) || null;
      else if (f === "src=custom") source = "custom";
      else if (f.startsWith("src=")) source = f.slice(4);
    }
    if (en) frag.appendChild(makeChunkEl({ en, cn, category, disabled, source, unlisted, weight, typed }));
    pos = m.index + m[0].length;
    // 标记后紧跟的英文逗号并入词块，不再单独渲染
    if (text[pos] === ",") pos += 1;
  }
  pushText(text.slice(pos));
  editor.appendChild(frag);
  ensureCaretAnchor(editor);
}

/* ------------------------------------------------------------------ */
/* 光标与文本工具                                                       */
/* ------------------------------------------------------------------ */

function getCaretOffset(editor) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(editor);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretOffset(editor, offset) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let acc = 0, node = null;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (acc + len >= offset) {
      const r = document.createRange();
      r.setStart(node, Math.max(0, offset - acc));
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    acc += len;
  }
  setCaretAfterNode(editor, editor.lastChild);
}

/**
 * 把光标放到指定节点的**后面**（同级位置），
 * 而不是放进节点内部。
 * 词块是 contentEditable=false，若把光标塞进它的文本里，
 * 后续读取"光标前的内容"会误读到词块自身的中文，导致提示框乱弹。
 */
function setCaretAfterNode(editor, el) {
  const r = document.createRange();
  if (el && el.parentNode === editor) {
    r.setStartAfter(el);
  } else {
    r.selectNodeContents(editor);
    r.collapse(false);
  }
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * 找出"光标左边紧邻的词块"。
 *
 * 需要处理光标落在不同位置的所有情况：
 *   a) 光标在词块内部的文字里（浏览器允许）
 *   b) 光标在 editor 上、位于某个词块之后
 *   c) 光标在文本节点开头，前一个兄弟是词块
 *   d) 光标在文本节点中间——左边是文字，不该删词块
 * 只有 a/b/c 三种返回词块，d 返回 null（放行给浏览器）。
 */
function chunkBeforeCaret(editor, range) {
  const n = range.startContainer;

  // a) 光标在词块内部
  //    词块是 contenteditable=false 的**原子元素**：无论光标在它内部的哪个偏移，
  //    退格都应删除整个词块。旧版只在 offset===0 时拦截，其余放行给浏览器 ——
  //    而浏览器删除不可编辑元素后会把光标重置到编辑区开头，
  //    这正是"删最后一个词块时光标跳到第一个词块后面"的根因。
  //    触发路径：单击词块（切换禁用）会把光标放进词块内，再按退格就命中此分支。
  if (n.nodeType === Node.TEXT_NODE && caretInsideChunk(n)) {
    let el = n.parentElement;
    while (el && !el.classList?.contains("ecp-chunk")) el = el.parentElement;
    return el || null;
  }

  // b) 光标在 editor 元素上
  //    向左跳过**空白文本节点**再判断 —— 智能提示选中后会在词块后面
  //    插入一个残留文本节点（choose() 里的 after），若只看紧邻的一个
  //    子节点就会误判为"左边不是词块"，放行给浏览器；
  //    而浏览器删掉不可编辑的词块后会把光标重置到编辑区开头。
  if (n === editor) {
    for (let i = range.startOffset - 1; i >= 0; i--) {
      const child = editor.childNodes[i];
      if (!child) continue;
      if (child.nodeType === Node.ELEMENT_NODE && child.classList?.contains("ecp-chunk")) {
        return child;
      }
      // 文本节点：只有内容是空白才继续往左找；遇到实际文字就停（交给浏览器）
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent.replace(/[\u200B\s]/g, "") === "") continue;
        return null;
      }
      // BR 等其他节点：继续往左找
    }
    return null;
  }

  // c) 光标在文本节点开头（或开头只有空白），左邻是词块
  if (n.nodeType === Node.TEXT_NODE
      && n.textContent.slice(0, range.startOffset).replace(/[\u200B\s]/g, "") === "") {
    let prev = n.previousSibling;
    while (prev && prev.nodeType !== Node.ELEMENT_NODE) prev = prev.previousSibling;
    if (prev?.classList?.contains("ecp-chunk")) return prev;
  }

  return null;
}

/** 删除词块前，先算出光标应该落在哪里（词块之前的位置） */
function caretAnchorBefore(chunk) {
  const editor = chunk.parentNode;
  if (!editor) return null;
  const parent = chunk.parentNode;
  const idx = Array.prototype.indexOf.call(parent.childNodes, chunk);
  if (idx <= 0) {
    return { node: parent, offset: 0 };
  }
  const prev = parent.childNodes[idx - 1];
  if (prev.nodeType === Node.TEXT_NODE) {
    return { node: prev, offset: prev.textContent.length };
  }
  return { node: parent, offset: idx };
}

/**
 * 编辑器被删空后，里面没有任何文本节点，输入法与光标都会失去锚点
 * （表现为继续输入时内容落到画布上、像"丢了焦点"）。
 * 这里补一个零宽空格文本节点作为锚点；序列化时会把它剔除。
 */
function ensureCaretAnchor(editor) {
  if (!editor.isConnected) return;
  const hasEditableText = [...editor.childNodes].some(
    (n) => n.nodeType === Node.TEXT_NODE && n.textContent.length > 0
  );
  if (hasEditableText || editor.querySelector(".ecp-chunk")) return;

  // 删空后浏览器常留下一个 BR —— 它序列化成 "\n" 会污染输出，先摘掉
  for (const n of [...editor.childNodes]) {
    if (n.tagName === "BR") n.remove();
  }
  // 补零宽空格作为输入法/光标的锚点（序列化时会剔除）
  const anchor = document.createTextNode("\u200B");
  editor.appendChild(anchor);

  // 关键：把光标放进锚点。
  // 浏览器删掉最后一个内容节点后，选区可能仍指向那个已移除的节点，
  // 此时输入法与按键都会失效（用户感知为"丢了焦点"）。
  const sel = window.getSelection();
  if (!sel) return;
  const r = sel.rangeCount ? sel.getRangeAt(0) : null;
  const inEditor = r && editor.contains(r.startContainer);
  if (!inEditor) {
    const nr = document.createRange();
    nr.setStart(anchor, 0);
    nr.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nr);
  }
}

/** 光标是否位于某个词块内部（含 contenteditable=false 里的子文本节点） */
function caretInsideChunk(node) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el) {
    if (el.classList?.contains("ecp-chunk")) return true;
    el = el.parentElement;
  }
  return false;
}

/** 取光标所在的裸文本节点。
 *  只有光标处于真正的裸文本里才返回，词块内部/边界一律返回 null。 */
function currentTextNode(editor) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const n = range.startContainer;

  // 光标落在元素节点上（例如刚插完词块）——不是裸文本
  if (n.nodeType === Node.ELEMENT_NODE) return null;
  if (n.nodeType !== Node.TEXT_NODE || !editor.contains(n)) return null;

  // 关键①：光标落在词块内部时，读到的是词块的显示文本而不是用户输入。
  // 词块是 contentEditable=false，但浏览器仍可能把光标放进它的文字里，
  // 这正是"回车选完词后提示框又弹出来"的原因。
  if (caretInsideChunk(n)) return null;

  // 关键②：光标处于文本节点开头、且前一个兄弟是词块时，
  // 左侧没有任何"用户正在输入的内容"，不应触发提示。
  if (range.startOffset === 0) {
    const prev = n.previousSibling;
    if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList?.contains("ecp-chunk")) {
      return null;
    }
  }
  return n;
}

/**
 * 取光标左侧的"当前词片段"。
 * 决议 ④：仅英文逗号、中文逗号、换行终止；空格**不**终止。
 */
function currentQuery(editor) {
  const node = currentTextNode(editor);
  if (!node) return "";
  const off = window.getSelection().getRangeAt(0).startOffset;
  const left = node.textContent.slice(0, off);
  const idx = Math.max(
    left.lastIndexOf(","),
    left.lastIndexOf("，"),
    left.lastIndexOf("\n")
  );
  return left.slice(idx + 1).replace(/\u200B/g, "").trim();
}

/** 从文本节点里删掉一段，返回被删掉的字符串 */
function cutRange(node, start, end) {
  const text = node.textContent;
  const removed = text.slice(start, end);
  node.textContent = text.slice(0, start) + text.slice(end);
  try { setCaretOffset(node.parentNode, start); } catch (_) { /* noop */ }
  return removed;
}

/* ------------------------------------------------------------------ */
/* 词块操作                                                            */
/* ------------------------------------------------------------------ */

/**
 * 删除词块。
 * 逗号现在由词块自己携带（序列化时自动补），所以这里只需摘掉词块本身；
 * 但要顺手清理紧随其后可能残留的裸逗号，避免出现孤立的 ",,"。
 */
function removeChunkWithComma(span) {
  const editor = span.parentNode;
  if (!editor) return;
  const next = span.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE && next.textContent.startsWith(",")) {
    next.textContent = next.textContent.slice(1);
    if (!next.textContent) next.remove();
  }
  // 前一个裸文本以逗号结尾时也收一下，避免留下的逗号悬空
  const prev = span.previousSibling;
  if (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent === ",") {
    prev.remove();
  }
  span.remove();
  ensureCaretAnchor(editor);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function toggleDisabled(span) {
  const editor = span.parentNode;
  if (span.dataset.disabled) {
    delete span.dataset.disabled;
    span.classList.remove("ecp-disabled");
  } else {
    span.dataset.disabled = "1";
    span.classList.add("ecp-disabled");
  }
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ------------------------------------------------------------------ */
/* 智能提示框                                                          */
/* ------------------------------------------------------------------ */

class Autocomplete {
  constructor(editor) {
    this.editor = editor;
    this.el = null;
    this.items = [];
    this.sel = 0;
    this.query = "";
    this.timer = null;
    this.composing = false;

    editor.addEventListener("input", () => this.onInput());
    // ★ 必须挂**捕获阶段** ★
    // 编辑器上还有另一个捕获阶段的 keydown（_blockCanvasShortcuts），
    // 它会对 Arrow 键调用 stopPropagation() —— 在捕获阶段调用会把事件
    // 连"目标阶段/冒泡阶段"一起吞掉，于是挂在冒泡阶段的 onKeyDown
    // 永远收不到 → 上下键无法移动候选框。
    // 捕获阶段的监听按注册顺序执行，这里先注册就先处理。
    editor.addEventListener("keydown", (e) => this.onKeyDown(e), true);
    editor.addEventListener("compositionstart", () => { this.composing = true; });
    editor.addEventListener("compositionend", () => {
      this.composing = false;
      this.onInput();
    });
    editor.addEventListener("blur", () => setTimeout(() => this.hide(), 150));

    // 页面/节点滚动时重新跟随光标，而不是直接关掉面板。
    // 注意：必须排除面板**自身**的滚动，否则在候选列表里滚轮一滚就消失。
    this._onScroll = (ev) => {
      if (this.el && ev.target instanceof Node && this.el.contains(ev.target)) return;
      if (!this.el) return;
      requestAnimationFrame(() => this.position());
    };
    window.addEventListener("scroll", this._onScroll, true);
    // 面板内部滚动同样不关闭
    this._onWheelInPanel = (ev) => { if (this.el && this.el.contains(ev.target)) ev.stopPropagation(); };
    window.addEventListener("wheel", this._onWheelInPanel, { capture: true, passive: true });
  }

  onInput() {
    if (this.composing) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 120);
  }

  async refresh() {
    const q = currentQuery(this.editor);
    if (!q) return this.hide();
    if (q === this.query && this.el) return;
    this.query = q;
    try {
      const data = await apiSearch(q, 30);
      if (this.query !== q) return; // 过期响应
      this.items = data.results || [];
      this.sel = 0;
      this.render();
    } catch (e) {
      LOG("search error", e);
      this.hide();
    }
  }

  /**
   * 选中候选后收尾。
   *
   * choose() 会把光标移到新词块后面，此时 currentQuery() 会读到**词块自身的中文**，
   * 于是面板立刻又弹出"第一个词块的提示"。
   * 这里把 query 记成刚插入的词、并撤销挂在队列里的那次 refresh。
   */
  suppressFor(text) {
    clearTimeout(this.timer);
    this.timer = null;
    this.hide();
    this.query = text;   // 抑制同一个词再次触发搜索
  }

  render() {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "ecp-ac";
      document.body.appendChild(this.el);
    }
    this.el.innerHTML = "";

    // 词库里没有匹配项时，仍然保留面板，给一个「按原样成块」的入口，
    // 否则用户会以为功能坏了。
    if (!this.items.length) {
      const row = document.createElement("div");
      row.className = "ecp-ac-item ecp-ac-empty";
      const hint = document.createElement("span");
      hint.className = "ecp-ac-en";
      hint.textContent = `未收录「${this.query}」`;
      const act = document.createElement("span");
      act.className = "ecp-ac-cnt";
      act.textContent = "回车按原样成块";
      row.append(hint, act);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.choose(-1); // -1 = 未收录，按原文成块
      });
      this.el.appendChild(row);
      this.position();
      return;
    }

    this.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "ecp-ac-item" + (i === this.sel ? " ecp-sel" : "");

      const cn = document.createElement("span");
      cn.className = "ecp-ac-cn" + (it.has_cn ? "" : " ecp-nocn");
      cn.textContent = it.has_cn ? it.cn : it.en;
      cn.title = it.has_cn ? it.cn : "（无中文翻译）";

      const en = document.createElement("span");
      en.className = "ecp-ac-en";
      en.textContent = it.en;

      const cnt = document.createElement("span");
      cnt.className = "ecp-ac-cnt";
      cnt.textContent = it.post_count.toLocaleString();

      row.append(cn, en, cnt);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.choose(i);
      });
      this.el.appendChild(row);
    });
    this.position();
  }

  position() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return this.hide();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const box = this.el.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + box.height > window.innerHeight - 8) top = rect.top - box.height - 4;
    let left = rect.left;
    if (left + box.width > window.innerWidth - 8) left = window.innerWidth - box.width - 8;
    this.el.style.top = `${Math.max(4, top)}px`;
    this.el.style.left = `${Math.max(4, left)}px`;
  }

  move(delta) {
    if (!this.el || !this.items.length) return;
    this.sel = (this.sel + delta + this.items.length) % this.items.length;
    [...this.el.children].forEach((c, i) => c.classList.toggle("ecp-sel", i === this.sel));
    this.el.children[this.sel]?.scrollIntoView({ block: "nearest" });
  }

  onKeyDown(e) {
    if (!this.el) return;
    if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); }
    else if (e.key === "Enter" || e.key === "Tab") {
      // 有候选就选中的；没有候选（未收录）则按原文成块
      e.preventDefault();
      this.choose(this.items.length ? this.sel : -1);
    } else if (e.key === "Escape") { this.hide(); }
  }

  /** 选中候选项：用词块替换当前片段。
   *  idx === -1 表示「未收录」，按用户原文成块。 */
  choose(idx) {
    const item = this.items[idx] || null;
    const node = currentTextNode(this.editor);
    if (!node) return this.hide();

    const off = window.getSelection().getRangeAt(0).startOffset;
    const left = node.textContent.slice(0, off);
    const idxSep = Math.max(left.lastIndexOf(","), left.lastIndexOf("，"), left.lastIndexOf("\n"));
    const start = idxSep + 1;

    // item 为 null 表示「未收录」：按用户原文成块，英文=原文，标为 unlisted
    const raw = left.slice(start).trim();
    const chunk = item
      ? makeChunkEl({
          en: item.en,
          cn: item.has_cn ? item.cn : "",
          category: item.category,
          disabled: false,
          source: item.source,
        })
      : makeChunkEl({
          en: raw,
          cn: raw,
          // 未收录的词默认归入「待确认」(21)，方便用「分类待确认」按钮批量处理
          category: 21,
          disabled: false,
          // ⚠️ 不要标成 custom：未收录词**不在**自定义词库里，
          // 标 custom 会让 tooltip 显示"自定义词库"、菜单误给"删除"入口。
          // 用 builtin 作为中性值，靠 unlisted 标记表示"未收录"。
          source: "builtin",
          unlisted: true,
        });

    const before = node.textContent.slice(0, start);
    const after = node.textContent.slice(off);

    // 原地替换：before | chunk | after（逗号由词块序列化时自动带出）
    node.textContent = before;
    node.parentNode.insertBefore(chunk, node.nextSibling);
    if (after) node.parentNode.insertBefore(document.createTextNode(after), chunk.nextSibling);

    // 光标放到词块之后（同级位置），不要塞进词块内部
    setCaretAfterNode(this.editor, chunk);
    // 先抑制，再通知外部同步，避免 choose 后的 input 事件把面板又拉起来
    this.suppressFor(chunkLabel(chunk));
    this.editor.dispatchEvent(new Event("input", { bubbles: true }));
    this.editor.focus();
  }

  hide() {
    this.el?.remove();
    this.el = null;
    this.items = [];
    this.query = "";
  }
}

/* ------------------------------------------------------------------ */
/* 编辑器组件                                                          */
/* ------------------------------------------------------------------ */

export class ChunkEditor {
  constructor(node) {
    this.node = node;
    // 同步状态显式初始化
    this._lastSynced = null;      // 上次写进 widget 的序列化结果
    this._ready = false;          // 编辑器是否已从 widget 载入初始值
    this._explicitClear = false;  // 本次同步是否来自"用户点清空"
    this.root = document.createElement("div");
    this.root.className = "ecp-wrap";

    // 顶部信息条（只读，显示词块统计；不需要按钮，转换是自动的）
    this.bar = document.createElement("div");
    this.bar.className = "ecp-bar";

    const btnClear = document.createElement("button");
    btnClear.className = "ecp-bar-btn ecp-bar-ghost";
    btnClear.textContent = "清空";
    btnClear.title = "清空编辑框";
    btnClear.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // ★ 标记"用户主动清空" ★
      // syncToWidget 有个"绝不把非空 widget 写成空"的防线（防止
      // 工作流加载时序把内容抹掉）。用户点清空属于明确意图，必须放行，
      // 否则旧内容会被回填，导致"清空后粘贴仍输出旧提示词"。
      this._explicitClear = true;
      this.setValue("");
      this.syncToWidget(true);
      this._explicitClear = false;
      this.updateBarInfo();
    });

    // 翻译未收录词块（中文 → 英文 Danbooru 标签）
    const btnTrans = document.createElement("button");
    btnTrans.className = "ecp-bar-btn";
    btnTrans.textContent = "翻译未收录";
    btnTrans.title = "翻译所有「未收录」词块：中文→英文标签，英文→补中文显示名（Hy-MT2）。首次使用需加载模型，可能要等几十秒";
    btnTrans.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.translateUnlisted();
    });

    // 分类待确认（紧挨「翻译未收录」）
    const btnCls = document.createElement("button");
    btnCls.className = "ecp-bar-btn";
    btnCls.textContent = "分类待确认";
    btnCls.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (btnCls.disabled) return;
      this.classifyPending();
    });
    this.btnClassify = btnCls;

    // 一键收录：把所有「未收录」词块收进**默认词库**
    // ⚠️ 默认词库由用户在词库管理里指定；没设时按钮灰显不可用
    const btnCollect = document.createElement("button");
    btnCollect.className = "ecp-bar-btn";
    btnCollect.textContent = "一键收录";
    btnCollect.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (btnCollect.disabled) return;
      this.collectAll();
    });
    this.btnCollect = btnCollect;

    // 整理词块：按「设置」里配置的类型顺序重排
    const btnSort = document.createElement("button");
    btnSort.className = "ecp-bar-btn";
    btnSort.textContent = "整理词块";
    btnSort.title = "按设置里的类型顺序重排词块；「待确认」排最后";
    btnSort.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.sortChunks();
    });

    // 设置（原「词库管理」）
    const btnDicts = document.createElement("button");
    btnDicts.className = "ecp-bar-btn";
    btnDicts.textContent = "设置";
    btnDicts.title = "词库管理 / 词块类型顺序";
    btnDicts.addEventListener("mousedown", (e) => {
      e.preventDefault();
      openDictManager(this);
    });

    this.barInfo = document.createElement("span");
    this.barInfo.className = "ecp-bar-info";
    this.barInfo.textContent = "粘贴整段提示词会自动转成词块";

    this.bar.append(btnClear, btnTrans, btnCls, btnCollect, btnSort, btnDicts, this.barInfo);
    this.root.appendChild(this.bar);

    this.editor = document.createElement("div");
    this.editor.className = "ecp-editor";
    this.editor.contentEditable = "true";
    this.editor.spellcheck = false;
    this.editor.dataset.placeholder = "输入中文或英文，自动提示 Danbooru 标签…（粘贴整段提示词会自动拆分）";
    this.root.appendChild(this.editor);

    this.ac = new Autocomplete(this.editor);
    this._syncing = false;
    this._wiredText = null;
    this._composing = false;

    this.editor.addEventListener("input", () => this.onInput());
    this.editor.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.editor.addEventListener("keypress", (e) => e.stopPropagation());
    this.editor.addEventListener("keyup", (e) => e.stopPropagation());
    this.editor.addEventListener("paste", (e) => this.onPaste(e), true);
    this.editor.addEventListener("click", (e) => this.onClick(e));
    this.editor.addEventListener("dblclick", (e) => this.onDblClick(e));
    this.editor.addEventListener("copy", (e) => e.stopPropagation());
    this.editor.addEventListener("cut", (e) => e.stopPropagation());

    // 中文逗号自动转英文（在字符插入前拦截）
    this.editor.addEventListener("beforeinput", (e) => this.onBeforeInput(e));
    // 记录输入法组合状态，组合期间不干预输入
    this.editor.addEventListener("compositionstart", () => { this._composing = true; });
    this.editor.addEventListener("compositionend", () => {
      this._composing = false;
      // 输入法提交时 beforeinput 可能被跳过，这里兜底转换刚输入的中文逗号
      if (this.convertJustTypedComma()) {
        this.syncToWidget(true);
      }
      // 输入法把组合内容删空后，编辑器可能只剩 BR 或空节点，
      // 光标/焦点会失去锚点（表现为"删完拼音就丢了焦点"）。
      // 组合结束后补锚点并把光标放回去。
      this._restoreAfterComposition();
    });

    // 词块拖动排序：按下记录起点，移动超过阈值才真正进入拖动
    this.editor.addEventListener("mousedown", (e) => this.onMouseDown(e));

    // ⚠️ window 上的监听器必须保存引用，并在节点销毁时移除。
    // 否则每次新建节点都会再挂一份，旧编辑器的处理器仍然存活：
    // DragState 是模块级共享状态，多个过期处理器会在 mouseup 时
    // 抢先调用 dragCleanup()，导致拖动"看起来没生效"。
    this._onWinMove = (e) => this.onMouseMove(e);
    this._onWinUp = (e) => this.onMouseUp(e);
    this._onWinKey = (e) => {
      if (e.key === "Escape" && DragState.active) {
        dragCleanup();
        this._dragged = true;   // 抑制随后的 click
        setTimeout(() => { this._dragged = false; }, 0);
      }
    };
    window.addEventListener("mousemove", this._onWinMove);
    window.addEventListener("mouseup", this._onWinUp);
    window.addEventListener("keydown", this._onWinKey, true);

    // ⚠️ 关键：LiteGraph 把 Ctrl+C / Ctrl+V 等快捷键挂在 **祖先元素**
    // （graph-canvas-container / document）的**捕获阶段**，
    // 冒泡阶段的 stopPropagation 拦不住它。
    // 而且它的判据只有 `target.localName === "input"`，我们的编辑器是 div，
    // 所以"在编辑框里按 Ctrl+C"会被当成"复制节点"。
    // 这里在**编辑器自身的捕获阶段**就把画布快捷键拦下来。
    this.editor.addEventListener("keydown", (e) => this._blockCanvasShortcuts(e), true);
    this.editor.addEventListener("mousedown", (e) => this._blockCanvasMouse(e), true);
    // 剪贴板数据里若含图片/文件（如从网页拖来的图），也不该在编辑框里触发节点粘贴
    this.editor.addEventListener("dragover", (e) => e.stopPropagation(), true);
    this.editor.addEventListener("drop", (e) => e.stopPropagation(), true);

    injectStyle();
    this.attachWidget();
    this.bindWiredInput();
    // 注册到全局：改默认词库后需要通知所有编辑器刷新按钮状态
    window.__ecpEditors = window.__ecpEditors || new Set();
    window.__ecpEditors.add(this);
    // 刷新按钮可用状态（无默认词库 / 分类依赖缺失时灰显）
    this.refreshCollectButton();
    this.refreshClassifyButton();
  }

  /**
   * 把后端 INPUT_TYPES 里的 label / tooltip 应用到界面上。
   *
   * ComfyUI 只把 label/tooltip 放在 nodeData.input.<sec>.<name>[1] 里，
   * 而 LiteGraph 创建 widget 用的是键名，**不会自动套用 label**，
   * 所以界面上会显示 base_model / mode 这种英文；悬停也没有提示。
   * 这里逐个把它们写回 widget：
   *   · w.label            → 控件左侧显示的文字
   *   · w.options.tooltip  → 悬停提示
   * 注意键名本身保持不变（它是工作流的接口契约）。
   */
  applyChineseLabels() {
    const node = this.node;
    const nd = node?.constructor?.nodeData;
    const secs = ["required", "optional"];
    for (const sec of secs) {
      const defs = nd?.input?.[sec] || {};
      for (const [name, def] of Object.entries(defs)) {
        // def 形如 ["STRING", {label, tooltip, ...}] 或 [[选项...], {...}]
        const opts = Array.isArray(def) && def.length > 1 ? def[1] : null;
        if (!opts) continue;
        const w = node.widgets?.find((x) => x.name === name);
        if (!w) continue;
        if (opts.label) w.label = opts.label;
        if (opts.tooltip) {
          w.options = w.options || {};
          w.options.tooltip = opts.tooltip;
          w.tooltip = opts.tooltip;   // 兼容不同前端版本
        }
      }
    }
  }

  /* ---------------- 连线输入 ---------------- */

  /**
   * 接收连线输入。
   *
   * 关键点：ComfyUI **不会**把上游执行结果写进 `node.inputs[].value`，
   * 前端拿不到上游送来的文本。唯一可靠的途径是：
   * 本节点在后端 build() 里把 text_in 原文通过 `ui` 消息回传，
   * 前端监听该节点的 `executed` 事件取得。
   *
   * 执行完成后，把这段文本拆成词块补进编辑框，
   * 这样输入框里就能直观看到"上游到底送来了什么"。
   */
  bindWiredInput() {
    const apply = (rawText) => {
      const text = String(rawText ?? "");
      if (!text.trim()) return;
      if (text === this._wiredText) return;   // 同一份内容不重复追加
      this._wiredText = text;

      const modeW = this.node.widgets?.find((x) => x.name === "mode");
      const replace = modeW?.value === "替换";
      this.convertText(text, { merge: !replace, silent: true });
    };

    this._onExecuted = (msg) => {
      // 后端返回 {"ui": {"ecp_wired_text": ["..."]}}
      const v = msg?.ecp_wired_text;
      const raw = Array.isArray(v) ? v[0] : v;
      if (raw !== undefined) apply(raw);
    };

    const orig = this.node.onExecuted;
    this.node.onExecuted = (...args) => {
      try { this._onExecuted(...args); } catch (e) { LOG("wired input error", e); }
      return orig?.apply(this.node, args);
    };

    // 节点被删除时清理，避免残留引用
    const origRemoved = this.node.onRemoved;
    this.node.onRemoved = (...args) => {
      this.node.onExecuted = orig;
      return origRemoved?.apply(this.node, args);
    };
  }

  /* ---------------- 转换 ---------------- */

  /** 当前选中的基础模型 */
  baseModel() {
    return this.node.widgets?.find((x) => x.name === "base_model")?.value || "通用（Danbooru）";
  }

  /** 是否 Anima 基础模型（画师要加 @） */
  isAnima() {
    return String(this.baseModel()).toLowerCase().includes("anima");
  }

  /** 把一段文本转成词块（merge=true 时追加到现有内容后面） */
  async convertText(text, { merge = true, silent = false, replaceNode = null } = {}) {
    if (!text || !text.trim()) return;
    // 登记"有转换在进行中"，执行前 flush 会等它结束
    this._pending = (this._pending || Promise.resolve())
      .then(() => this._doConvert(text, { merge, silent, replaceNode }))
      .catch((e) => LOG("convert error", e));
    return this._pending;
  }

  async _doConvert(text, { merge = true, silent = false, replaceNode = null } = {}) {
    if (!text || !text.trim()) return;
    let data;
    try {
      const r = await fetch(`/${EXT}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, allow_unlisted: true, base_model: this.baseModel() }),
      });
      data = await r.json();
    } catch (e) {
      if (!silent) toast(`转换失败：${e.message}`, true);
      return;
    }
    if (!data?.ok) {
      if (!silent) toast(`转换失败：${data?.error || "未知错误"}`, true);
      return;
    }
    this.applyConverted(data.items || [], { merge, replaceNode });
    if (!silent) {
      toast(`已转换 ${data.total} 个标签（匹配 ${data.matched} 个）`);
    }
  }

  /** 把后端返回的 items 渲染成词块 */
  /**
   * 把后端返回的 items 渲染成词块。
   *
   * @param {boolean} merge      true=追加到末尾；false=替换编辑框全部内容
   * @param {Text}    replaceNode 若给出，则只把该文本节点替换成词块
   *                              （粘贴场景：既清掉刚插入的纯文本，又不影响其他内容）
   */
  applyConverted(items, { merge = true, replaceNode = null } = {}) {
    if (!items.length) return;
    const frag = document.createDocumentFragment();
    for (const it of items) {
      frag.appendChild(makeChunkEl({
        // display_en 已按基础模型处理过（Anima 画师带 @），优先用它
        en: it.display_en || it.en,
        cn: it.cn,
        category: it.category,
        disabled: false,
        source: it.source,
        unlisted: it.unlisted,
        weight: it.weight,          // 输入侧解析出的 A1111 权重
      }));
    }

    if (replaceNode && replaceNode.isConnected) {
      // 精准替换：只换掉粘贴时插入的那个文本节点
      // 把词块插到该节点前面，再删掉它
      const before = replaceNode.previousSibling;
      const parent = replaceNode.parentNode;
      parent.insertBefore(frag, replaceNode);
      replaceNode.remove();
      setCaretAfterNode(this.editor, this.editor.lastChild);
      void before;
    } else if (!merge) {
      this.editor.textContent = "";
      this.editor.appendChild(frag);
      this.editor.appendChild(document.createTextNode(""));
      setCaretAfterNode(this.editor, this.editor.lastChild);
    } else {
      if (this.editor.lastChild &&
          this.editor.lastChild.nodeType === Node.TEXT_NODE &&
          !this.editor.lastChild.textContent.trim()) {
        this.editor.lastChild.remove();
      }
      this.editor.appendChild(frag);
      this.editor.appendChild(document.createTextNode(""));
      setCaretAfterNode(this.editor, this.editor.lastChild);
    }
    this.syncToWidget(true);
    this.updateBarInfo();
  }

  updateBarInfo() {
    const n = this.editor.querySelectorAll(".ecp-chunk").length;
    const un = this.editor.querySelectorAll(".ecp-chunk.ecp-unlisted").length;
    const dis = this.editor.querySelectorAll(".ecp-chunk.ecp-disabled").length;
    const bits = [];
    if (n) bits.push(`${n} 个词块`);
    if (dis) bits.push(`${dis} 个禁用`);
    if (un) bits.push(`${un} 个未收录`);
    this.barInfo.textContent = bits.join(" · ");
  }

  /* ---------------- 翻译 ---------------- */

  /** 当前选择的翻译模型名 */
  transModel() {
    return this.node.widgets?.find((x) => x.name === "trans_model")?.value || "";
  }

  /** 收集需要翻译的词块（默认只翻「未收录」的） */
  collectTranslatable() {
    const all = [...this.editor.querySelectorAll(".ecp-chunk")];
    return all.filter((c) => c.dataset.unlisted === "1" && chunkLabel(c).trim());
  }

  /** 翻译栏按钮：批量翻译所有未收录词块 */
  async translateUnlisted() {
    const targets = this.collectTranslatable();
    if (!targets.length) {
      toast("没有需要翻译的未收录词块");
      return;
    }
    const n = await this.translateChunks(targets);
    if (n) toast(`已翻译 ${n} 个词块`);
  }

  /**
   * 对给定词块执行翻译。
   *
   * 中文 → 英文；成功后清掉 unlisted 标记并重绘（颜色转为正常），
   * 用户若对结果不满意，双击菜单里的「编辑英文输出」即可手改。
   */
  async translateChunks(chunks) {
    const list = chunks.filter((c) => c.isConnected);
    if (!list.length) return 0;

    const model = this.transModel();

    // ★ 送翻译的文本构造 ★
    //
    // 规则 1：**不要把权重拼进去**
    //   chunkLabel() 返回 "双马尾 (1.2)"，权重会被当正文送去翻译。
    //   这里只送纯词面，权重是独立字段。
    //
    // 规则 2：**已翻译过的词块要按"中文有没有被改过"决定行为**：
    //
    //   ① 已翻译且中文没改（cn === transCn）
    //      → **跳过**，不送模型。
    //        否则英文会被二次翻译破坏（实测 smiling→smile、
    //        long hair→long_hair，因为再查词库命中了不同标签）。
    //
    //   ② 已翻译但用户**改了中文**（cn !== transCn）
    //      → 送**新中文**做中译英，据修改后的中文重译英文。
    //
    //   ③ 从未翻译过（无 transCn）
    //      → 优先送英文（英译中补中文名）；没有英文才送中文。
    const skipIdx = new Set();
    const items = list.map((c, i) => {
      const en = (c.dataset.en || "").trim();
      const cn = (c.dataset.cn || "").trim();
      const transCn = (c.dataset.transCn || "").trim();

      if (transCn) {
        // 已翻译过
        if (cn && cn === transCn) {
          skipIdx.add(i);          // ① 中文没改 → 跳过
          return "";
        }
        if (cn && cn !== transCn) {
          return cn;               // ② 中文被改 → 按新中文重译英文
        }
      }
      return en || cn;             // ③ 首次 → 优先英文
    });
    this._skipTranslate = skipIdx;

    // 翻译可能耗时较久，给个进行中的提示
    // 跳过的项不发送（保持原有 en/cn 不变）
    const sendList = list.filter((_, i) => !skipIdx.has(i));
    const sendItems = items.filter((_, i) => !skipIdx.has(i));
    if (!sendItems.length) {
      toast(`这 ${list.length} 个词块都已翻译过（改中文后可重译英文）`);
      return 0;
    }

    this.barInfo.textContent = `翻译中… (${sendItems.length})`;

    let data;
    try {
      // 60 秒超时。必须 **大于后端单次超时(45s)** 但不能太长 ——
      // 后端 GPU 失败后还会走 CPU 重试，这里兜住整体时长，
      // 避免"翻译中…"挂在界面上让用户以为没反应。
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      const r = await fetch(`/${EXT}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        // 方向由后端按内容自动判定，这里不传 to_english
        body: JSON.stringify({ items: sendItems, model }),
      });
      clearTimeout(timer);
      data = await r.json();
    } catch (e) {
      this.updateBarInfo();
      const msg = e.name === "AbortError" ? "翻译超时，请检查翻译模型是否可用" : e.message;
      toast(`翻译失败：${msg}`, true);
      return 0;
    }

    if (!data?.ok) {
      this.updateBarInfo();
      toast(`翻译失败：${data?.error || "未知错误"}`, true);
      return 0;
    }

    let done = 0;
    let lexiconHits = 0;
    const results = data.results || [];
    sendList.forEach((c, i) => {
      const res = results[i];
      if (!res?.ok) return;

      // 后端已经算好最终要用的英文与中文：
      //   含中文 → en=译文、cn=原文
      //   纯英文 → en=原英文（或词库命中的正式标签）、cn=译出的中文
      const en = String(res.en || "").trim();
      const cn = String(res.cn || "").trim();
      if (!en) return;

      c.dataset.en = en;
      if (cn) c.dataset.cn = cn;
      // ★ 记住本次翻译产出的中文 ★
      // 下次翻译时比较 cn 是否与此值不同，判断"用户是否改了中文"：
      //   相同 → 跳过（避免二次翻译破坏英文）
      //   不同 → 按新中文重译英文
      c.dataset.transCn = cn || "";

      c.dataset.source = "builtin";
      if (res.lexicon_hit) {
        // 词库命中 → 官方正式标签，不再是「未收录」
        // ★ 同时把分类设成词库里该条目的真实分类 ★
        // （否则词块保持之前的 cat=21 待确认 —— 翻译后类型不更新的 bug）
        if (res.category != null) c.dataset.category = String(res.category);
        delete c.dataset.unlisted;
        delete c.dataset.typed;
        lexiconHits++;
      } else {
        // 翻译了但词库里仍没有 → 按定义仍属「未收录」（无词库来源）
        c.dataset.unlisted = "1";
        if (res.category != null) c.dataset.category = String(res.category);
      }
      paintChunk(c);
      done++;
    });

    this.syncToWidget(true);
    this.updateBarInfo();

    if (data.fail_count) {
      toast(`翻译完成 ${done} 个，失败 ${data.fail_count} 个`, done === 0);
    } else if (lexiconHits) {
      toast(`已翻译 ${done} 个，其中 ${lexiconHits} 个匹配到词库`);
    }
    return done;
  }

  /** 把原生 multiline widget 隐藏，用本编辑器接管 */
  attachWidget() {
    const node = this.node;

    // ★ 先把各控件的**中文标签与悬停说明**应用到 widget 上 ★
    //
    // 后端 INPUT_TYPES 里已经写了 label / tooltip，但它们只存在于
    // nodeData.input 里，LiteGraph 建 widget 时**不会自动读**，
    // 界面上仍显示英文键名（base_model / mode …），也没有悬停提示。
    // 这里从 nodeData 取出来写回 widget，界面才是中文的。
    this.applyChineseLabels();

    const w = node.widgets?.find((x) => x.name === "prompt_text");
    if (!w) {
      LOG("未找到 prompt_text widget");
      return;
    }
    this.widget = w;

    if (!w.__ecpOrig) {
      w.__ecpOrig = { computeSize: w.computeSize, type: w.type, draw: w.draw, y: w.y, last_y: w.last_y };
    }
    // 隐藏：尺寸归零，跳过原生绘制
    w.computeSize = () => [0, -4];
    w.draw = () => {};
    w.type = "hidden";
    w.hidden = true;

    // 把我们的编辑器作为 DOM widget 挂上去。
    //
    // 注意：只写 serialize:false 并不足以把它排除出 widgets_values——
    // ComfyUI 序列化节点时仍会把每个 widget 的 value 塞进数组，
    // 于是工作流里会多出一个中文明文项，甚至造成 widgets_values 错位。
    // 这里再补两刀：
    //   1) serializeValue() 返回 undefined（新版前端据此跳过）
    //   2) 把 value 锁定为空串（兜底所有前端版本）
    this.domWidget = node.addDOMWidget("easy_cn_prompt_ui", "ecp_chunk_editor", this.root, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => "",
      setValue: (v) => this.setValue(v),
      serializeValue: () => undefined,
    });
    this.domWidget.computeSize = (width) => [width, 190];
    try {
      Object.defineProperty(this.domWidget, "value", {
        configurable: true,
        get: () => "",
        set: () => {},
      });
    } catch (e) {
      LOG("无法锁定 DOM widget 的 value", e);
    }

    // 基础模型变化时刷新提示（Anima 会给画师加 @）
    const bmWidget = node.widgets?.find((x) => x.name === "base_model");
    if (bmWidget) {
      const origBm = bmWidget.callback;
      bmWidget.callback = (v, ...rest) => {
        const r = origBm?.call(bmWidget, v, ...rest);
        this.updateBarInfo();
        app.graph.setDirtyCanvas(true, true);
        return r;
      };
    }

    // 初始值。这一步之后编辑器才算"就绪"，
    // 在就绪之前 syncToWidget 不会把非空 widget 覆盖成空。
    deserializeInto(this.editor, w.value || "");
    this._ready = true;
    this.syncToWidget(true);
    LOG("编辑器已挂载到节点", node.id);  }

  setValue(text) {
    deserializeInto(this.editor, text || "");
  }

  onInput() {
    if (this._syncing) return;

    // 兜底：某些输入法/浏览器不派发 beforeinput，
    // 这里再检查一次"光标左侧刚输入的是不是中文逗号"。
    // 只动紧邻的一个字符，不扫描全文 —— 已存在的中文逗号不受影响。
    if (!this._composing && this.convertJustTypedComma()) {
      this.syncToWidget(true);
    }

    // 内容被删空时补锚点。
    // 浏览器原生删除（退格 / 输入法删除 / execCommand）不会经过
    // removeChunkWithComma 等函数，必须在这里兜底 —— 否则编辑器里
    // 只剩一个 BR，输入法与光标失去锚点，表现为"删完后丢了焦点"。
    // 注意：只在"刚被删空"的瞬间补，避免打断正在进行的输入。
    if (!this._composing && this.editor.childNodes.length <= 1
        && !this.editor.querySelector(".ecp-chunk")) {
      ensureCaretAnchor(this.editor);
    }

    this.handleCommaChunking();
    this.syncToWidget();
    this.updateBarInfo();
  }

  /**
   * 输入法组合结束后恢复光标与焦点。
   *
   * 场景：用户用输入法打拼音（尚未上屏），按退格把拼音删空。
   * 部分输入法/浏览器在组合内容变空后会**结束组合**，此时编辑器里
   * 可能只剩一个 BR 或干脆没有可编辑文本，光标与焦点失去锚点 ——
   * 用户感知为"删完拼音就丢了焦点，得重新点一下才能打字"。
   *
   * 这里做两件事：
   *   ① 补零宽空格锚点（复用 ensureCaretAnchor）
   *   ② 若焦点已不在编辑器内，把焦点与光标放回锚点
   */
  _restoreAfterComposition() {
    const ed = this.editor;
    if (!ed.isConnected) return;

    const active = document.activeElement;
    const focusLost = active !== ed && !ed.contains(active);

    // 编辑器已空（只剩空白/BR）→ 补锚点
    const hasText = [...ed.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.replace(/\u200B/g, "").length > 0
    );
    if (!hasText && !ed.querySelector(".ecp-chunk")) {
      ensureCaretAnchor(ed);
    }

    // 焦点丢了就抢回来（用户刚才正在这个框里打字，理应还在）
    if (focusLost) {
      try { ed.focus({ preventScroll: true }); } catch (_) { ed.focus(); }
      const sel = window.getSelection();
      if (sel && !sel.rangeCount) {
        const r = document.createRange();
        r.selectNodeContents(ed);
        r.collapse(false);
        sel.addRange(r);
      }
    }
  }

  /* ---------------- 整理词块 ---------------- */

  /**
   * 按「设置」里的类型顺序重排词块。
   *
   * 规则：
   *   · 按 category 的类型顺序分组（顺序来自后端设置）
   *   · 同类型内**保持原有相对顺序**（稳定排序）
   *   · 「待确认」(21) 永远排在最后
   *
   * 实现要点：必须真正**移动 DOM 节点** —— 序列化是按 DOM 顺序来的，
   * 只改样式不会改变输出。
   */
  async sortChunks() {
    const ed = this.editor;
    const chunks = [...ed.querySelectorAll(".ecp-chunk")];
    if (chunks.length < 2) {
      toast("词块少于 2 个，无需整理");
      return;
    }

    let order = [];
    try {
      const r = await fetch(`/${EXT}/settings/category_order`);
      const j = await r.json();
      order = j.order || [];
    } catch (e) {
      LOG("读取类型顺序失败", e);
    }
    if (!order.length) {
      order = Object.keys(window.__ECP_CATEGORIES || {}).map(Number).sort((a, b) => a - b);
    }
    const rank = new Map(order.map((c, i) => [c, i]));
    // 未在顺序表里的类别排到最后（但仍在「待确认」之前）
    const fallback = order.length + 1;
    const PENDING = 21;

    const key = (c) => {
      const cat = Number(c.dataset.category || 0);
      if (cat === PENDING) return Number.MAX_SAFE_INTEGER;      // ★ 待确认永远最后
      return rank.has(cat) ? rank.get(cat) : fallback;
    };

    // 稳定排序：同类型内保持原顺序
    const sorted = chunks
      .map((c, i) => ({ c, i, k: key(c) }))
      .sort((a, b) => (a.k - b.k) || (a.i - b.i))
      .map((x) => x.c);

    // 顺序没变就不动 DOM（避免无谓重排）
    if (sorted.every((c, i) => c === chunks[i])) {
      toast("已经是有序的");
      return;
    }

    // 把词块按新顺序重新放进编辑器。
    // 词块之间的裸文本（未收入词块的零散文字）会集中挪到末尾，
    // 避免插在词块之间导致输出混乱。
    const looseText = [];
    for (const n of [...ed.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.textContent.replace(/[\u200B\s,，]/g, "");
        if (t) looseText.push(n.textContent.replace(/[\u200B]/g, ""));
      }
    }

    ed.textContent = "";
    sorted.forEach((c) => ed.appendChild(c));
    const tail = looseText.join(" ").trim();
    if (tail) {
      ed.appendChild(document.createTextNode(" " + tail));
    }
    ensureCaretAnchor(ed);

    this.syncToWidget(true);
    this.updateBarInfo();

    const pending = sorted.filter((c) => Number(c.dataset.category || 0) === PENDING).length;
    toast(`已整理 ${sorted.length} 个词块${pending ? `（${pending} 个待确认排最后）` : ""}`);
  }

  /* ---------------- 分类器状态 ---------------- */

  /**
   * 刷新「分类待确认」按钮的可用状态。
   * 依赖缺失（未装 cls_pkgs / 没有模型）时灰显并说明原因。
   */
  async refreshClassifyButton() {
    const btn = this.btnClassify;
    if (!btn) return;
    let d = null;
    try {
      const r = await fetch(`/${EXT}/classify/status`);
      d = await r.json();
    } catch (e) {
      LOG("读取分类器状态失败", e);
    }
    const ready = !!d?.ready;
    btn.disabled = !ready;
    btn.classList.toggle("ecp-bar-disabled", !ready);
    btn.title = ready
      ? "把「待确认」词块用本地 SetFit 模型自动分类：置信度高的直接采纳，其余保留待确认"
      : `分类功能不可用：${d?.message || "未知原因"}`;
  }

  /* ---------------- 一键收录 ---------------- */

  /**
   * 刷新「一键收录」按钮状态。
   * 没有默认词库时**灰显并给出提示**（默认词库由用户在词库管理里指定）。
   */
  async refreshCollectButton() {
    const btn = this.btnCollect;
    if (!btn) return;
    let d = null;
    try {
      const r = await fetch(`/${EXT}/dicts/default`);
      const j = await r.json();
      d = j.dict || null;
    } catch (e) {
      LOG("读取默认词库失败", e);
    }
    this._defaultDict = d;
    if (d) {
      btn.disabled = false;
      btn.classList.remove("ecp-bar-disabled");
      btn.title = `把所有「未收录」的词收进默认词库「${d.name}」`;
    } else {
      btn.disabled = true;
      btn.classList.add("ecp-bar-disabled");
      btn.title = "尚未设置默认词库 —— 请到「词库管理」里指定一个";
    }
  }

  /** 把所有「未收录」的词块收录到默认词库 */
  async collectAll() {
    const d = this._defaultDict;
    if (!d) {
      toast("尚未设置默认词库，请先到「词库管理」里指定", true);
      return;
    }
    const targets = [...this.editor.querySelectorAll(".ecp-chunk")]
      .filter((c) => c.dataset.unlisted === "1");
    if (!targets.length) {
      toast("没有未收录的词块");
      return;
    }

    this.barInfo.textContent = `收录中… (${targets.length})`;
    let ok = 0, fail = 0;
    for (const c of targets) {
      try {
        const r = await fetch(`/${EXT}/custom/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            en: c.dataset.en,
            cn: c.dataset.cn || c.dataset.en,
            category: Number(c.dataset.category || 0),
            dict_id: d.id,
          }),
        });
        const j = await r.json();
        if (j.ok) {
          c.dataset.source = "custom";
          delete c.dataset.unlisted;      // 已收录 → 去掉虚线外框
          paintChunk(c);
          ok++;
        } else {
          fail++;
        }
      } catch (_) {
        fail++;
      }
    }
    await refreshCustomIndex();
    this.syncToWidget(true);
    this.updateBarInfo();
    toast(fail ? `已收录 ${ok} 个，失败 ${fail} 个` : `已收录 ${ok} 个到「${d.name}」`, !!fail);
  }

  /* ---------------- 自动分类（SetFit） ---------------- */

  /**
   * 对「待确认」的词块自动分类。
   *
   * 阈值可在「设置」→「自动分类」里调整（默认 0.80）。
   * 实测：≥0.8 准确率约 90%，≥0.9 约 93%，≥0.6 约 82%。
   */
  async classifyPending() {
    const targets = [...this.editor.querySelectorAll(".ecp-chunk")]
      .filter((c) => Number(c.dataset.category || 0) === 21);

    if (!targets.length) {
      toast("没有「待确认」的词块");
      return;
    }

    // 送「中文名 英文标签」——中文名提供关键语义信息（实测能显著提升准确率）。
    // 注意：中文名与英文名相同时也要**重复一次**（如 "长发 长发"），
    // 否则文本信息量不足，同一标签的置信度会明显偏低（实测 0.79 vs 0.82）。
    const items = targets.map((c) => {
      const cn = (c.dataset.cn || "").trim();
      const en = (c.dataset.en || "").trim();
      if (cn && cn !== en) return `${cn} ${en}`;
      return en ? `${en} ${en}` : "";
    });

    // 取阈值（带缓存，设置页改过会更新）
    let thr = this._confThreshold;
    if (thr == null) {
      try {
        const r = await fetch(`/${EXT}/settings/confidence`);
        thr = (await r.json()).confidence ?? 0.8;
      } catch (_) {
        thr = 0.8;
      }
      this._confThreshold = thr;
    }

    this.barInfo.textContent = `分类中… (${items.length})`;

    let data;
    try {
      const r = await fetch(`/${EXT}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      data = await r.json();
    } catch (e) {
      this.updateBarInfo();
      toast(`分类失败：${e.message}`, true);
      return;
    }
    if (!data?.ok) {
      this.updateBarInfo();
      toast(`分类失败：${data?.error || "未知错误"}`, true);
      return;
    }

    let applied = 0, kept = 0;
    const results = data.results || [];
    targets.forEach((c, i) => {
      const res = results[i];
      if (!res) return;
      if (res.conf >= thr) {
        c.dataset.category = String(res.cat);
        paintChunk(c);
        applied++;
      } else {
        kept++;
      }
    });

    this.syncToWidget(true);
    this.updateBarInfo();
    if (applied) {
      toast(`已分类 ${applied} 个（阈值 ${thr.toFixed(2)}）${kept ? `，${kept} 个未达阈值` : ""}`);
    } else {
      toast(`置信度都不足 ${thr.toFixed(2)}，${kept} 个保留「待确认」（可在设置里调低阈值）`);
    }
  }

  /* ---------------- 中文逗号自动转英文 ---------------- */

  /** 「自动转换中文逗号」开关是否开启（节点控件） */
  autoCommaOn() {
    const w = this.node.widgets?.find((x) => x.name === "auto_comma");
    return !w || w.value === "开启";     // 找不到控件时按开启处理
  }

  /**
   * 把「光标前刚输入的那个中文逗号」换成英文逗号。
   *
   * 只处理**紧挨光标左侧**的一个字符，绝不扫描全文 ——
   * 这样框里已经存在的中文逗号不会被回头改写（符合需求）。
   *
   * @returns {boolean} 是否做了替换
   */
  convertJustTypedComma() {
    if (!this.autoCommaOn()) return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return false;

    const node = r.startContainer;
    const off = r.startOffset;

    // 情况 A：光标在文本节点内部 —— 直接看左边一个字符
    if (node.nodeType === Node.TEXT_NODE && off > 0) {
      if (node.textContent[off - 1] !== "，") return false;
      const text = node.textContent;
      node.textContent = text.slice(0, off - 1) + "," + text.slice(off);
      // 替换的是等长单字符，光标位置不变
      const r2 = document.createRange();
      r2.setStart(node, off);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
      return true;
    }

    // 情况 B：光标在元素节点上（例如紧跟在某个词块之后，浏览器会把光标
    // 放在 editor 元素上、offset 指向下一个子节点）—— 此时要看**前一个兄弟**
    if (node.nodeType === Node.ELEMENT_NODE && off > 0) {
      const prev = node.childNodes[off - 1];
      if (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent.endsWith("，")) {
        const t = prev.textContent;
        prev.textContent = t.slice(0, -1) + ",";
        const r2 = document.createRange();
        r2.setStart(node, off);
        r2.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r2);
        return true;
      }
    }

    return false;
  }

  /**
   * 在字符**插入之前**把中文逗号换成英文逗号。
   *
   * 用 beforeinput 而不是 input：这样只影响"正在输入的这个字符"，
   * 框里**已经存在**的中文逗号不会被回头改写（符合需求）。
   * 输入法组合期间这里会被跳过，由 compositionend 兜底。
   */
  onBeforeInput(e) {
    // 这里**故意不拦截**、也不手动插入。
    //
    // 曾经的做法是 preventDefault() 后自己 insertNode 写回，但那会把原来的
    // 文本节点**拆成两个**（"双马尾" + ","）。而 handleCommaChunking 只检查
    // 光标所在节点内部的左侧内容，节点被拆开后就看不到"双马尾"，
    // 于是"能转换但不触发词块"。
    //
    // 正确做法：放行浏览器正常插入，再在 input 阶段用
    // convertJustTypedComma() **就地替换字符**（不拆节点）。
    // 本函数现在只负责记录"这次输入带了中文逗号"，供 input 阶段参考。
    if (!this.autoCommaOn()) return;
    if (this._composing) return;
    if (e.inputType !== "insertText" && e.inputType !== "insertCompositionText") return;
    this._commaPending = !!(e.data && e.data.includes("，"));
  }

  /**
   * 粘贴：整段提示词直接转换成词块，而不是插成一坨纯文本。
   *
   * ⚠️ 关键时序问题：convertText 需要 await fetch，是**异步**的。
   * 如果用户粘贴后立刻点「执行」，ComfyUI 读到的是尚未更新的空 widget，
   * 结果输出为空字符串（表现为"粘贴转换成功了，但下次运行输出是空的"）。
   * 因此这里先把纯文本**同步**落地到 DOM 并同步一次 widget，
   * 保证任何时刻 widget 里都有内容，异步转换只是把它升级成词块。
   */
  onPaste(e) {
    // ★ 首要动作：拦住事件，绝不让它冒泡到 document ★
    //
    // ComfyUI 把「粘贴节点」的处理器挂在 document 上。
    // 我们的编辑器是 contenteditable 的 div，事件会一路冒泡上去，
    // 于是"在编辑框里粘贴文本"会**同时**触发粘贴节点。
    // 这里在最早时机就阻断传播，无论后面走哪条分支都不会漏。
    e.stopPropagation();
    e.stopImmediatePropagation?.();

    // ★ 统一读取并格式化成纯文本 ★
    // 剪贴板可能同时带 text/html，浏览器默认会按 HTML 插入，
    // 于是编辑器里混进 <span>/<b>/<div> 等标签和多余空白。
    // 这里一律取纯文本并做清洗，保证插入的内容是干净的。
    const text = readClipboardText(e.clipboardData);
    if (!text) return;

    // 无论内容多少，**一律由我们接管插入**，绝不放行给浏览器 ——
    // 放行就意味着浏览器可能按 HTML 格式插入，无法保证是纯文本。
    // （旧版在"单个词"时直接 return 放行，正是格式污染的来源。）
    e.preventDefault();

    // 含标记的直接反序列化，保证从别处复制过来的词块能还原
    if (text.includes("<chunk>")) {
      const tmp = document.createElement("div");
      deserializeInto(tmp, text);
      const frag = document.createDocumentFragment();
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(frag);
        r.collapse(false);
      } else {
        this.editor.appendChild(frag);
      }
      this.syncToWidget(true);
      this.updateBarInfo();
      return;
    }

    // ① 同步插入纯文本并立刻写回 widget —— 保证即使马上去执行也有内容
    const inserted = this.insertRawText(text);
    this.syncToWidget(true);

    // ② 再异步把它升级成词块。
    //    注意要用 merge:false —— 上面刚插入的纯文本会被整体替换掉，
    //    否则会出现"纯文本 + 词块"重复两遍。
    this.convertText(text, { merge: false, silent: false, replaceNode: inserted });
  }

  /** 在当前光标处插入纯文本（用于粘贴的同步兜底），返回插入的文本节点 */
  insertRawText(text) {
    const node = document.createTextNode(text);
    const sel = window.getSelection();
    if (sel?.rangeCount && this.editor.contains(sel.getRangeAt(0).startContainer)) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(node);
      r.setStartAfter(node);
      r.collapse(true);
    } else {
      this.editor.appendChild(node);
    }
    return node;
  }

  /**
   * 把编辑器内容写回隐藏 widget。
   *
   * 注意：不能只用 `widget.value === s` 做短路判断。
   * 节点刚创建 / 工作流刚加载时 widget.value 可能是 undefined 或旧值，
   * 而 ComfyUI 在执行、序列化时读的是 widget.value——
   * 一旦某次同步被误判为"无需更新"，编辑结果就永远进不了 widget。
   * 因此这里只比较"我们自己上次写入的值"。
   */
  syncToWidget(force = false) {
    const s = serializeEditor(this.editor);

    // ★ 防线：绝不把非空 widget 写成空 ★
    // 工作流加载时序里存在"widget 已有值、编辑器还没填上"的短暂窗口，
    // 此时若同步一次就会把用户内容抹成空串，节点随后静默无输出。
    // 一旦发现要写空、而 widget 里还有内容，就先用 widget 的内容回填编辑器。
    //
    // ⚠️ 但**用户主动点「清空」时必须放行** ——
    // 否则这个防线会把旧内容回填回来，表现为"清空后再粘贴，
    // 输出的还是旧提示词"。
    if (!s && this.widget.value && !this._ready && !this._explicitClear) {
      LOG("检测到编辑器为空但 widget 有值，先回填编辑器", this.widget.value.slice(0, 40));
      deserializeInto(this.editor, this.widget.value);
      this._ready = true;
      return this.syncToWidget(force);
    }

    if (!force && this._lastSynced === s) return;
    this._lastSynced = s;
    this.widget.value = s;
    try {
      this.widget.callback?.(s);
    } catch (e) {
      LOG("widget callback error", e);
    }
    app.graph.setDirtyCanvas(true, true);
  }

  /**
   * 输入英文逗号时，把前面的裸文本片段固化成词块。
   * 先按英文精确查，再按中文精确查；都查不到就按「未收录」成块（英文=原文）。
   */
  /**
   * 定位"光标左侧紧邻的那个字符"所在位置。
   * 支持两种光标形态：
   *   A. 光标在文本节点内部 → 返回该节点与偏移
   *   B. 光标在元素节点上（紧跟词块之后时浏览器会这样放）→ 返回前一个文本节点末尾
   */
  caretTextPos(sel) {
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return null;

    const node0 = r.startContainer;
    const off0 = r.startOffset;

    if (node0.nodeType === Node.TEXT_NODE) {
      if (off0 > 0) return { node: node0, off: off0 };
      let prev = node0.previousSibling;
      while (prev && prev.nodeType !== Node.TEXT_NODE) prev = prev.previousSibling;
      if (prev && prev.textContent.length) return { node: prev, off: prev.textContent.length };
      return null;
    }
    if (node0.nodeType === Node.ELEMENT_NODE && off0 > 0) {
      const prev = node0.childNodes[off0 - 1];
      if (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent.length) {
        return { node: prev, off: prev.textContent.length };
      }
    }
    return null;
  }

  async handleCommaChunking() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const pos = this.caretTextPos(sel);
    if (!pos) return;
    const node = pos.node;
    const off = pos.off;
    const text = node.textContent;
    // 刚输入的字符是逗号？
    //
    // 开启 auto_comma：中文逗号已被 convertJustTypedComma 换成英文逗号，
    //   所以这里只认英文逗号即可。
    // 关闭 auto_comma：**完全不干预** —— 中文逗号既不转换、也不触发建词块，
    //   当普通文本框用（用户明确要求的行为）。
    if (off === 0) return;
    const justTyped = text[off - 1];
    if (justTyped !== ",") return;
    if (!this.autoCommaOn() && text[off - 1] === "，") return;   // 双保险

    const left = text.slice(0, off - 1);
    const idxSep = Math.max(left.lastIndexOf(","), left.lastIndexOf("，"), left.lastIndexOf("\n"));
    const seg = left.slice(idxSep + 1).trim();
    if (!seg || seg.length > 60) return;

    let item = null;
    try {
      let d = await apiLookup({ en: seg });
      item = d.results?.[0] || null;
      if (!item) {
        d = await apiLookup({ cn: seg });
        item = d.results?.[0] || null;
      }
    } catch (e) {
      LOG("lookup error", e);
      // 查库失败也不阻断成块，退回未收录处理
    }

    // 把 [segStart, off) 这段裸文本（含刚输入的逗号）换成词块
    const segStart = idxSep + 1;
    const leading = text.slice(segStart, off - 1).match(/^\s*/)[0].length;
    const before = text.slice(0, segStart + leading);
    const after = text.slice(off);

    const chunk = item
      ? makeChunkEl({
          en: item.en,
          cn: item.has_cn ? item.cn : "",
          category: item.category,
          disabled: false,
          source: item.source,
        })
      : makeChunkEl({
          en: seg,
          cn: seg,
          category: 21,          // 同上前端未收录默认「待确认」
          disabled: false,
          source: "builtin",     // 同上：未收录 ≠ 自定义词库
          unlisted: true,
        });

    node.textContent = before;
    node.parentNode.insertBefore(chunk, node.nextSibling);
    if (after) node.parentNode.insertBefore(document.createTextNode(after), chunk.nextSibling);

    // 光标放到词块之后（同级位置），不要塞进词块内部
    setCaretAfterNode(this.editor, chunk);
    this.syncToWidget();
  }

  /**
   * 拦截不应传给 LiteGraph 画布的快捷键。
   *
   * LiteGraph 的判据是 `target.localName === "input"`，
   * 我们用的是 contenteditable 的 div，因此必须在源头拦住，
   * 否则 Ctrl+C 会连带复制整个节点、Delete 会删节点、Ctrl+A 会全选节点。
   *
   * ⚠️ 注意：这里**只阻断向祖先传播**，不能再调用 stopImmediatePropagation，
   * 否则会把本元素上的其他监听器（onKeyDown 里的退格删词块）一起掐掉。
   */
  /**
   * 拦截编辑器内的 mousedown，避免触发 LiteGraph 画布的节点拖拽/选中。
   *
   * ⚠️ 不能无条件 stopPropagation：
   * 删除按钮（.ecp-del）是编辑器的**后代**，它的 mousedown 监听器挂在冒泡阶段。
   * 如果在捕获阶段一律掐断，删除按钮就永远收不到事件 —— 表现为"删除按钮失效"。
   * 因此只对"画布真正关心的目标"做拦截，自身 UI 元素一律放行。
   */
  _blockCanvasMouse(e) {
    const t = e.target;
    // 自身 UI（删除按钮、词块、内联输入框）不拦
    if (t instanceof Element &&
        (t.closest?.(".ecp-del") || t.closest?.(".ecp-chunk") || t.closest?.(".ecp-inline-input"))) {
      return;
    }
    e.stopPropagation();
  }

  _blockCanvasShortcuts(e) {
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;

    // 这些组合键在编辑框里属于"文本编辑"语义，画布不该处理
    const isEditCombo =
      (mod && ["c", "C", "v", "V", "x", "X", "a", "A", "z", "Z", "y", "Y"].includes(k)) ||
      ["Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(k);

    if (!isEditCombo) return;

    // 只阻止继续向祖先传播，画布就不会再收到。
    // 用 stopPropagation 而非 stopImmediatePropagation，
    // 保证本元素上挂的 onKeyDown（退格删词块）仍能正常执行。
    e.stopPropagation();
  }

  onKeyDown(e) {
    // 编辑器内的按键一律不冒泡到 LiteGraph 画布，
    // 否则 Ctrl+C / Delete / Ctrl+A 等会被画布当成"操作节点"。
    e.stopPropagation();

    if (e.key !== "Backspace") return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return;   // 有选区时交给浏览器原生处理

    // 找到"光标左边紧邻的那个词块"——只有在光标左邻确实是词块时才拦截，
    // 否则一律放行给浏览器，保证普通文字退格手感正常。
    const target = chunkBeforeCaret(this.editor, r);

    if (!target) {
      // 兜底保险：即使没识别出词块，也**不能**让浏览器原生退格去删词块 ——
      // 浏览器删掉 contenteditable=false 的元素后会把光标重置到编辑区开头。
      // 这里记录退格前的光标位置，事件结束后校验，发现被重置就修正回来。
      this._guardCaretOnBackspace(r);
      return;
    }

    e.preventDefault();
    const caret = caretAnchorBefore(target);
    removeChunkWithComma(target);
    // 光标留在被删词块原来的位置附近，而不是跳到第一个词块后面
    if (caret) {
      const range = document.createRange();
      range.setStart(caret.node, caret.offset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.syncToWidget(true);
  }

  /**
   * 兜底：浏览器原生退格若把光标重置到了编辑区开头，就修正回来。
   *
   * 触发条件是前面有词块、但 chunkBeforeCaret 没识别出来（例如词块与光标
   * 之间夹了空白文本节点）。浏览器的行为是删掉词块并把光标丢到最前面，
   * 用户感知就是"光标跳到第一个词块后面"。
   */
  _guardCaretOnBackspace(prevRange) {
    const ed = this.editor;
    const sel = window.getSelection();
    const before = sel ? sel.getRangeAt(0).cloneRange() : null;
    if (!before) return;

    // 退格前光标是否已在编辑区开头？是的话不需要修正
    const atStart = before.startContainer === ed && before.startOffset === 0;
    if (atStart) return;

    // 记录退格前的光标锚点，事件处理完后比对
    const ed2 = ed;
    setTimeout(() => {
      if (!ed2.isConnected) return;
      const s2 = window.getSelection();
      if (!s2 || !s2.rangeCount) return;
      const now = s2.getRangeAt(0);
      if (!ed2.contains(now.startContainer)) return;      // 焦点已不在编辑器，别乱动
      const nowAtStart = now.startContainer === ed2 && now.startOffset === 0;
      if (!nowAtStart) return;                             // 光标正常，无需修正

      // 光标被重置到开头 → 还原到退格前的位置（若该节点还在）
      if (ed2.contains(before.startContainer)
          && before.startContainer.nodeType === Node.TEXT_NODE
          && before.startContainer.textContent.length >= before.startOffset) {
        const rr = document.createRange();
        rr.setStart(before.startContainer, Math.max(0, before.startOffset - 1));
        rr.collapse(true);
        s2.removeAllRanges();
        s2.addRange(rr);
      }
    }, 0);
  }

  /* ---------------- 拖动排序 ---------------- */

  /** 节点被删除时清理：移除挂在 window 上的监听器，避免泄漏 */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    window.__ecpEditors?.delete?.(this);
    if (this._onWinMove) window.removeEventListener("mousemove", this._onWinMove);
    if (this._onWinUp) window.removeEventListener("mouseup", this._onWinUp);
    if (this._onWinKey) window.removeEventListener("keydown", this._onWinKey, true);
    this.ac?.hide?.();
    if (DragState.chunk && this.editor.contains(DragState.chunk)) dragCleanup();
  }

  onMouseDown(e) {
    // 只处理左键、且按在词块上（排除删除按钮）
    if (e.button !== 0) return;
    const chunk = e.target.closest?.(".ecp-chunk");
    if (!chunk || e.target.closest?.(".ecp-del")) return;

    DragState.armed = true;
    DragState.active = false;
    DragState.chunk = chunk;
    DragState.startX = e.clientX;
    DragState.startY = e.clientY;
  }

  onMouseMove(e) {
    if (!DragState.chunk) return;
    // 只处理属于本编辑器的拖动（见 onMouseUp 的说明）
    if (DragState.chunk.parentNode !== this.editor) return;

    // 已按下但还没进入拖动：判断是否超过阈值
    if (!DragState.active) {
      if (!DragState.armed) return;
      const dx = Math.abs(e.clientX - DragState.startX);
      const dy = Math.abs(e.clientY - DragState.startY);
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
      DragState.armed = false;
      startDrag(this.editor, e);
      return;
    }

    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    updateDropMarker(this.editor, computeInsertBefore(this.editor, e.clientX, e.clientY));
  }

  onMouseUp(e) {
    if (!DragState.chunk) return;

    // ★ 只有当被拖动的词块属于"我"这个编辑器时才处理。
    // 否则多个编辑器实例的 window 监听器会互相干扰：
    // 别人的词块被拖时我也收到 mouseup，抢先 dragCleanup 会让拖动失效。
    // 另外编辑器已被移出文档（graph.clear / 删节点）时直接跳过。
    if (!this.editor.isConnected) return;
    if (DragState.chunk.parentNode !== this.editor) return;

    const wasActive = DragState.active;

    if (wasActive) {
      finishDrag(this.editor, this);
      // 拖动结束后紧跟的 click 不应被当成"切换禁用"
      this._dragged = true;
      setTimeout(() => { this._dragged = false; }, 0);
    } else {
      dragCleanup();
    }
  }

  onClick(e) {
    // 刚完成拖动 → 忽略这次 click，避免误切换禁用
    if (this._dragged) return;
    const chunk = e.target.closest?.(".ecp-chunk");
    if (chunk && e.target.classList.contains("ecp-del")) return;
    if (chunk) {
      e.preventDefault();
      toggleDisabled(chunk);
    }
  }

  /** 双击词块 → 弹出操作菜单（替代浏览器原生 prompt） */
  onDblClick(e) {
    const chunk = e.target.closest?.(".ecp-chunk");
    if (!chunk) return;
    e.preventDefault();
    e.stopPropagation();
    openChunkMenu(chunk, e, this);
  }
}

/* ------------------------------------------------------------------ */
/* 词块拖动排序                                                        */
/* ------------------------------------------------------------------ */

/** 判定为"拖动"而非"点击"的位移阈值（像素） */
const DRAG_THRESHOLD = 5;

const DragState = {
  active: false,      // 是否已进入拖动
  armed: false,       // 已按下，等待位移超过阈值
  chunk: null,
  startX: 0,
  startY: 0,
  ghost: null,        // 跟随鼠标的半透明幽灵
  marker: null,       // 虚线插入位
  insertBefore: null, // 要插入到哪个节点之前（null = 末尾）
  offsetX: 0,
  offsetY: 0,
};

function dragCleanup() {
  DragState.ghost?.remove();
  DragState.marker?.remove();
  DragState.chunk?.classList.remove("ecp-dragging");
  document.body.classList.remove("ecp-dragging-active");
  Object.assign(DragState, {
    active: false, armed: false, chunk: null,
    ghost: null, marker: null, insertBefore: null,
  });
}

/** 从鼠标位置找最近的插入点：返回"应插到哪个子节点之前" */
function computeInsertBefore(editor, x, y) {
  const kids = [...editor.childNodes].filter(
    (n) => n.nodeType === Node.TEXT_NODE ? n.textContent.trim() : true
  );
  // 只看词块，裸文本不参与定位
  const chunks = kids.filter((n) => n.classList?.contains("ecp-chunk"));
  if (!chunks.length) return null;

  let best = null;
  let bestDist = Infinity;
  for (const c of chunks) {
    if (c === DragState.chunk) continue;
    const r = c.getBoundingClientRect();
    // 用"词块左/右边界"到鼠标的距离判断插入侧
    const mid = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // 垂直方向也要在附近，避免跨行误判
    const dy = Math.abs(y - cy);
    const dist = dy > r.height ? dy * 2 : Math.abs(x - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = (x < mid) ? c : (c.nextSibling);
    }
  }
  // 鼠标在最后一个词块右侧 → 插到末尾
  const last = chunks[chunks.length - 1];
  if (last && last !== DragState.chunk) {
    const lr = last.getBoundingClientRect();
    if (x > lr.right - 2) best = last.nextSibling;
  }
  return best;
}

/** 更新虚线插入位指示器 */
function updateDropMarker(editor, insertBefore) {
  if (!DragState.marker) {
    const m = document.createElement("span");
    m.className = "ecp-drop-marker";
    DragState.marker = m;
  }
  const m = DragState.marker;
  const ref = insertBefore instanceof Node && insertBefore.parentNode === editor
    ? insertBefore
    : null;
  if (ref) {
    editor.insertBefore(m, ref);
  } else {
    editor.appendChild(m);   // 末尾
  }
}

/** 开始拖动 */
function startDrag(editor, ev) {
  const chunk = DragState.chunk;
  if (!chunk) return;
  DragState.active = true;
  chunk.classList.add("ecp-dragging");
  document.body.classList.add("ecp-dragging-active");

  const r = chunk.getBoundingClientRect();
  DragState.offsetX = ev.clientX - r.left;
  DragState.offsetY = ev.clientY - r.top;

  // 半透明幽灵
  const ghost = chunk.cloneNode(true);
  // 注意：chunk 此刻已经带了 ecp-dragging（opacity .28），
  // clone 会把它一起复制过来，导致幽灵也跟着变淡。
  // 必须先摘掉，幽灵的观感由 .ecp-drag-ghost 自己控制。
  ghost.classList.remove("ecp-dragging");
  ghost.classList.add("ecp-drag-ghost");
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  ghost.querySelector(".ecp-del")?.remove();
  document.body.appendChild(ghost);
  DragState.ghost = ghost;
  moveGhost(ev.clientX, ev.clientY);

  updateDropMarker(editor, computeInsertBefore(editor, ev.clientX, ev.clientY));
}

function moveGhost(x, y) {
  const g = DragState.ghost;
  if (!g) return;
  g.style.left = `${x - DragState.offsetX}px`;
  g.style.top = `${y - DragState.offsetY}px`;
}

/** 结束拖动，按插入位重排 */
function finishDrag(editor, editorComp) {
  const { chunk, active } = DragState;
  const marker = DragState.marker;

  if (!active || !chunk) {
    dragCleanup();
    return false;
  }

  // ★ 关键：必须在 dragCleanup() 之前把插入点取出来 ★
  // cleanup 会把 marker 从 DOM 里摘掉，之后 marker.nextSibling 恒为 null，
  // 于是所有拖动都会被当成"放到末尾"，而 appendChild 在
  // "chunk 已经处于末尾附近"时会让节点被先摘后插、配合随后的事件
  // 造成节点丢失。
  const markerInEditor = marker?.parentNode === editor;
  const ref = markerInEditor ? marker.nextSibling : null;

  dragCleanup();

  if (!chunk.isConnected || !markerInEditor) return false;

  // 目标位置其实就是自己当前所在处 → 不用动
  if (ref === chunk) return false;

  if (ref && ref.parentNode === editor && ref !== chunk) {
    editor.insertBefore(chunk, ref);
  } else if (editor.lastChild !== chunk) {
    editor.appendChild(chunk);
  } else {
    return false;   // 已经在末尾，无需移动
  }

  editorComp?.syncToWidget(true);
  editorComp?.updateBarInfo?.();
  return true;
}

/* ------------------------------------------------------------------ */
/* 词块操作菜单（左键双击触发）                                          */
/* ------------------------------------------------------------------ */

let menuEl = null;

// 所有已展开的子菜单（它们直接挂在 document.body 上，
// 不受 menuEl.remove() 影响 —— 必须单独登记、统一清理）
let _openSubmenus = new Set();

function closeChunkMenu() {
  // ★ 先清子菜单 ★
  // 子菜单是独立 appendChild 到 body 的，只删 menuEl 会让它留在界面上。
  _openSubmenus.forEach((el) => el.remove());
  _openSubmenus.clear();
  menuEl?.remove();
  menuEl = null;
}

/** 通用浮层定位：优先出现在坐标右下方，超出视口则翻转 */
function placePopup(el, x, y, gap = 8) {
  el.style.visibility = "hidden";
  el.style.display = "block";
  const b = el.getBoundingClientRect();
  let px = x + gap, py = y + gap;
  if (px + b.width > window.innerWidth - 8) px = Math.max(8, x - b.width - gap);
  if (py + b.height > window.innerHeight - 8) py = Math.max(8, y - b.height - gap);
  el.style.left = `${px}px`;
  el.style.top = `${py}px`;
  el.style.visibility = "visible";
}

/**
 * 统一挂载一个浮层：加入 DOM、定位、登记为当前浮层、挂上"点别处关闭"。
 *
 * 这三步以前在三处（操作菜单 / 权重面板 / 类型选择器）手工复制，
 * 结果类型选择器漏掉了最后一步，表现为"点空白不消失"。
 * 收敛到这里，杜绝再次漏步。
 *
 * @param {HTMLElement} el  浮层根元素
 * @param {MouseEvent}  ev  触发事件（用于取定位坐标）
 * @returns {HTMLElement} 同一个元素，便于链式使用
 */
function mountPopup(el, ev) {
  document.body.appendChild(el);
  placePopup(el, ev.clientX, ev.clientY);
  menuEl = el;
  attachMenuDismiss(el);
  return el;
}

/**
 * 悬浮展开的子菜单项。
 *
 * 鼠标移到该项上时，在右侧弹出子菜单（由 build(subMenu) 填充内容）。
 * 用于「保存到词库」这类需要列出多个目标的场景。
 */
function addSubmenuItem(label, hint, parentMenu, build) {
  const item = document.createElement("div");
  item.className = "ecp-menu-item ecp-has-sub";
  const l = document.createElement("span");
  l.textContent = label;
  item.appendChild(l);
  if (hint) {
    const h = document.createElement("span");
    h.className = "ecp-menu-hint";
    h.textContent = hint;
    item.appendChild(h);
  }
  const arrow = document.createElement("span");
  arrow.className = "ecp-menu-arrow";
  arrow.textContent = "›";
  item.appendChild(arrow);

  let sub = null;
  const closeSub = () => {
    if (sub) {
      _openSubmenus.delete(sub);      // 注销登记
      sub.remove();
    }
    sub = null;
  };

  const openSub = () => {
    if (sub) return;
    sub = document.createElement("div");
    sub.className = "ecp-menu ecp-submenu";
    build(sub);
    document.body.appendChild(sub);
    _openSubmenus.add(sub);           // ★ 登记，供 closeChunkMenu 统一清理
    // 紧贴父项右侧展开
    const r = item.getBoundingClientRect();
    const sw = sub.offsetWidth, sh = sub.offsetHeight;
    let x = r.right + 4, y = r.top;
    if (x + sw > window.innerWidth - 8) x = r.left - sw - 4;
    if (y + sh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - sh - 8);
    sub.style.left = `${x}px`;
    sub.style.top = `${y}px`;
    sub.style.position = "fixed";
    sub.style.zIndex = "10001";
    // 子菜单自身不因鼠标移出而关闭
    sub.addEventListener("mousedown", (e) => e.stopPropagation());
  };

  item.addEventListener("mouseenter", openSub);
  item.addEventListener("mouseleave", () => setTimeout(() => {
    if (sub && !sub.matches(":hover")) closeSub();
  }, 180));
  item.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSub();
  });
  parentMenu.appendChild(item);
  return { item, closeSub };
}

/**
 * 填充「保存到词库」的子菜单：列出所有自定义词库。
 */
async function buildSaveTargetMenu(sub, chunk, editorComp) {
  sub.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ecp-menu-head";
  head.textContent = "保存到哪个词库";
  sub.appendChild(head);

  let dicts = [];
  try {
    const r = await fetch(`/${EXT}/dicts`);
    const d = await r.json();
    dicts = (d.dicts || []).filter((x) => !x.is_builtin);
  } catch (e) {
    LOG("读取词库失败", e);
  }
  if (!dicts.length) {
    const it = document.createElement("div");
    it.className = "ecp-menu-item";
    it.textContent = "（没有自定义词库）";
    sub.appendChild(it);
    return;
  }
  dicts.forEach((d) => {
    const it = document.createElement("div");
    it.className = "ecp-menu-item";
    const l = document.createElement("span");
    l.textContent = d.name;
    it.appendChild(l);
    const h = document.createElement("span");
    h.className = "ecp-menu-hint";
    h.textContent = `${d.count} 条`;
    it.appendChild(h);
    it.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeChunkMenu();
      await saveToCustomDict(chunk, editorComp, d.id);
      await refreshCustomIndex();
      toast(`已保存到「${d.name}」`);
    });
    sub.appendChild(it);
  });
}

function openChunkMenu(chunk, ev, editorComp) {
  closeChunkMenu();
  const menu = document.createElement("div");
  menu.className = "ecp-menu";
  menuEl = menu;

  const header = document.createElement("div");
  header.className = "ecp-menu-head";
  header.textContent = chunkLabel(chunk);
  header.title = chunk.dataset.en;
  menu.appendChild(header);

  const addItem = (label, hint, fn, cls) => {
    const it = document.createElement("div");
    it.className = "ecp-menu-item" + (cls ? ` ${cls}` : "");
    const l = document.createElement("span");
    l.textContent = label;
    it.appendChild(l);
    if (hint) {
      const h = document.createElement("span");
      h.className = "ecp-menu-hint";
      h.textContent = hint;
      it.appendChild(h);
    }
    it.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    menu.appendChild(it);
    return it;
  };

  const sep = () => {
    const s = document.createElement("div");
    s.className = "ecp-menu-sep";
    menu.appendChild(s);
  };

  // --- 编辑英文输出 ---
  addItem("编辑英文输出", chunk.dataset.en, () => {
    closeChunkMenu();
    inlineEdit(editorComp, chunk, "en");
  });

  // --- 编辑中文显示 ---
  addItem("编辑中文显示", chunk.dataset.cn || "（无）", () => {
    closeChunkMenu();
    inlineEdit(editorComp, chunk, "cn");
  });

  // --- 编辑类型 ---
  addItem("编辑类型", categoryLabel(chunk.dataset.category), () => {
    closeChunkMenu();
    openCategoryPicker(chunk, ev, editorComp);
  });

  // --- 设置权重 ---
  const w = chunkWeight(chunk);
  addItem("设置权重", w != null ? `当前 ${fmtWeight(w)}` : "默认 1.0", () => {
    closeChunkMenu();
    openWeightPanel(chunk, ev, editorComp);
  });

  // --- 翻译此词块（中文 → 英文）---
  addItem("翻译此词块", "中文→英文 / 英文→中文", () => {
    closeChunkMenu();
    editorComp.translateChunks([chunk]).then((n) => {
      if (n) toast(`已翻译为：${chunk.dataset.en}`);
      else toast("翻译失败或未返回结果", true);
    });
  });

  sep();

  // --- 复制英文 ---
  // （原「启用/禁用」项已按需求移除：单击词块即可切换禁用）
  addItem("复制英文", chunk.dataset.en, () => {
    closeChunkMenu();
    navigator.clipboard?.writeText(chunk.dataset.en);
  });

  // --- 自定义词库操作 ---
  // 「从自定义词库中删除」只对**确实存在于自定义库**的词条显示。
  //
  // ⚠️ 不能只看 chunk.dataset.saved：那个标记是运行时加的，
  // **不会随工作流序列化保存**，所以从保存的工作流里加载出来的
  // 自定义词条只有 source=custom、没有 saved，菜单会错误地显示"保存"。
  // 这里以**后端查询结果**为准（_customIndex 是启动时同步的库内条目集合）。
  // 自定义词库操作：按"这个词处于什么状态"决定给哪个入口
  //   已在自定义库   → 给「从自定义词库中删除」
  //   未收录         → 给「保存到自定义词库」（正是需要补录的场景）
  //   内置词库已有   → **两个都不给**（词库已经有了，存自定义没意义）
  const isSavedCustom = isInCustomDict(chunk.dataset.en, chunk.dataset.cn);
  const isUnlisted = chunk.dataset.unlisted === "1";

  if (isSavedCustom) {
    sep();
    addItem("从词库中删除", chunk.dataset.en, () => {
      closeChunkMenu();
      deleteFromCustomDict(chunk, editorComp);
    }, "ecp-menu-danger");
  } else if (isUnlisted || chunk.dataset.source === "custom") {
    sep();
    // 「保存到词库」= 带词库列表的子菜单（悬浮展开）
    addSubmenuItem("保存到词库", "", menu, (sub) => {
      buildSaveTargetMenu(sub, chunk, editorComp);
    });
  }

  mountPopup(menu, ev);
}

/* ------------------------------------------------------------------ */
/* 词库管理页面                                                        */
/* ------------------------------------------------------------------ */

let _dictMgrEl = null;

/** 打开词库管理弹窗 */
async function openDictManager(editorComp) {
  closeDictManager();
  _dictMgrDisposers = [];
  const wrap = document.createElement("div");
  wrap.className = "ecp-modal-mask";
  const box = document.createElement("div");
  box.className = "ecp-modal";
  box.innerHTML = `
    <div class="ecp-modal-head">
      <span>设置</span>
      <button class="ecp-modal-close" title="关闭">×</button>
    </div>
    <div class="ecp-settings-body">

      <section class="ecp-sec">
        <h4 class="ecp-sec-title">词库</h4>
        <div class="ecp-modal-tip">拖动排序，越靠上优先级越高。★ 默认为「一键收录」的目标。</div>
        <div class="ecp-dict-list"></div>
        <div class="ecp-sec-foot">
          <button class="ecp-bar-btn" data-act="create">＋ 新增词库</button>
          <button class="ecp-bar-btn" data-act="import">导入词库</button>
          <input type="file" class="ecp-import-file" accept=".json,.csv,.txt" hidden>
        </div>
      </section>

      <section class="ecp-sec">
        <h4 class="ecp-sec-title">自动分类</h4>
        <div class="ecp-modal-tip">置信度 ≥ 阈值才采纳，否则保留「待确认」。阈值越低采纳越多、错误越多。</div>
        <div class="ecp-conf-row">
          <input type="range" class="ecp-conf-range" min="0" max="0.99" step="0.01">
          <span class="ecp-conf-val">0.80</span>
        </div>
        <div class="ecp-sec-foot">
          <button class="ecp-bar-btn ecp-bar-ghost" data-act="conf-reset">恢复默认</button>
        </div>
      </section>

      <section class="ecp-sec">
        <h4 class="ecp-sec-title">词块类型顺序</h4>
        <div class="ecp-modal-tip">拖动调整「整理词块」时的先后。待确认固定最后。</div>
        <div class="ecp-catorder-list"></div>
        <div class="ecp-sec-foot">
          <button class="ecp-bar-btn ecp-bar-ghost" data-act="order-reset">恢复默认顺序</button>
        </div>
      </section>

    </div>
  `;
  wrap.appendChild(box);
  document.body.appendChild(wrap);
  _dictMgrEl = wrap;

  box.querySelector(".ecp-modal-close").addEventListener("click", closeDictManager);
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) closeDictManager(); });

  const listEl = box.querySelector(".ecp-dict-list");
  const fileEl = box.querySelector(".ecp-import-file");

  const reload = () => renderDictList(listEl, editorComp, reload);

  // 置信度滑块
  const confEl = box.querySelector(".ecp-conf-range");
  const confVal = box.querySelector(".ecp-conf-val");
  const syncConf = async () => {
    let v = 0.8;
    try {
      const r = await fetch(`/${EXT}/settings/confidence`);
      v = (await r.json()).confidence ?? 0.8;
    } catch (e) { LOG("读取置信度失败", e); }
    confEl.value = String(v);
    confVal.textContent = Number(v).toFixed(2);
    // 通知所有编辑器（下次分类生效）
    window.__ecpEditors?.forEach?.((ed) => { ed._confThreshold = v; });
  };
  syncConf();
  confEl.addEventListener("input", () => {
    confVal.textContent = Number(confEl.value).toFixed(2);
  });
  confEl.addEventListener("change", async () => {
    const v = Number(confEl.value);
    const r = await fetch(`/${EXT}/settings/confidence`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confidence: v }),
    });
    const j = await r.json();
    if (!j.ok) return toast(j.error, true);
    toast(`分类置信度阈值已设为 ${v.toFixed(2)}`);
    syncConf();
  });
  box.querySelector('[data-act="conf-reset"]').addEventListener("click", async () => {
    const r = await fetch(`/${EXT}/settings/confidence`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confidence: 0.8 }),
    });
    const j = await r.json();
    if (!j.ok) return toast(j.error, true);
    toast("已恢复默认阈值 0.80");
    syncConf();
  });

  // 类型顺序区块
  const orderEl = box.querySelector(".ecp-catorder-list");
  renderCategoryOrder(orderEl);
  box.querySelector('[data-act="order-reset"]').addEventListener("click", async () => {
    // 传空数组 → 后端清掉设置，回到 Anima 官方默认顺序
    const r = await fetch(`/${EXT}/settings/category_order`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: [] }),
    });
    const j = await r.json();
    if (!j.ok) return toast(j.error, true);
    toast("已恢复 Anima 官方顺序");
    renderCategoryOrder(orderEl);
  });

  box.querySelector('[data-act="create"]').addEventListener("click", async () => {
    const name = await inlinePrompt(box, "新词库名称", "");
    if (!name) return;
    const r = await fetch(`/${EXT}/dicts/create`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await r.json();
    if (!j.ok) return toast(`创建失败：${j.error}`, true);
    toast(`已创建词库「${j.name}」`);
    reload();
  });

  box.querySelector('[data-act="import"]').addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    const txt = await f.text();
    let payload;
    try { payload = JSON.parse(txt); } catch (_) { payload = { content: txt, name: f.name.replace(/\.[^.]+$/, "") }; }
    if (payload && payload.content === undefined && !payload.tags && !payload.items) {
      payload = { content: txt, name: f.name.replace(/\.[^.]+$/, "") };
    }
    const r = await fetch(`/${EXT}/dicts/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) return toast(`导入失败：${j.error}`, true);
    toast(`已导入 ${j.imported} 条到「${j.name}」`);
    fileEl.value = "";
    reload();
  });

  reload();
}

function closeDictManager() {
  // 主动清掉拖拽监听器（弹窗移除后 mousemove/mouseup 不会再触发清理逻辑）
  _dictMgrDisposers?.forEach((fn) => { try { fn(); } catch (_) {} });
  _dictMgrDisposers = [];
  _dictMgrEl?.remove();
  _dictMgrEl = null;
}

// 弹窗内各拖拽器的清理函数（关闭时统一调用）
let _dictMgrDisposers = [];

/** 渲染词库列表 */
async function renderDictList(listEl, editorComp, reload) {
  listEl.innerHTML = "";
  let dicts = [];
  try {
    const r = await fetch(`/${EXT}/dicts`);
    const d = await r.json();
    dicts = d.dicts || [];
  } catch (e) {
    listEl.textContent = "读取失败";
    return;
  }

  dicts.forEach((d, idx) => {
    const row = document.createElement("div");
    row.className = "ecp-dict-row" + (d.enabled ? "" : " ecp-dict-off");
    row.dataset.dictId = String(d.id);

    // 优先级序号
    const num = document.createElement("span");
    num.className = "ecp-dict-num";
    num.textContent = String(idx + 1);
    row.appendChild(num);

    // 名称
    const nm = document.createElement("span");
    nm.className = "ecp-dict-name";
    nm.textContent = d.name;
    if (d.is_builtin) {
      const tag = document.createElement("span");
      tag.className = "ecp-dict-builtin";
      tag.textContent = "内置";
      nm.appendChild(tag);
    }
    row.appendChild(nm);

    // 词条数
    const ct = document.createElement("span");
    ct.className = "ecp-dict-count";
    ct.textContent = d.is_builtin ? "329,728 条" : `${d.count} 条`;
    row.appendChild(ct);

    // 拖动把手（整行可拖，这里只是视觉提示）
    const grip = document.createElement("span");
    grip.className = "ecp-drag-grip";
    grip.textContent = "⠿";
    grip.title = "拖动调整顺序（越靠上优先级越高）";
    row.insertBefore(grip, row.firstChild);

    // 启用/禁用
    const tg = document.createElement("button");
    tg.className = "ecp-dict-btn" + (d.enabled ? " ecp-dict-on" : "");
    tg.textContent = d.enabled ? "已启用" : "已禁用";
    tg.title = "点击切换启用状态";
    tg.addEventListener("click", async () => {
      const r = await fetch(`/${EXT}/dicts/toggle`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, enabled: !d.enabled }),
      });
      const j = await r.json();
      if (!j.ok) return toast(j.error, true);
      await refreshCustomIndex();
      reload();
    });
    row.appendChild(tg);

    // 设为默认（一键收录的目标）
    if (!d.is_builtin) {
      const df = document.createElement("button");
      df.className = "ecp-dict-btn" + (d.is_default ? " ecp-dict-default" : "");
      df.textContent = d.is_default ? "★ 默认" : "设为默认";
      df.title = d.is_default
        ? "当前是「一键收录」的目标词库，点击可取消"
        : "设为「一键收录」的目标词库";
      df.addEventListener("click", async () => {
        const r = await fetch(`/${EXT}/dicts/set_default`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: d.is_default ? 0 : d.id }),
        });
        const j = await r.json();
        if (!j.ok) return toast(j.error, true);
        toast(d.is_default ? "已取消默认词库" : `已把「${d.name}」设为默认词库`);
        reload();
        // 通知所有编辑器刷新「一键收录」按钮状态
        window.__ecpEditors?.forEach?.((e) => e.refreshCollectButton?.());
      });
      row.appendChild(df);
    }

    // 导出
    const ex = document.createElement("button");
    ex.className = "ecp-dict-btn"; ex.textContent = "导出";
    ex.disabled = d.is_builtin;
    ex.title = d.is_builtin ? "内置词库不支持导出" : "导出为 JSON 文件";
    ex.addEventListener("click", () => {
      window.open(`/${EXT}/dicts/export?id=${d.id}&format=json`, "_blank");
    });
    row.appendChild(ex);

    // 重命名
    const rn = document.createElement("button");
    rn.className = "ecp-dict-btn"; rn.textContent = "重命名";
    rn.disabled = d.is_builtin;
    rn.title = d.is_builtin ? "内置词库不可重命名" : "重命名词库";
    rn.addEventListener("click", async () => {
      const name = await inlinePrompt(row.closest(".ecp-modal"), "新名称", d.name);
      if (!name || name === d.name) return;
      const r = await fetch(`/${EXT}/dicts/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, name }),
      });
      const j = await r.json();
      if (!j.ok) return toast(j.error, true);
      await refreshCustomIndex();
      reload();
    });
    row.appendChild(rn);

    // 删除
    const del = document.createElement("button");
    del.className = "ecp-dict-btn ecp-dict-danger"; del.textContent = "删除";
    del.disabled = d.is_builtin;
    del.title = d.is_builtin ? "内置词库不可删除" : "删除该词库及其全部词条";
    del.addEventListener("click", async () => {
      if (!confirm(`确定删除词库「${d.name}」及其 ${d.count} 条词条？此操作不可恢复。`)) return;
      const r = await fetch(`/${EXT}/dicts/delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id }),
      });
      const j = await r.json();
      if (!j.ok) return toast(j.error, true);
      await refreshCustomIndex();
      reload();
    });
    row.appendChild(del);

    listEl.appendChild(row);
  });

  // ★ 整行拖拽排序（替代原来的 ↑↓ 按钮）★
  _dictMgrDisposers.push(enableListDrag(
    [...listEl.querySelectorAll(".ecp-dict-row")],
    listEl,
    {
      axis: "y",
      onDrop: async (ordered) => {
        const ids = ordered.map((el) => Number(el.dataset.dictId));
        const r = await fetch(`/${EXT}/dicts/reorder`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: ids }),
        });
        const j = await r.json();
        if (!j.ok) return toast(j.error, true);
        reload();     // 重渲染，序号同步更新
      },
    },
  ));
}

/** 上移/下移词库并保存顺序 */
async function moveDict(dicts, idx, delta, reload) {
  const j = idx + delta;
  if (j < 0 || j >= dicts.length) return;
  const arr = dicts.slice();
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
  const r = await fetch(`/${EXT}/dicts/reorder`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: arr.map((d) => d.id) }),
  });
  const res = await r.json();
  if (!res.ok) return toast(res.error, true);
  reload();
}

/** 弹窗内联输入（避免原生 prompt 被浏览器拦截/样式突兀） */
function inlinePrompt(host, label, initial = "") {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ecp-inline-mask";
    const box = document.createElement("div");
    box.className = "ecp-inline-box";
    const lb = document.createElement("div");
    lb.className = "ecp-inline-label";
    lb.textContent = label;
    const inp = document.createElement("input");
    inp.className = "ecp-inline-input";
    inp.value = initial;
    const row = document.createElement("div");
    row.className = "ecp-inline-row";
    const ok = document.createElement("button");
    ok.className = "ecp-bar-btn"; ok.textContent = "确定";
    const no = document.createElement("button");
    no.className = "ecp-bar-btn ecp-bar-ghost"; no.textContent = "取消";
    row.append(ok, no);
    box.append(lb, inp, row);
    mask.appendChild(box);
    (host || document.body).appendChild(mask);

    const done = (v) => { mask.remove(); resolve(v); };
    ok.addEventListener("click", () => done(inp.value.trim()));
    no.addEventListener("click", () => done(null));
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") done(inp.value.trim());
      if (e.key === "Escape") done(null);
    });
    setTimeout(() => inp.focus(), 30);
  });
}



/* ------------------------------------------------------------------ */
/* 列表拖拽排序（通用）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 让一批元素支持鼠标拖拽排序。
 *
 * 交互与编辑框里的词块拖动保持一致：
 *   · 按下后移动超过阈值才开始拖
 *   · 有个半透明幽灵跟着鼠标
 *   · 目标位置显示蓝色插入位
 *
 * @param {HTMLElement[]} items  参与排序的元素（按当前顺序）
 * @param {HTMLElement}   host   容器
 * @param {object} opts
 *   opts.axis     "x" 横向 | "y" 纵向（默认按容器 flex-direction 判断）
 *   opts.locked   (el)=>bool  某些元素不可拖动
 *   opts.onDrop   (newOrder: HTMLElement[])=>void  放下后的回调
 */
function enableListDrag(items, host, opts = {}) {
  const THRESHOLD = 5;
  const locked = opts.locked || (() => false);
  const axis = opts.axis || (getComputedStyle(host).flexWrap !== "nowrap"
    && getComputedStyle(host).display.includes("flex") ? "x" : "y");

  let st = null;   // {el, startX, startY, armed, ghost, marker, moved}

  const cleanup = () => {
    if (!st) return;
    st.ghost?.remove();
    st.marker?.remove();
    st.el?.classList.remove("ecp-dragging");
    document.body.classList.remove("ecp-dragging-active");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    st = null;
  };

  /** 算出拖动元素应插到哪个位置，返回目标元素（插到它前面）或 null 表示末尾 */
  const targetAt = (x, y) => {
    // 被拖动元素本身仍在 DOM 里，要排除掉再算
    const others = items.filter((el) => el !== st.el && el.isConnected);
    if (!others.length) return null;

    if (axis === "y") {
      // 纵向列表：只看 y
      for (const el of others) {
        const r = el.getBoundingClientRect();
        if (y < r.top + r.height / 2) return el;
      }
      return null;
    }

    // ★ 横向**自动换行**布局：必须先按「行」定位，再在行内按 x 定位 ★
    //
    // 旧实现只比较 x，完全忽略 y —— 换行后拖到第二行时，
    // x 可能仍小于第一行某元素的中心，于是被判定插回第一行，
    // 表现为"拖不到第二行"。
    //
    // 做法：把 others 按行的 y 分组（用 top 归并，容差取半个行高），
    // 先选出鼠标所在的那一行，再在该行内用 x 判断插到谁前面。
    const rects = others.map((el) => ({ el, r: el.getBoundingClientRect() }));
    const rowTol = Math.max(4, (rects[0]?.r.height || 20) / 2);

    // 按 top 归并成行
    const rows = [];
    for (const it of rects) {
      let row = rows.find((rw) => Math.abs(rw.top - it.r.top) <= rowTol);
      if (!row) {
        row = { top: it.r.top, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }
    rows.sort((a, b) => a.top - b.top);
    rows.forEach((rw) => rw.items.sort((a, b) => a.r.left - b.r.left));

    if (!rows.length) return null;

    // 鼠标在哪一行：y 落在行范围内就选它；否则取最近的一行
    let cur = rows.find((rw) => {
      const first = rw.items[0].r;
      return y >= first.top - rowTol && y <= first.bottom + rowTol;
    });
    if (!cur) {
      cur = rows.reduce((best, rw) => {
        const d = Math.abs(rw.top - y);
        return (!best || d < best.d) ? { row: rw, d } : best;
      }, null).row;
    }

    // 在行内按 x 找插入点
    for (const it of cur.items) {
      if (x < it.r.left + it.r.width / 2) return it.el;
    }
    // 落在本行末尾：插到本行最后一个元素的**后面**
    // （返回 null 会跑到整个列表末尾，所以返回下一行的第一个元素）
    const idx = rows.indexOf(cur);
    if (idx < rows.length - 1) return rows[idx + 1].items[0].el;
    return null;   // 已是最后一行 → 末尾
  };

  const placeMarker = (target) => {
    if (!st.marker) {
      st.marker = document.createElement("div");
      st.marker.className = "ecp-drop-marker";
      if (axis === "x") st.marker.classList.add("ecp-drop-marker-v");
      host.appendChild(st.marker);
    }
    if (target) host.insertBefore(st.marker, target);
    else host.appendChild(st.marker);
  };

  const onMove = (e) => {
    if (!st) return;
    // 宿主被移除（弹窗关闭）→ 立即清理，避免监听器残留
    if (!host.isConnected) { cleanup(); return; }
    if (!st.moved) {
      if (Math.abs(e.clientX - st.startX) < THRESHOLD
          && Math.abs(e.clientY - st.startY) < THRESHOLD) return;
      st.moved = true;
      st.el.classList.add("ecp-dragging");
      document.body.classList.add("ecp-dragging-active");
      placeMarker(null);
    }
    e.preventDefault();
    if (st.ghost) {
      st.ghost.style.left = `${e.clientX + 12}px`;
      st.ghost.style.top = `${e.clientY + 8}px`;
    }
    placeMarker(targetAt(e.clientX, e.clientY));
  };

  const onUp = () => {
    if (!st) return;
    if (!host.isConnected) { cleanup(); return; }
    const moved = st.moved;
    const dragged = st.el;
    const marker = st.marker;
    const ref = marker ? marker.nextSibling : null;   // ★ 先取引用，cleanup 会删掉 marker
    const atEnd = marker && !marker.nextSibling;

    cleanup();

    if (!moved) return;          // 没移动 → 交给 click 处理

    // 按 marker 的位置把元素插回去
    if (ref) host.insertBefore(dragged, ref);
    else if (atEnd || !ref) host.appendChild(dragged);

    const newOrder = [...host.children].filter((el) => items.includes(el));
    opts.onDrop?.(newOrder);
  };

  items.forEach((el) => {
    if (locked(el)) return;
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // 点在按钮上时不启动拖动（让按钮正常工作）
      if (e.target.closest("button")) return;
      st = {
        el, startX: e.clientX, startY: e.clientY,
        moved: false, ghost: null, marker: null,
      };
      // 幽灵：克隆一份跟着鼠标
      const r = el.getBoundingClientRect();
      const g = el.cloneNode(true);
      g.classList.add("ecp-drag-ghost");
      g.style.width = `${r.width}px`;
      g.style.height = `${r.height}px`;
      st.ghost = g;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });

  return cleanup;
}

/* ------------------------------------------------------------------ */
/* 类型顺序（设置页面内，拖拽排序）                                     */
/* ------------------------------------------------------------------ */

/**
 * 渲染「词块类型顺序」列表。
 *
 * 用原生 HTML5 拖拽（比上一版词块拖动简单：这里只是行与行交换）。
 * 「待确认」(21) 固定最后，不可拖动。
 */
async function renderCategoryOrder(host) {
  host.innerHTML = "";
  let order = [];
  try {
    const r = await fetch(`/${EXT}/settings/category_order`);
    const j = await r.json();
    order = j.order || [];
  } catch (e) {
    LOG("读取类型顺序失败", e);
    return;
  }
  const cats = window.__ECP_CATEGORIES || {};

  const els = [];
  order.forEach((catId) => {
    const info = cats[String(catId)] || { label: `类型${catId}`, color: "#888" };
    const locked = catId === 21;          // 待确认固定最后

    // ★ 渲染成「词块」的样子：圆角小块 + 类型配色的填充 ★
    const el = document.createElement("span");
    el.className = "ecp-catorder-chip" + (locked ? " ecp-catorder-locked" : "");
    el.dataset.cat = String(catId);
    el.style.background = info.color;
    el.style.color = pickFg(info.color);
    el.textContent = info.label;
    el.title = locked
      ? "「待确认」固定排在最后，不可拖动"
      : "拖动调整顺序（决定「整理词块」时哪类排前面）";
    if (locked) {
      const lock = document.createElement("span");
      lock.className = "ecp-catorder-lock";
      lock.textContent = "🔒";
      el.appendChild(lock);
    }
    host.appendChild(el);
    els.push(el);
  });

  // ★ 用与编辑框词块一致的鼠标拖拽（幽灵 + 插入位）★
  _dictMgrDisposers.push(enableListDrag(els, host, {
    axis: "x",
    locked: (el) => el.classList.contains("ecp-catorder-locked"),
    onDrop: async (ordered) => {
      const ids = ordered.map((el) => Number(el.dataset.cat));
      const r = await fetch(`/${EXT}/settings/category_order`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: ids }),
      });
      const j = await r.json();
      if (!j.ok) return toast(j.error, true);
      renderCategoryOrder(host);        // 重渲染（待确认会被后端挪到最后）
    },
  }));
}

/** 按背景色亮度挑一个对比够的字体色 */
function pickFg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#e8e8ec";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // 相对亮度（sRGB 近似）
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1a1a1e" : "#f2f2f6";
}

/* ------------------------------------------------------------------ */
/* 菜单自动关闭                                                        */
/* ------------------------------------------------------------------ */

let _menuDismiss = null;

function detachMenuDismiss() {
  if (!_menuDismiss) return;
  const d = _menuDismiss;
  document.removeEventListener("mousedown", d.onDown, true);
  document.removeEventListener("pointerdown", d.onDown, true);
  document.removeEventListener("wheel", d.onWheel, true);
  document.removeEventListener("keydown", d.onKey, true);
  window.removeEventListener("blur", d.onBlur);
  _menuDismiss = null;
}

/**
 * 让菜单在下列情况关闭：
 *   - 点击/右键/触摸菜单以外的地方（含 LiteGraph 画布空白处）
 *   - 在画布上滚轮缩放或拖动
 *   - 按 Esc
 *   - 窗口失焦
 *
 * 画布上的交互走 pointerdown / wheel，单靠 document 的 mousedown 捕不到，
 * 所以这里同时监听多类事件。
 */
function attachMenuDismiss(menu) {
  detachMenuDismiss();

  const inside = (target) => {
    if (menu.contains(target)) return true;
    // 类型选择器等二级浮层也算"菜单内部"
    if (menuEl && menuEl !== menu && menuEl.contains(target)) return true;
    // ★ 子菜单（挂在 body 上的独立浮层）同样算内部 ★
    // 否则点子菜单项会被当成"外部点击"，关闭时机与子菜单自身的
    // mousedown 处理竞争，导致子菜单残留不消失。
    for (const sub of _openSubmenus) {
      if (sub.contains(target)) return true;
    }
    return false;
  };

  const d = {
    onDown: (e) => {
      if (!menu.isConnected) return detachMenuDismiss();
      if (!inside(e.target)) closeChunkMenu();
    },
    onWheel: (e) => {
      if (!menu.isConnected) return detachMenuDismiss();
      // 菜单自身的滚动不关闭
      if (inside(e.target)) return;
      closeChunkMenu();
    },
    onKey: (e) => {
      if (e.key === "Escape") closeChunkMenu();
    },
    onBlur: () => closeChunkMenu(),
  };

  _menuDismiss = d;
  // 延迟一帧挂载，避免把"打开菜单的那次点击"当成外部点击
  requestAnimationFrame(() => {
    if (_menuDismiss !== d) return;
    document.addEventListener("mousedown", d.onDown, true);
    document.addEventListener("pointerdown", d.onDown, true);
    document.addEventListener("wheel", d.onWheel, true);
    document.addEventListener("keydown", d.onKey, true);
    window.addEventListener("blur", d.onBlur);
  });
}

function categoryLabel(cat) {
  const info = (window.__ECP_CATEGORIES || {})[String(cat)];
  return info?.label || (cat === "0" ? "常规" : `类别 ${cat}`);
}

/**
 * 权重设置面板：滑块 + 数字输入框 + 常用值快捷按钮。
 *
 * 输出语法是 A1111 标准 `(tag:1.2)`；权重为 1.0 时不加任何后缀。
 */
function openWeightPanel(chunk, ev, editorComp) {
  const panel = document.createElement("div");
  panel.className = "ecp-menu ecp-weight";

  const cur = chunkWeight(chunk);
  let value = cur != null ? cur : 1.0;

  const head = document.createElement("div");
  head.className = "ecp-menu-head";
  head.textContent = `权重 · ${chunkLabel(chunk)}`;
  panel.appendChild(head);

  // ---- 数字输入 ----
  const row = document.createElement("div");
  row.className = "ecp-weight-row";

  // 权重的可调上限（滑块与数字输入一致）
  const W_MAX = 5;

  const input = document.createElement("input");
  input.type = "number";
  input.className = "ecp-weight-input";
  input.min = "0";
  input.max = String(W_MAX);
  input.step = "0.05";
  input.value = fmtWeight(value);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "ecp-weight-slider";
  slider.min = "0";
  slider.max = String(W_MAX);      // ★ 上限 5（原为 2）
  slider.step = "0.05";
  slider.value = String(value);

  row.append(input, slider);
  panel.appendChild(row);

  const sync = (v) => {
    value = Math.max(0, Math.min(W_MAX, Number(v) || 0));
    input.value = fmtWeight(value);
    slider.value = String(value);   // 两者范围已一致，无需再截断
  };

  slider.addEventListener("input", () => sync(slider.value));
  input.addEventListener("input", () => sync(input.value));

  // ---- 常用值 ----
  const quick = document.createElement("div");
  quick.className = "ecp-weight-quick";
  for (const v of [0.5, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5]) {
    const b = document.createElement("button");
    b.className = "ecp-weight-chip";
    b.textContent = v.toFixed(1);
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sync(v);
    });
    quick.appendChild(b);
  }
  panel.appendChild(quick);

  // ---- 操作按钮 ----
  const actions = document.createElement("div");
  actions.className = "ecp-weight-actions";

  const mkBtn = (label, fn, cls) => {
    const b = document.createElement("button");
    b.className = "ecp-weight-btn" + (cls ? ` ${cls}` : "");
    b.textContent = label;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    return b;
  };

  const apply = () => {
    if (Math.abs(value - 1) < 1e-9) {
      delete chunk.dataset.weight;          // 1.0 视为无权重
    } else {
      chunk.dataset.weight = fmtWeight(value);
    }
    paintChunk(chunk);
    editorComp.syncToWidget(true);
    panel.remove();
    menuEl = null;
  };

  actions.append(
    mkBtn("确定", apply, "ecp-weight-ok"),
    mkBtn("清除权重", () => {
      delete chunk.dataset.weight;
      paintChunk(chunk);
      editorComp.syncToWidget(true);
      panel.remove();
      menuEl = null;
    }, "ecp-weight-clear")
  );
  panel.appendChild(actions);

  // 回车确认 / Esc 取消
  panel.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); apply(); }
    else if (e.key === "Escape") {
      e.preventDefault();
      panel.remove();
      menuEl = null;
    }
  });

  mountPopup(panel, ev);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

/** 类型选择浮层 */
function openCategoryPicker(chunk, ev, editorComp) {
  const picker = document.createElement("div");
  picker.className = "ecp-menu ecp-picker";

  const cats = window.__ECP_CATEGORIES || {};
  const entries = Object.entries(cats).sort((a, b) => Number(a[0]) - Number(b[0]));
  const cur = chunk.dataset.category || "0";

  entries.forEach(([id, info]) => {
    const it = document.createElement("div");
    it.className = "ecp-menu-item" + (id === cur ? " ecp-menu-cur" : "");
    const dot = document.createElement("span");
    dot.className = "ecp-dot";
    dot.style.background = info.color;
    const l = document.createElement("span");
    l.textContent = info.label;
    it.append(dot, l);
    if (id === cur) {
      const h = document.createElement("span");
      h.className = "ecp-menu-hint";
      h.textContent = "当前";
      it.appendChild(h);
    }
    it.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const before = {
        en: chunk.dataset.en,
        cn: chunk.dataset.cn,
        category: chunk.dataset.category,
      };
      chunk.dataset.category = id;
      // 只改类型。填充色随之变化（paintChunk 按类型上色），
      // 而虚线外框仍表示"未收录" —— 两个维度互不干扰。
      paintChunk(chunk);
      picker.remove();
      menuEl = null;
      editorComp.syncToWidget(true);
      // ★ 已收录的词 → 类型改动同步回词库 ★
      syncChunkToLexicon(chunk, before, {
        en: chunk.dataset.en,
        cn: chunk.dataset.cn,
        category: chunk.dataset.category,
      });
    });
    picker.appendChild(it);
  });

  mountPopup(picker, ev);
}

/** 就地编辑：把词块临时换成输入框 */
function inlineEdit(editorComp, chunk, field) {
  const isEn = field === "en";
  const cur = isEn ? chunk.dataset.en : chunk.dataset.cn;
  const label = chunkLabel(chunk);

  const input = document.createElement("input");
  input.className = "ecp-inline-input";
  input.value = cur || "";
  input.placeholder = isEn ? "英文输出内容" : "中文显示内容";
  input.style.width = `${Math.max(120, label.length * 16 + 60)}px`;

  // ★ 改动前的快照要在**打开编辑框时**就抓，不能等到 commit ★
  //
  // commit 可能被触发两次（Enter 后紧接 blur）。第一次已经改了 chunk，
  // 第二次再读 chunk 拿到的就是"新值"，于是 before === after，
  // 同步逻辑判定"没有变化"直接跳过 —— 表现为"改了但词库没同步"。
  const snapshot = {
    en: chunk.dataset.en,
    cn: chunk.dataset.cn,
    category: chunk.dataset.category,
  };

  let committed = false;      // 防止 Enter 后紧接 blur 触发两次

  const commit = (save) => {
    if (committed || !input.isConnected) return;
    committed = true;
    const v = input.value.trim();
    const before = { ...snapshot };

    if (save) {
      if (isEn) {
        if (v) chunk.dataset.en = v;
      } else {
        chunk.dataset.cn = v;
      }
      paintChunk(chunk);
    }
    input.replaceWith(chunk);

    if (save) {
      // 无论是否保存都要同步一次：节点执行读的是隐藏 widget 的值，
      // 漏掉这一步就会出现"界面上改了、输出里没有这个词"。
      editorComp.syncToWidget(true);

      // ★ 已收录的词 → 改动同步回词库 ★
      const after = {
        en: chunk.dataset.en,
        cn: chunk.dataset.cn,
        category: chunk.dataset.category,
      };
      syncChunkToLexicon(chunk, before, after);
    }
    editorComp.editor.focus();
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());

  chunk.replaceWith(input);
  input.focus();
  input.select();
}

/** 保存到自定义词库（一期：写本地库文件） */
async function saveToCustomDict(chunk, editorComp, dictId = 0) {
  const en = chunk.dataset.en;
  const cn = chunk.dataset.cn || en;
  const category = Number(chunk.dataset.category || 0);
  try {
    const r = await fetch(`/${EXT}/custom/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ en, cn, category, dict_id: dictId || 0 }),
    });
    const j = await r.json();
    if (j.ok) {
      chunk.dataset.source = "custom";
      chunk.dataset.saved = "1";
      delete chunk.dataset.unlisted;
      delete chunk.dataset.typed;      // 已入库，typed 标记不再需要
      paintChunk(chunk);
      editorComp.syncToWidget(true);
      await refreshCustomIndex();     // 刷新索引，下次右键即显示"删除"
      toast(`已保存到自定义词库：${cn} → ${en}`);
    } else {
      toast(`保存失败：${j.error || "未知错误"}`, true);
    }
  } catch (e) {
    toast(`保存失败：${e.message}`, true);
  }
}

/**
 * 从自定义词库中删除该词条。
 * 只删除库里的记录，**不删除编辑框里的词块**，用户可自行决定是否移除。
 */
async function deleteFromCustomDict(chunk, editorComp) {
  const en = chunk.dataset.en;
  const cn = chunk.dataset.cn || en;
  try {
    const r = await fetch(`/${EXT}/custom/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ en, cn }),
    });
    const j = await r.json();
    if (j.ok) {
      // 词块本身保留，只是不再是"已入库"状态
      delete chunk.dataset.saved;
      delete chunk.dataset.typed;      // 回到未收录，重新用橙色提醒
      chunk.dataset.source = "builtin";
      chunk.dataset.unlisted = "1";   // 回到"未收录"，提示用户可重新保存
      paintChunk(chunk);
      editorComp.syncToWidget(true);
      await refreshCustomIndex();     // 刷新索引，菜单回到"保存"
      toast(`已从自定义词库删除：${cn} → ${en}`);
    } else {
      toast(`删除失败：${j.error || "未知错误"}`, true);
    }
  } catch (e) {
    toast(`删除失败：${e.message}`, true);
  }
}

/* ------------------------------------------------------------------ */
/* 轻提示                                                              */
/* ------------------------------------------------------------------ */

let toastEl = null, toastTimer = null;
function toast(msg, isErr) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "ecp-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.toggle("ecp-toast-err", !!isErr);
  toastEl.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, 2200);
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

let tipEl = null;
function showTip(chunk, ev) {
  const cat = Number(chunk.dataset.category || 0);
  const info = (window.__ECP_CATEGORIES || {})[String(cat)] || {};
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "ecp-tip";
    document.body.appendChild(tipEl);
  }
  // 来源判定分三种，且**自定义词库要显示具体是哪个库**：
  //   未收录   —— 用户自己输入、词库里查不到的
  //   自定义   —— 已保存进自定义词库的，显示**词库名**（如「补充词库」）
  //   内置     —— 来自 tag.sqlite
  // 按**实际状态**判定，不依赖可能过期的 dataset 标记。
  const customRec = customEntry(chunk.dataset.en, chunk.dataset.cn);
  const src = customRec
    ? (customRec.dictName || "自定义词库")
    : (chunk.dataset.unlisted === "1" ? "未收录" : "内置词库");
  const wTip = chunkWeight(chunk);
  tipEl.innerHTML =
    `<div><span class="ecp-tip-k">英文</span><b>${chunk.dataset.en}</b></div>` +
    `<div><span class="ecp-tip-k">中文</span>${chunk.dataset.cn || "（无）"}</div>` +
    `<div><span class="ecp-tip-k">类型</span>${info.label || cat}</div>` +
    (wTip != null
      ? `<div><span class="ecp-tip-k">权重</span>${fmtWeight(wTip)} → <b>(${chunk.dataset.en}:${fmtWeight(wTip)})</b></div>`
      : "") +
    `<div><span class="ecp-tip-k">来源</span>${src}</div>` +
    `<div><span class="ecp-tip-k">状态</span>${chunk.dataset.disabled ? "已禁用（不输出）" : "正常输出"}</div>`;
  tipEl.style.display = "block";
  const b = tipEl.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + b.width > window.innerWidth - 8) x = ev.clientX - b.width - 14;
  if (y + b.height > window.innerHeight - 8) y = ev.clientY - b.height - 14;
  tipEl.style.left = `${Math.max(4, x)}px`;
  tipEl.style.top = `${Math.max(4, y)}px`;
}
function hideTip() { if (tipEl) tipEl.style.display = "none"; }

/* ------------------------------------------------------------------ */
/* 旧工作流兼容                                                        */
/* ------------------------------------------------------------------ */

/**
 * 归一化旧版本工作流留下的控件值。
 *
 * 历史包袱：节点参数经历过多次调整（新增 base_model、新增 trans_model、
 * 移除 separator / escape_parens），而 ComfyUI 的 widgets_values 是**按位置**
 * 赋值的数组，旧工作流加载时很容易把值灌到错误的控件上。
 *
 * 这里不再做"逐字段搬运"（越搬越复杂），改为**按控件类型做值域校正**：
 * 每个下拉只接受自己候选列表里的值，不合法就退回默认值。
 * 这样无论旧数组怎么错位，最终状态都是合法的。
 */
function migrateWidgetValues(node) {
  const byName = (n) => node.widgets?.find((w) => w.name === n);

  // base_model：只接受注册过的候选项
  const wBase = byName("base_model");
  if (wBase) {
    const opts = (wBase.options?.values) || [];
    if (Array.isArray(opts) && opts.length && !opts.includes(wBase.value)) {
      wBase.value = opts[0];
    }
  }

  // mode：只接受「替换 / 追加」
  const wMode = byName("mode");
  if (wMode && wMode.value !== "替换" && wMode.value !== "追加") {
    wMode.value = "替换";
  }

  // trans_model：只接受当前扫描到的模型名
  const wTrans = byName("trans_model");
  if (wTrans) {
    const opts = (wTrans.options?.values) || [];
    if (Array.isArray(opts) && opts.length && !opts.includes(wTrans.value)) {
      wTrans.value = opts[0];
    }
  }

  // 已移除的 separator / escape_parens 不再处理 —— 它们已不在 widget 列表里，
  // 后端也固定使用 ", "。
}

/* ------------------------------------------------------------------ */
/* 全局辅助                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把所有 EasyCNPrompt 节点的编辑器内容立刻写回 widget。
 *
 * 用于"执行前"兜底：粘贴/连线转换是异步的（要 await fetch 查词库），
 * 如果用户粘贴后马上点执行，ComfyUI 会读到尚未更新的 widget，
 * 输出就会是空的、或停留在未翻译的纯文本状态。
 *
 * 这里会先等所有进行中的转换结束，再统一 flush。
 */
function flushAllEditors() {
  const graph = app.graph;
  if (!graph) return Promise.resolve();
  const waits = [];
  for (const node of graph._nodes || []) {
    const ed = node.__ecpEditor;
    if (!ed) continue;
    if (ed._pending) waits.push(ed._pending.catch(() => {}));
  }
  return Promise.all(waits).then(() => {
    for (const node of graph._nodes || []) {
      const ed = node.__ecpEditor;
      if (ed?.syncToWidget) {
        try { ed.syncToWidget(true); } catch (_) { /* 单个节点失败不影响其他 */ }
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 自定义词库索引                                                      */
/* ------------------------------------------------------------------ */

// 自定义库里的条目：键 "en\u0000cn" → {dictId, dictName, category}
// 启动时与每次增删后刷新。
// ⚠️ 除了"是否存在"，还要记住**来自哪个词库** ——
// 改动已收录词时要同步回**原词库**，不能一律丢进默认库。
let _customIndex = new Map();
let _customIndexReady = false;

/** 取该词在自定义库里的记录（找不到返回 null） */
function customEntry(en, cn) {
  if (!en) return null;
  const e = String(en);
  const c = String(cn || e);
  // 先按 (en, cn) 精确找
  const exact = _customIndex.get(`${e}\u0000${c}`) || _customIndex.get(`${e}\u0000${e}`);
  if (exact) return exact;
  // ★ 回退：只按 en 找 ★
  // 用户改中文显示名后，cn 已经和词库里存的不一样了，
  // 用新 cn 精确匹配会查不到 —— 但英文（主键）没变，仍能定位到原条目。
  for (const rec of _customIndex.values()) {
    if (rec.en === e) return rec;
  }
  return null;
}

/** 改动前用：按旧值找条目。en 变了就找不到（那是重命名，需另想办法） */
function customEntryByEn(en) {
  if (!en) return null;
  const e = String(en);
  for (const rec of _customIndex.values()) {
    if (rec.en === e) return rec;
  }
  return null;
}

/** 该词是否已存在于自定义词库 */
function isInCustomDict(en, cn) {
  return !!customEntry(en, cn);
}

/** 从后端拉取自定义库条目，建立索引 */
async function refreshCustomIndex() {
  try {
    const r = await fetch(`/${EXT}/custom/list`);
    const d = await r.json();
    const m = new Map();
    for (const it of d.results || []) {
      m.set(`${it.en}\u0000${it.cn || it.en}`, {
        en: it.en,
        cn: it.cn || it.en,
        dictId: it.dict_id,
        dictName: it.dict_name || "",
        category: it.category,
      });
    }
    _customIndex = m;
    _customIndexReady = true;
  } catch (e) {
    LOG("刷新自定义库索引失败", e);
  }
}

/**
 * 把词块的改动同步回它所属的词库。
 *
 * 规则（与需求方确认）：
 *   · 只同步**已收录**的词（来自自定义词库）；未收录的不动
 *   · 内置词库是只读数据，**不同步**
 *   · 改英文 = 重命名（删旧条目 + 增新条目）
 *   · 同步失败**不回滚界面**，只提示（不影响当前工作）
 *
 * @param {HTMLElement} chunk
 * @param {object} before 改动前的 {en, cn, category}
 * @param {object} after  改动后的 {en, cn, category}
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function syncChunkToLexicon(chunk, before, after) {
  const rec = customEntry(before.en, before.cn);

  // ★ 不在自定义库时的两种处理 ★
  if (!rec) {
    const unlisted = chunk.dataset.unlisted === "1";
    // ① 未收录 → 无需同步（它本来就不在任何词库里）
    if (unlisted) return { ok: true, reason: "not-collected" };

    // ② 内置词库的词 → **直接改 tag.sqlite**（需求方明确要求，§12X）
    //    只处理"类型变了"；英文/中文改动不写库（内置库的中文名是
    //    官方译文，被本地改动反而不好，且改名会破坏标签主键）。
    const catChanged = Number(before.category || 0) !== Number(after.category || 0);
    if (!catChanged) return { ok: true, reason: "builtin-no-change" };
    try {
      const r = await fetch(`/${EXT}/builtin/set_category`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ en: after.en, category: Number(after.category || 0) }),
      });
      const j = await r.json();
      if (!j.ok) {
        toast(`内置词库写入失败：${j.error || "未知错误"}`, true);
        return { ok: false, reason: j.error };
      }
      return { ok: true, reason: "builtin-updated" };
    } catch (e) {
      toast(`内置词库写入失败：${e.message}`, true);
      return { ok: false, reason: e.message };
    }
  }

  if (!rec.dictId) return { ok: true, reason: "no-dict" };

  // 抓「保存到词库」的保存按钮…… 不，直接用接口：
  // 先删旧条目（英文变了则必须删），再按新值写入
  try {
    const enChanged = String(before.en) !== String(after.en);
    const cnChanged = String(before.cn || "") !== String(after.cn || "");
    const catChanged = Number(before.category || 0) !== Number(after.category || 0);
    if (!enChanged && !cnChanged && !catChanged) return { ok: true, reason: "no-change" };

    // 统一「先删旧、再写新」：
    //   · 英文变了 → 相当于重命名（英文是主键，必须删）
    //   · 只有中文/类型变了 → 删掉再写，避免 UNIQUE(en,cn) 冲突
    await fetch(`/${EXT}/custom/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ en: before.en, cn: before.cn, dict_id: rec.dictId }),
    });

    const r = await fetch(`/${EXT}/custom/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        en: after.en,
        cn: after.cn || after.en,
        category: Number(after.category || 0),
        dict_id: rec.dictId,
      }),
    });
    const j = await r.json();
    if (!j.ok) {
      toast(`词库同步失败：${j.error || "未知错误"}（界面已改，词库未更新）`, true);
      return { ok: false, reason: j.error };
    }
    await refreshCustomIndex();
    return { ok: true };
  } catch (e) {
    toast(`词库同步失败：${e.message}（界面已改，词库未更新）`, true);
    return { ok: false, reason: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 调试钩子（便于自动化测试 / 控制台排查）                                */
/* ------------------------------------------------------------------ */

if (typeof window !== "undefined") {
  window.__ecpSer = serializeEditor;
  window.__ecpDeser = deserializeInto;
  window.__ecpCurrentQuery = currentQuery;
  window.__ecpChunkBeforeCaret = chunkBeforeCaret;
  window.__ecpDrag = DragState;
  window.__ecpFinishDrag = finishDrag;
  window.__ecpNode = () => window.__ecpTestNode;
  window.__ecpRefreshCustomIndex = refreshCustomIndex;
  window.__ecpCustomEntry = customEntry;
  window.__ecpSyncChunk = syncChunkToLexicon;
}

/* ------------------------------------------------------------------ */
/* 注册扩展                                                            */
/* ------------------------------------------------------------------ */

app.registerExtension({
  name: "easy_cn_prompt.chunk_editor",

  async setup() {
    injectStyle();
    try {
      const st = await apiStatus();
      window.__ECP_CATEGORIES = st.categories || {};
      LOG("后端就绪", st.lexicon?.total, "条标签");
      // 建立自定义词库索引，用于判断菜单该显示"保存"还是"删除"
      await refreshCustomIndex();
    } catch (e) {
      LOG("后端未就绪", e);
    }
    document.addEventListener("mousemove", (e) => {
      const chunk = e.target.closest?.(".ecp-chunk");
      if (chunk) showTip(chunk, e); else hideTip();
    });

    // ★ 执行前的安全网（最重要的一条）★
    //
    // app.graphToPrompt() 是"把画布状态转成请求体"的地方，执行必经过它。
    // 粘贴/连线的转换是异步的（要 await fetch 查词库），
    // 若用户粘贴后马上点执行，转换还没完成，widget 里可能还是空值或未翻译的纯文本。
    // 这里包一层：先等所有进行中的转换结束并 flush，再真正构建 prompt。
    const origGTP = app.graphToPrompt?.bind(app);
    if (origGTP) {
      app.graphToPrompt = async (...args) => {
        try { await flushAllEditors(); } catch (e) { LOG("flush error", e); }
        return origGTP(...args);
      };
    }

    // 键盘/按钮层面的兜底（覆盖不经过 graphToPrompt 的路径）
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) flushAllEditors();
    }, true);
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t?.closest?.("#queue-button, .comfyui-button, [data-testid='queue-button']")) {
        flushAllEditors();
      }
    }, true);
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "EasyCNPrompt") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      this.__ecpEditor = new ChunkEditor(this);
      if (this.size[1] < 260) this.size[1] = 260;
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      migrateWidgetValues(this);
      const w = this.widgets?.find((x) => x.name === "prompt_text");
      if (w && this.__ecpEditor) {
        deserializeInto(this.__ecpEditor.editor, w.value || "");
        this.__ecpEditor.syncToWidget(true);
      }
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__ecpEditor?.dispose?.();
      return onRemoved?.apply(this, arguments);
    };
  },
});

LOG("前端扩展已注册");
