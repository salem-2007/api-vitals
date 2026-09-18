// app.js — UI 层：状态、桥接、渲染、检测编排
import {
  DEFAULT_PROMPTS, TYPES, ADAPTERS,
  opConnectivity, opChat, opChatRetry, opLatency, opConcurrent, listModels,
  avg, pct, sleep, concurrencyVerdict,
} from "./engine.js";

// ---------------- 桥接（WebView2 原生壳 / 浏览器 fallback） ----------------
const inWV = !!(window.chrome && window.chrome.webview);
let _mid = 0;
const _pend = new Map();

function invoke(cmd, payload = {}) {
  if (!inWV) return Promise.resolve({ ok: false, data: null, native: false });
  return new Promise((resolve) => {
    const id = ++_mid;
    _pend.set(id, resolve);
    window.chrome.webview.postMessage({ id, cmd, ...payload });
  });
}
if (inWV) {
  window.chrome.webview.addEventListener("message", (e) => {
    const m = e.data;
    if (m && m.id && _pend.has(m.id)) { _pend.get(m.id)(m); _pend.delete(m.id); }
  });
}

async function storeLoad(name, fallback) {
  try {
    const r = await invoke("load", { name });
    if (r && r.ok && r.data) return JSON.parse(r.data);
  } catch {}
  try {
    const v = localStorage.getItem("ah_" + name);
    if (v) return JSON.parse(v);
  } catch {}
  return fallback;
}
async function storeSave(name, obj) {
  const s = JSON.stringify(obj);
  try {
    const r = await invoke("save", { name, data: s });
    if (r && r.ok) return;
  } catch {}
  try { localStorage.setItem("ah_" + name, s); } catch {}
}

// ---------------- 剪贴板（原生桥优先，浏览器回退） ----------------
async function clipRead() {
  try {
    const r = await invoke("clipread");
    if (r && r.ok && typeof r.data === "string" && r.data.trim()) return r.data;
  } catch {}
  try { return await navigator.clipboard.readText(); } catch {}
  return "";
}
async function clipWrite(text) {
  const t = String(text ?? "");
  if (!t) return false;
  try {
    const r = await invoke("clipwrite", { data: t });
    if (r && r.ok) return true;
  } catch {}
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}
async function copyText(text, label) {
  if (!text) { toast("没有可复制的内容" + (label ? "（" + label + "）" : ""), "bad"); return; }
  const ok = await clipWrite(text);
  toast(ok ? "已复制" + (label ? "：" + label : "") : "复制失败（剪贴板不可用）", ok ? "ok" : "bad");
}

// ---------------- 从任意文本识别连接信息 ----------------
const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/,
  /\bsk-[A-Za-z0-9_\-]{12,}/,
  /\bAIza[0-9A-Za-z_\-]{20,}/,
  /\bxai-[A-Za-z0-9_\-]{10,}/,
  /\bgsk_[A-Za-z0-9_\-]{10,}/,
  /\bBearer\s+([A-Za-z0-9_\-.{}]{12,})/i,
];
const KEY_LABEL = /(?:api[\s_-]?key|apiKey|密钥|密匙|令牌|token|key)\s*[:=＝]?\s*["'`]?([A-Za-z0-9_\-.]{16,})["'`]?/i;

function detectKey(t) {
  for (const p of KEY_PATTERNS) {
    const m = t.match(p);
    if (m) return String(m[1] || m[0]).replace(/^Bearer\s+/i, "").replace(/[.,;]+$/, "");
  }
  const lm = t.match(KEY_LABEL);
  return lm ? lm[1] : "";
}
function detectUrl(t) {
  const m = String(t).match(/https?:\/\/[^\s"'`<>（）()【】，,、;；\]]+/i);
  return m ? m[0].replace(/[.,;:]+$/, "") : "";
}
// 归一化 BaseURL：去掉接口后缀，按协议补版本前缀
function normalizeBase(u, type) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  s = s.replace(/\/(chat\/completions|completions|messages|responses|models)$/i, "");
  if (type === "anthropic") return s.replace(/\/v1$/i, "");
  if (type === "gemini") return /\/v\d+(beta)?$/i.test(s) ? s : s + "/v1beta";
  if (!/\/v\d+(beta)?$/i.test(s)) s += "/v1";
  return s.replace(/\/+$/, "");
}
function detectType(u, key) {
  const host = String(u || "").toLowerCase();
  const k = String(key || "");
  if (/^sk-ant-/i.test(k) || /anthropic\.com/.test(host)) return "anthropic";
  if (/generativelanguage|googleapis\.com|gemini/i.test(host) || /^AIza/.test(k)) return "gemini";
  return "openai";
}
const hostName = (u) => { try { return new URL(u).host; } catch { return String(u || "").slice(0, 24); } };

// 从任意文本（剪贴板 / JSON / 粘贴的行）里抽出端点连接信息
function parseConnText(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 20000) return null;

  // 1) JSON：优先 baseUrl / url + apiKey / key
  const jm = t.match(/\{[\s\S]{2,4000}?\}/);
  if (jm) {
    try {
      const j = JSON.parse(jm[0]);
      const baseUrl = j.baseUrl || j.base_url || j.url || j.endpoint || j.api || "";
      const apiKey = j.apiKey || j.api_key || j.key || j.token || j.secret || "";
      if (baseUrl) {
        const type = TYPES.some((x) => x.value === j.type) ? j.type : detectType(baseUrl, apiKey);
        return { name: j.name || hostName(baseUrl), type, baseUrl: normalizeBase(baseUrl, type), apiKey: String(apiKey || "").replace(/^Bearer\s+/i, "") };
      }
    } catch { /* 不是 JSON，继续 */ }
  }

  // 2) 通用：URL + Key
  const url = detectUrl(t);
  let key = detectKey(t);
  // 2.1) Gemini 风格 ?key=xxx
  if (!key && url) { const q = url.match(/[?&]key=([A-Za-z0-9_\-.]{12,})/i); if (q) key = q[1]; }
  if (!url && !key) {
    // 2.2) 只有 Key：不可用，但提示出来
    return null;
  }
  const type = detectType(url, key);
  const cleanUrl = url.replace(/[?&](key|api_key|apiKey)=[^&]+/i, "");
  return { name: hostName(cleanUrl), type, baseUrl: cleanUrl ? normalizeBase(cleanUrl, type) : "", apiKey: key };
}

// ---------------- 状态 ----------------
const DEFAULT_SETTINGS = {
  timeoutMs: 60000, connectTimeoutMs: 15000, latencyN: 3,
  concurN: 4,        // 并发数（开关打开时一次并行发起的请求数）
  concurEnabled: false,   // 并发总开关
  retries: 1,        // 可重试失败的自动重试次数
  gapMs: 150,
  recordLimit: 300,  // 记录页最多显示多少条（避免长跑后卡）
  theme: "auto",   // auto | light | dark
  tests: { connect: true, latency: true, stream: true, tps: true, concur: false },
};

const S = {
  providers: [],
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  prompts: [],
  runs: [],
  rows: [],
  running: false,
  abort: null,
  tab: "dash",
  filter: "all",
  filterRun: null,
  status: "就绪",
  progress: "",
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hhmmss = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const KINDS = { connect: "连通", chat: "对话", latency: "延迟", stream: "流式", tps: "速率", concur: "并发" };
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));

// ---------------- 主题（日夜模式） ----------------
const mqDark = window.matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme() {
  const t = S.settings.theme || "auto";
  if (t === "light" || t === "dark") return t;
  return mqDark.matches ? "dark" : "light";
}

function applyTheme() {
  const eff = effectiveTheme();
  document.documentElement.dataset.theme = eff;
  const mode = S.settings.theme || "auto";
  const meta = { auto: ["◐", "跟随系统"], light: ["☀", "浅色"], dark: ["☾", "深色"] }[mode];
  const ic = document.getElementById("themeIcon");
  const lb = document.getElementById("themeLabel");
  if (ic) ic.textContent = meta[0];
  if (lb) lb.textContent = meta[1];
  Object.values(charts).forEach((c) => { try { c.dispose(); } catch {} });
  Object.keys(charts).forEach((k) => delete charts[k]);
  renderCharts();
  // 同步原生窗口装饰（圆角 + 标题栏明暗）
  invoke("chrome", { data: eff });
}

function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const cur = S.settings.theme || "auto";
  setTheme(order[(order.indexOf(cur) + 1) % 3]);
}

function setTheme(mode) {
  S.settings.theme = ["auto", "light", "dark"].includes(mode) ? mode : "auto";
  storeSave("settings", S.settings);
  applyTheme();
  renderConfig();
}

mqDark.addEventListener("change", () => {
  if ((S.settings.theme || "auto") === "auto") applyTheme();
});

// 读取当前主题下的 CSS 变量，供图表使用
function pal() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n, f) => (cs.getPropertyValue(n) || f).trim();
  return {
    text: g("--text", "#E7EFF7"), muted: g("--muted", "#8B98A7"), faint: g("--faint", "#5A6675"),
    line: g("--line2", "#2A374A"), grid: g("--grid", "rgba(255,255,255,.05)"),
    sig: g("--sig", "#3EE08F"), warn: g("--warn", "#FFC24B"),
    danger: g("--danger", "#FF6161"), info: g("--info", "#58C7F3"),
    panel2: g("--panel2", "#131B25"), sigDim: g("--sig-dim", "rgba(62,224,143,.12)"),
  };
}

// 跟随系统字体：内置字体优先，系统探测字体作为后备族
async function applySystemFont() {
  try {
    // 内置字体（随包分发）是否真的加载成功 —— 写进原生日志便于验证打包结果
    try {
      await document.fonts.ready;
      const face = [...document.fonts].find((f) => f.family.replace(/["']/g, "") === "App Round");
      // 宽度差异法：内置字体生效时宽度应与缺失字体不同
      const w = (ff) => {
        const d = document.createElement("span");
        d.style.cssText = "position:absolute;visibility:hidden;font-size:40px;white-space:nowrap;font-family:" + ff;
        d.textContent = "字体测试 ABC 123";
        document.body.appendChild(d);
        const r = d.getBoundingClientRect().width;
        d.remove();
        return Math.round(r * 10) / 10;
      };
      const appW = w('"App Round"');
      const missW = w('"NoSuchFontXYZ"');
      invoke("log", {
        data: `font bundled=${face ? face.status : "absent"} applied=${appW !== missW} (${appW} vs ${missW}) sysfont=${document.documentElement.dataset.sysfont || "-"}`,
      });
    } catch (e) {
      invoke("log", { data: "font probe failed: " + (e && e.message) });
    }
    const r = await invoke("sysinfo");
    if (r && r.ok && r.data && inWV) {
      const info = JSON.parse(r.data);
      // 内置字体是首选；系统字体作为后备族（不覆盖 --app-font）
      if (info.font) document.documentElement.dataset.sysfont = info.font;
    }
  } catch { /* 浏览器/探测失败：仅用内置字体 */ }
}

// 缩短端点名，避免图表 X 轴标签被截断
const shortP = (s) => {
  const t = String(s || "").split("·")[0].trim();
  return t.length > 7 ? t.slice(0, 7) + "…" : t;
};

// 配置迁移：清理已废弃字段 + 纠正无效值（旧版把并发数存成 1，等于没开并发）
function migrateSettings(old) {
  let changed = false;
  // 1) 并发数 <2 时并发测试无意义，纠正为默认 4
  const cn = parseInt(S.settings.concurN, 10);
  if (!Number.isFinite(cn) || cn < 2) { S.settings.concurN = 4; changed = true; }
  // 2) 清理已废弃的「并发阶梯」字段（现为固定并发数模型）
  for (const k of ["rampLevels", "rampPerLevel"]) {
    if (k in S.settings) { delete S.settings[k]; changed = true; }
  }
  if (S.settings.tests && "ramp" in S.settings.tests) { delete S.settings.tests.ramp; changed = true; }
  // 3) 重试次数兜底
  if (!Number.isFinite(parseInt(S.settings.retries, 10))) { S.settings.retries = DEFAULT_SETTINGS.retries; changed = true; }
  if (changed) {
    storeSave("settings", S.settings);
    invoke("log", { data: "settings migrated (concurN/legacy-ramp fields normalized)" });
  }
  return changed;
}

// ---------------- 初始化 ----------------
(async function init() {
  S.providers = (await storeLoad("providers", [])) || [];
  const st = (await storeLoad("settings", null)) || {};
  S.settings = { ...DEFAULT_SETTINGS, ...st, tests: { ...DEFAULT_SETTINGS.tests, ...(st.tests || {}) } };
  migrateSettings(st);
  S.prompts = (await storeLoad("prompts", null)) || DEFAULT_PROMPTS.slice();
  S.runs = (await storeLoad("history", [])) || [];

  await applySystemFont();
  applyTheme();
  renderToggles();
  renderProviders();
  renderAll();
  bindStatic();
  drawEcg();
  ecgState("idle");
  setStatus("就绪");
})();

// ---------------- ECG ----------------
function drawEcg() {
  const pts = [];
  const beat = (t) => {
    if (t < 0.30) return 22;      // 基线
    if (t < 0.38) return 18;      // P
    if (t < 0.44) return 22;
    if (t < 0.47) return 26;      // Q
    if (t < 0.50) return 4;       // R
    if (t < 0.53) return 30;      // S
    if (t < 0.60) return 22;
    if (t < 0.72) return 15;      // T
    return 22;
  };
  for (let x = 0; x <= 600; x += 2) pts.push(x + "," + beat((x % 100) / 100));
  const p = pts.join(" ");
  $("#ecgGhost").setAttribute("points", p);
  $("#ecgSweep").setAttribute("points", p);
}
function ecgState(s) {
  const el = $("#ecg");
  el.classList.remove("idle", "busy", "bad", "ok");
  el.classList.add(s);
}

// ---------------- 基础渲染 ----------------
function setStatus(t) { S.status = t; $("#statusText").textContent = t; }
function setProgress(t) { S.progress = t; $("#progressText").textContent = t; }

function renderHud() {
  const run = S.runs[0];
  const el = $("#hudStats");
  if (!run) {
    el.innerHTML = `<span>端点 <b>${S.providers.length}</b></span><span>等待首次检测</span>`;
    return;
  }
  const { pass, fail } = run.stats;
  el.innerHTML =
    `<span>端点 <b>${run.providerCount}</b></span>` +
    `<span>通过 <b class="good">${pass}</b></span>` +
    `<span>失败 <b class="bad">${fail}</b></span>` +
    `<span>上次 <b>${hhmmss(run.ts)}</b></span>`;
}

function renderToggles() {
  const el = $("#testToggles");
  const items = [
    ["connect", "连通"], ["latency", "延迟"], ["stream", "流式"], ["tps", "Token速率"], ["concur", "并发"],
  ];
  el.innerHTML = items.map(([k, label]) =>
    `<label class="chk"><input type="checkbox" data-test="${k}" ${S.settings.tests[k] ? "checked" : ""}>${label}</label>`
  ).join("");
  el.querySelectorAll("input").forEach((cb) => {
    cb.addEventListener("change", async () => {
      S.settings.tests[cb.dataset.test] = cb.checked;
      await storeSave("settings", S.settings);
    });
  });
}

function provLamp(p) {
  const rows = latestRowsFor(p.name);
  if (!rows.length) return "";
  const bad = rows.some((r) => !r.ok);
  return bad ? "bad" : "ok";
}
function latestRowsFor(name) {
  const src = S.runs[0] ? (S.filterRun && S.filterRun.rows ? S.filterRun.rows : S.runs[0].rows) : S.rows;
  return src.filter((r) => r.provider === name);
}

function renderProviders() {
  const el = $("#providers");
  if (!S.providers.length) {
    el.innerHTML = `<div class="empty">暂无端点<br>用「批量导入」一次加一堆</div>`;
    $("#hudStats") && renderHud();
    return;
  }
  el.innerHTML = S.providers.map((p) => {
    const lamp = provLamp(p);
    const testing = !!(S.runCursor && S.runCursor.id === p.id);
    const done = !!(S.doneIds && S.doneIds.has(p.id));
    const modelAttrs = (p.models || []).map((m) => ` data-model="${esc(m)}"`).join("");
    const cls = ["prov", p.enabled === false ? "disabled" : "", testing ? "testing" : "", done && !testing ? "done" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}" data-id="${p.id}"${modelAttrs} title="左键编辑 · 右键更多">
      <div class="pname">
        <span class="lamp ${testing ? "busy" : lamp}"></span>
        <span class="nm">${esc(p.name)}</span>
        ${testing ? `<span class="pstate"><span class="spin"></span><span class="ptxt">${esc(S.runCursor.phase || "检测中")}</span></span>` : ""}
        ${done && !testing ? `<span class="pstate ok">✓ 已测</span>` : ""}
      </div>
      <div class="pmeta">${esc(p.baseUrl)}</div>
      <div class="row2">
        <span class="badge">${TYPE_LABEL[p.type] || p.type}</span>
        <span class="badge">${p.models?.length ? p.models.length + " 模型" : "未拉取"}</span>
      </div>
    </div>`;
  }).join("");
  el.querySelectorAll(".prov").forEach((node) => {
    node.addEventListener("click", () => editProvider(node.dataset.id));
    node.addEventListener("contextmenu", (e) => providerMenu(node.dataset.id, e));
  });
}

// ---- 检测进行态：只更新当前端点卡的阶段文字，避免整表重渲染 ----
function markProvTesting(id, phaseText) {
  S.runCursor = id ? { id, phase: phaseText || "检测中" } : null;
  renderProviders();
  renderVitals();
}
function setProvPhase(phaseText) {
  if (!S.runCursor) return;
  S.runCursor.phase = phaseText;
  const node = document.querySelector(`.prov[data-id="${S.runCursor.id}"] .ptxt`);
  if (node) node.textContent = phaseText;
  const vnode = document.querySelector(`#vitals .vit[data-id="${S.runCursor.id}"] .vphase`);
  if (vnode) vnode.textContent = phaseText;
}
function markProvDone(id) {
  if (!S.doneIds) S.doneIds = new Set();
  if (id) S.doneIds.add(id);
  if (S.runCursor && S.runCursor.id === id) S.runCursor = null;
  renderProviders();
  renderVitals();
}

// ---------------- 仪表盘 ----------------
function renderVitals() {
  const el = $("#vitals");
  if (!S.providers.length) { el.innerHTML = `<div class="empty">添加端点后开始检测</div>`; return; }
  el.innerHTML = S.providers.map((p) => {
    const rows = latestRowsFor(p.name);
    const lamp = provLamp(p);
    const testingE = !!(S.runCursor && S.runCursor.id === p.id);
    if (!rows.length) {
      return `<div class="vit ${testingE ? "testing" : ""}" data-id="${p.id}"><div class="vname"><span class="lamp ${testingE ? "busy" : ""}"></span><span class="nm">${esc(p.name)}</span></div>
        <div class="vrow"><span>状态</span><b class="vphase">${testingE ? esc(S.runCursor.phase || "检测中") : "未检测"}</b></div></div>`;
    }
    const conn = rows.find((r) => r.kind === "connect");
    const conv = rows.filter((r) => ["chat", "tps", "stream"].includes(r.kind) && r.ok);
    const lat = conv.map((r) => r.latencyMs);
    const tpsRows = rows.filter((r) => r.tps != null);
    const tpsAvg = tpsRows.length ? Math.round(avg(tpsRows.map((r) => r.tps)) * 10) / 10 : null;
    const stream = rows.filter((r) => r.kind === "stream").pop();
    const conc = rows.filter((r) => r.kind === "concur").pop();
    const fails = rows.filter((r) => !r.ok).length;
    const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];
    const testing = !!(S.runCursor && S.runCursor.id === p.id);
    return `<div class="vit ${testing ? "testing" : ""}" data-id="${p.id}" title="右键：复制 / 获取模型 / 检测该端点">
      <div class="vname"><span class="lamp ${testing ? "busy" : lamp}"></span><span class="nm">${esc(p.name)}</span><span class="badge">${TYPE_LABEL[p.type] || p.type}</span></div>
      ${testing ? `<div class="vrow"><span>状态</span><b class="vphase">${esc(S.runCursor.phase || "检测中")}</b></div>` : ""}
      <div class="vrow"><span>连通</span><b class="${conn ? (conn.ok ? "good" : "bad") : ""}">${conn ? (conn.ok ? "正常 " + conn.latencyMs + "ms" : "失败") : "—"}</b></div>
      <div class="vrow"><span>延迟 p50</span><b>${lat.length ? pct(lat, 0.5) + "ms" : "—"}</b></div>
      <div class="vrow"><span>速率</span><b>${tpsAvg != null ? tpsAvg + " tok/s" : "—"}</b></div>
      <div class="vrow"><span>流式</span><b class="${stream ? (stream.ok ? "good" : "bad") : ""}">${stream ? (stream.ok ? "正常 · " + (stream.streamInfo?.chunks ?? "?") + " 块" : "失败") : "—"}</b></div>
      ${conc ? `<div class="vrow"><span>并发 ${conc.concurrency ?? ""}</span><b class="${conc.ok ? "good" : "bad"}">${conc.ok ? "全部通过" : (conc.error || "有失败").slice(0, 24)}</b></div>` : ""}
      <div class="vrow"><span>模型</span><b>${models.length ? models.join(", ").slice(0, 40) : "—"}</b></div>
      <div class="vrow"><span>本轮</span><b class="${fails ? "bad" : "good"}">${fails ? fails + " 失败" : "全部通过"}</b></div>
    </div>`;
  }).join("");
  el.querySelectorAll(".vit").forEach((node) => {
    node.addEventListener("contextmenu", (e) => providerMenu(node.dataset.id, e));
  });
}

// ---------------- 图表 ----------------
const charts = {};
function chartSrc() { return S.runs[0] || { rows: S.rows, concur: [] }; }

function ensureChart(id) {
  if (!window.echarts) return null;
  if (!charts[id]) {
    const el = document.getElementById(id);
    if (!el) return null;
    charts[id] = window.echarts.init(el, null, { renderer: "canvas" });
  }
  return charts[id];
}
const eco = () => {
  const P = pal();
  return {
    textStyle: { color: P.muted, fontFamily: "Consolas, monospace", fontSize: 10 },
    grid: { left: 46, right: 18, top: 28, bottom: 26 },
    tooltip: { backgroundColor: P.panel2, borderColor: P.line, textStyle: { color: P.text, fontSize: 11 } },
    legend: { textStyle: { color: P.muted, fontSize: 10 }, top: 0, right: 4 },
  };
};
function emptyOption(text) {
  const P = pal();
  return { ...eco(), xAxis: { show: false }, yAxis: { show: false }, series: [],
    graphic: { type: "text", left: "center", top: "middle", style: { text, fill: P.faint, fontSize: 11 } } };
}

function renderCharts() {
  const src = chartSrc();
  const P = pal();
  // 1) 延迟分布
  const c1 = ensureChart("chartLatency");
  if (c1 && c1.getDom() && !c1.getDom().dataset.ctxBound) {
    c1.getDom().dataset.ctxBound = "1";
    c1.getDom().addEventListener("contextmenu", (e) => chartMenu("chartLatency", e));
  }
  if (c1) {
    const rows = (src.rows || []).filter((r) => r.kind === "latency" && r.agg);
    if (!rows.length) c1.setOption(emptyOption("运行检测后显示延迟分布"), true);
    else {
      const labels = rows.map((r) => `${shortP(r.provider)}·${r.model}`);
      c1.setOption({
        ...eco(),
        grid: { left: 46, right: 18, top: 28, bottom: 54 },
        xAxis: { type: "category", data: labels, axisLabel: { interval: 0, rotate: 22, fontSize: 9 }, axisLine: { lineStyle: { color: P.line } } },
        yAxis: { type: "value", name: "ms", splitLine: { lineStyle: { color: P.grid } } },
        series: [
          { name: "p50", type: "bar", data: rows.map((r) => r.p50), itemStyle: { color: P.sig }, barWidth: 14, borderRadius: [2, 2, 0, 0] },
          { name: "p95", type: "bar", data: rows.map((r) => r.p95), itemStyle: { color: P.info }, barWidth: 14, borderRadius: [2, 2, 0, 0] },
        ],
      }, true);
    }
  }
  // 2) 并发测试（固定并发数：成功率 / 吞吐）
  const c2 = ensureChart("chartConcur");
  if (c2 && c2.getDom() && !c2.getDom().dataset.ctxBound) {
    c2.getDom().dataset.ctxBound = "1";
    c2.getDom().addEventListener("contextmenu", (e) => chartMenu("chartConcur", e));
  }
  if (c2) {
    const cur = src.concur || [];
    if (!cur.length) c2.setOption(emptyOption("打开「并发」开关后显示并发测试结果"), true);
    else {
      const labels = cur.map((r) => `${shortP(r.provider)}·${r.model}`);
      c2.setOption({
        ...eco(),
        grid: { left: 46, right: 48, top: 28, bottom: 54 },
        xAxis: { type: "category", data: labels, axisLabel: { interval: 0, rotate: 22, fontSize: 9 }, axisLine: { lineStyle: { color: P.line } } },
        yAxis: [
          { type: "value", max: 100, name: "成功率%", splitLine: { lineStyle: { color: P.grid } } },
          { type: "value", name: "req/s", splitLine: { show: false } },
        ],
        series: [
          {
            name: "成功率", type: "bar", barMaxWidth: 24, borderRadius: [2, 2, 0, 0],
            data: cur.map((r) => Math.round((r.ok / Math.max(1, r.ok + r.fail)) * 100)),
            itemStyle: { color: (pv) => (pv.value >= 100 ? P.sig : pv.value > 0 ? P.warn : P.danger) },
          },
          {
            name: "吞吐 req/s", type: "line", yAxisIndex: 1, symbolSize: 6,
            data: cur.map((r) => r.throughput ?? null),
            itemStyle: { color: P.info }, lineStyle: { color: P.info, width: 2 },
          },
        ],
        tooltip: {
          ...eco().tooltip, trigger: "axis",
          formatter: (ps) => {
            const i = ps[0]?.dataIndex ?? 0, r = cur[i] || {};
            return `${r.provider} · ${r.model}<br>并发 ${r.concurrency} · 通过 ${r.ok}/${r.ok + r.fail}` +
              `<br>p50 ${r.p50 ?? "—"}ms · p95 ${r.p95 ?? "—"}ms` +
              `<br>吞吐 ${r.throughput ?? "—"} req/s · 墙钟 ${r.wallMs ?? "—"}ms` +
              (r.errors?.length ? `<br>错误：${r.errors.join(" | ")}` : "");
          },
        },
      }, true);
    }
  }
  // 3) Token 速率
  const c3 = ensureChart("chartTps");
  if (c3 && c3.getDom() && !c3.getDom().dataset.ctxBound) {
    c3.getDom().dataset.ctxBound = "1";
    c3.getDom().addEventListener("contextmenu", (e) => chartMenu("chartTps", e));
  }
  if (c3) {
    const rows = (src.rows || []).filter((r) => r.tps != null && r.ok);
    if (!rows.length) c3.setOption(emptyOption("暂无速率数据"), true);
    else {
      const labels = [...new Set(rows.map((r) => `${shortP(r.provider)}·${r.model}`))];
      const m2 = {};
      rows.forEach((r) => { const k = `${shortP(r.provider)}·${r.model}`; (m2[k] = m2[k] || []).push(r.tps); });
      c3.setOption({
        ...eco(),
        grid: { left: 46, right: 18, top: 28, bottom: 54 },
        xAxis: { type: "category", data: labels, axisLabel: { interval: 0, rotate: 22, fontSize: 9 }, axisLine: { lineStyle: { color: P.line } } },
        yAxis: { type: "value", name: "tok/s", splitLine: { lineStyle: { color: P.grid } } },
        series: [{ name: "平均速率", type: "bar", data: labels.map((k) => Math.round(avg(m2[k]) * 10) / 10), itemStyle: { color: P.info }, barMaxWidth: 26, borderRadius: [4, 4, 0, 0] }],
      }, true);
    }
  }
  // 4) 历史通过率
  const c4 = ensureChart("chartHistory");
  if (c4 && c4.getDom() && !c4.getDom().dataset.ctxBound) {
    c4.getDom().dataset.ctxBound = "1";
    c4.getDom().addEventListener("contextmenu", (e) => chartMenu("chartHistory", e));
  }
  if (c4) {
    const runs = S.runs.slice(0, 30).reverse();
    if (!runs.length) c4.setOption(emptyOption("暂无历史 · 每次检测完成后自动存档"), true);
    else {
      c4.setOption({
        ...eco(),
        xAxis: { type: "category", data: runs.map((r) => hhmmss(r.ts).slice(0, 5)), axisLine: { lineStyle: { color: P.line } } },
        yAxis: { type: "value", max: 100, name: "%", splitLine: { lineStyle: { color: P.grid } } },
        series: [{
          name: "通过率", type: "line", smooth: true,
          data: runs.map((r) => { const t = r.stats.pass + r.stats.fail; return t ? Math.round((r.stats.pass / t) * 100) : 0; }),
          itemStyle: { color: P.sig }, lineStyle: { color: P.sig, width: 2 },
          areaStyle: { color: P.sigDim }, symbolSize: 5,
        }],
      }, true);
    }
  }
  requestAnimationFrame(() => Object.values(charts).forEach((c) => { try { c.resize(); } catch {} }));
}

// ---------------- 记录 ----------------
function renderRecords() {
  const el = $("#view-records");
  const baseRows = S.filterRun ? S.filterRun.rows : (S.runs.length && !S.running ? S.runs[0].rows : S.rows);
  let rows = baseRows;
  if (S.filter === "pass") rows = rows.filter((r) => r.ok);
  if (S.filter === "fail") rows = rows.filter((r) => !r.ok);
  if (S.filterProv) rows = rows.filter((r) => r.provider === S.filterProv);
  const limit = Math.max(20, Math.min(5000, parseInt(S.settings.recordLimit, 10) || 300));
  const shown = rows.slice(-limit);
  S._shownRows = shown;

  el.innerHTML = `
    <div class="chips">
      <button class="chip ${S.filter === "all" ? "active" : ""}" data-f="all">全部 ${S.filterRun ? S.filterRun.rows.length : baseRows.length}</button>
      <button class="chip ${S.filter === "pass" ? "active" : ""}" data-f="pass">通过 ${baseRows.filter((r) => r.ok).length}</button>
      <button class="chip ${S.filter === "fail" ? "active" : ""}" data-f="fail">失败 ${baseRows.filter((r) => !r.ok).length}</button>
      ${S.filterProv ? `<button class="chip active" data-f="prov">端点：${esc(S.filterProv)} ✕</button>` : ""}
      ${S.filterRun ? `<button class="chip" data-f="exit">← 返回本轮</button>` : ""}
      <span class="spacer"></span>
      ${rows.length > shown.length ? `<span class="hint">显示最近 ${shown.length} / ${rows.length} 条</span>` : ""}
      <label class="chip select-chip" title="最多显示多少条记录">
        显示
        <select id="recLimit">
          ${[100, 300, 500, 1000, 2000].map((n) => `<option value="${n}" ${limit === n ? "selected" : ""}>${n}</option>`).join("")}
        </select>
        条
      </label>
      <button class="chip" data-f="report">导出报告表格</button>
      <button class="chip" data-f="csv">导出 CSV</button>
      <button class="chip danger" data-f="clear">清空记录</button>
    </div>
    ${shown.length ? `<div class="table-wrap"><table>
      <thead><tr><th>时间</th><th>端点</th><th>测试</th><th>模型</th><th>结果</th><th>延迟</th><th>TTFT</th><th>速率</th><th>详情</th></tr></thead>
      <tbody>${shown.map((r, i) => `
        <tr data-idx="${i}" title="右键：复制 / 只看此端点 / 导出报告">
          <td>${hhmmss(r.t || Date.now())}</td>
          <td><b>${esc(r.provider || "")}</b></td>
          <td>${KINDS[r.kind] || esc(r.kind || "")}${r.agg ? "<span class='sub'> 聚合</span>" : ""}</td>
          <td>${esc(r.model || "—")}</td>
          <td><span class="pill ${r.ok ? "ok" : "bad"}">${r.ok ? "通过" : "失败"}</span></td>
          <td>${r.agg || r.kind === "concur" ? (r.p50 != null ? `p50 ${r.p50} / p95 ${r.p95}` : "—") : (r.latencyMs != null ? r.latencyMs + "ms" : "—")}</td>
          <td>${r.ttftMs != null ? r.ttftMs + "ms" : "—"}</td>
          <td>${r.tps != null ? r.tps + " " + (r.unit || "") : "—"}</td>
          <td><span class="sub">${esc((r.error || r.preview || "").slice(0, 60))}</span></td>
        </tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">还没有记录 · 点左侧「快速检测」开跑</div>`}
  `;
  el.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => onRecordChip(c.dataset.f)));
  el.querySelector("#recLimit")?.addEventListener("change", async (e) => {
    S.settings.recordLimit = Math.max(20, Math.min(5000, parseInt(e.target.value, 10) || 300));
    await storeSave("settings", S.settings);
    renderRecords();
  });
  el.querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("contextmenu", (e) => recordMenu(Number(tr.dataset.idx), e));
  });
}

// 清空记录：可选只清当前轮 / 连历史一起清
function clearRecords() {
  const inRun = !!S.filterRun;
  const scope = inRun ? "当前浏览的这一轮" : "最新一轮记录";
  if (!confirm(`清空${scope}？\n\n（只清测试记录，端点和参数不动）`)) return;
  if (inRun) {
    const r = S.runs.find((x) => x.ts === S.filterRun.ts);
    if (r) { r.rows = []; r.concur = []; r.stats = { pass: 0, fail: 0 }; r.providerCount = 0; }
    S.filterRun = null;
  } else {
    S.rows = [];
    if (S.activeRun) S.activeRun.rows = [];
    if (S.runs.length) {
      S.runs[0].rows = [];
      S.runs[0].concur = [];
      S.runs[0].stats = { pass: 0, fail: 0 };
      S.runs[0].providerCount = 0;
    }
  }
  S.filterProv = null;
  S.filter = "all";
  storeSave("history", S.runs);
  renderAll();
  toast("记录已清空", "ok");
}
function clearAllHistory() {
  if (!confirm("清空全部历史（所有轮次的记录）？此操作不可撤销。")) return;
  S.runs = [];
  S.rows = [];
  S.filterRun = null;
  S.filterProv = null;
  storeSave("history", S.runs);
  renderAll();
  toast("全部历史已清空", "ok");
}

function onRecordChip(f) {
  if (f === "csv") return exportCsv();
  if (f === "report") return exportReportCsv(S.filterRun || null);
  if (f === "clear") return clearRecords();
  if (f === "prov") { S.filterProv = null; renderRecords(); return; }
  if (f === "exit") { S.filterRun = null; S.filterProv = null; renderRecords(); return; }
  S.filter = f;
  renderRecords();
}

function exportCsv() {
  const baseRows = S.filterProv ? (S._shownRows || []) : (S.filterRun ? S.filterRun.rows : (S.runs[0]?.rows || S.rows));
  const prov = (name) => S.providers.find((p) => p.name === name) || {};
  const head = "时间,端点,类型,API地址,APIKey,模型,测试,结果,延迟ms,TTFTms,tokens,速率,单位,详情";
  const lines = baseRows.map((r) => {
    const p = prov(r.provider);
    return csvRow([
      new Date(r.t || Date.now()).toLocaleString("zh-CN", { hour12: false }),
      r.provider || "", TYPE_LABEL[r.type || p.type] || r.type || p.type || "",
      p.baseUrl || r.baseUrl || "", p.apiKey || "",
      r.model || "",
      (KINDS[r.kind] || r.kind || "") + (r.agg ? " 聚合" : ""), r.ok ? "通过" : "失败",
      r.agg || r.kind === "concur" ? (r.p50 != null ? `p50 ${r.p50} / p95 ${r.p95}` : "") : (r.latencyMs ?? ""),
      r.ttftMs ?? "", r.tokens ?? "", r.tps ?? "", r.unit ?? "",
      r.error || r.preview || "",
    ]);
  });
  const csv = "\ufeff" + [head, ...lines].join("\r\n");
  const name = `export-${stampName()}.csv`;
  saveFile(name, csv);
}

// ---------------- 历史 ----------------
function renderHistory() {
  const el = $("#view-history");
  if (!S.runs.length) {
    el.innerHTML = `<div class="empty">暂无历史 · 每次检测完成后自动存档</div>`;
    return;
  }
  const totalRows = S.runs.reduce((s, r) => s + r.rows.length, 0);
  el.innerHTML = `
  <div class="chips" style="margin-bottom:12px">
    <span class="hint">共 ${S.runs.length} 轮 · ${totalRows} 条记录</span>
    <span class="spacer"></span>
    <button class="chip" data-act="report">导出最近一轮报告</button>
    <button class="chip danger" data-act="clearAll">清空全部历史</button>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>时间</th><th>端点</th><th>用例</th><th>通过</th><th>失败</th><th>耗时</th><th>平均延迟</th><th></th></tr></thead>
    <tbody>${S.runs.map((r) => {
      const lat = r.rows.filter((x) => x.ok && !x.agg).map((x) => x.latencyMs);
      return `<tr data-ts="${r.ts}" title="右键：查看 / 导出报告 / 删除">
        <td>${new Date(r.ts).toLocaleString("zh-CN", { hour12: false })}</td>
        <td><b>${r.providerCount}</b></td>
        <td>${r.rows.length}</td>
        <td><span class="pill ok">${r.stats.pass}</span></td>
        <td><span class="pill ${r.stats.fail ? "bad" : ""}">${r.stats.fail}</span></td>
        <td>${(r.durationMs / 1000).toFixed(1)}s</td>
        <td>${lat.length ? pct(lat, 0.5) + "ms" : "—"}</td>
        <td><button class="btn tiny" data-act="view">查看</button>
            <button class="btn tiny" data-act="report">导出报告</button>
            <button class="btn tiny" data-act="del">删除</button></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
  el.querySelectorAll("tbody tr").forEach((tr) => {
    const ts = Number(tr.dataset.ts);
    tr.addEventListener("contextmenu", (e) => historyMenu(ts, e));
    tr.querySelector('[data-act="view"]')?.addEventListener("click", () => window.AH.viewRun(ts));
    tr.querySelector('[data-act="report"]')?.addEventListener("click", () => exportReportCsv(S.runs.find((x) => x.ts === ts)));
    tr.querySelector('[data-act="del"]')?.addEventListener("click", () => window.AH.delRun(ts));
  });
  el.querySelector('.chip[data-act="clearAll"]')?.addEventListener("click", clearAllHistory);
  el.querySelector('.chip[data-act="report"]:not([data-ts])')?.addEventListener("click", () => exportReportCsv(S.runs[0]));
}

// ---------------- 配置页 ----------------
function renderConfig() {
  const el = $("#view-config");
  const s = S.settings;
  el.innerHTML = `
  <div class="cfg-sec">
    <h3>外观</h3>
    <div class="theme-row">
      ${[["auto", "◐ 跟随系统"], ["light", "☀ 浅色"], ["dark", "☾ 深色"]].map(([m, lb]) =>
        `<button class="chip ${(S.settings.theme || "auto") === m ? "active" : ""}" onclick="AH.setTheme('${m}')">${lb}</button>`).join("")}
    </div>
    <div class="hint" style="margin-top:12px">当前生效：${effectiveTheme() === "dark" ? "深色 · 监护室夜间" : "浅色 · 临床白昼"}。选「跟随系统」会随 Windows 深色/浅色设置自动切换。</div>
  </div>

  <div class="cfg-sec">
      <h3>测试参数</h3>
      <div class="grid2">
        <div class="field"><label>请求超时（ms）</label><input id="cfg_timeout" value="${s.timeoutMs}"></div>
        <div class="field"><label>连通超时（ms）</label><input id="cfg_ctimeout" value="${s.connectTimeoutMs}"></div>
        <div class="field"><label>延迟采样次数</label><input id="cfg_latn" value="${s.latencyN}"></div>
        <div class="field"><label>并发数（2-64，1 无效）</label><input id="cfg_concur" value="${s.concurN ?? 4}"></div>
        <div class="field"><label>失败自动重试次数（0-3）</label><input id="cfg_retries" value="${s.retries ?? 1}"></div>
        <div class="field"><label>用例间隔（ms）</label><input id="cfg_gap" value="${s.gapMs}"></div>
      </div>
      <div class="hint" style="margin-bottom:8px">并发数必须 ≥2 才有意义（=1 等同于普通串行请求）；只对 5xx/429/超时/空响应等可恢复失败重试，关键词不符属模型真实答案，不重试。</div>
      <div class="field switch-field" style="margin-top:8px">
        <label class="switch"><input type="checkbox" id="cfg_concur_on" ${s.tests.concur ? "checked" : ""} onchange="AH.toggleConcur(this.checked)"><span class="track"></span><span>并发开关：检测时按并发数并行发起请求</span></label>
      </div>
      <button class="btn primary" onclick="AH.saveSettings()">保存参数</button>
    </div>

    <div class="cfg-sec">
      <h3>端点（${S.providers.length}）</h3>
      ${S.providers.length ? `<div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>BaseURL</th><th>测试模型</th><th>状态</th><th></th></tr></thead>
        <tbody>${S.providers.map((p) => `<tr data-id="${p.id}" title="右键：复制 / 获取模型 / 删除">
          <td><b>${esc(p.name)}</b></td>
          <td>${TYPE_LABEL[p.type] || p.type}</td>
          <td><span class="sub">${esc(p.baseUrl)}</span></td>
          <td><span class="sub">${(p.selModels || []).length ? (p.selModels || []).length + " 个" : "自动前 2"}</span></td>
          <td><span class="pill ${p.enabled === false ? "" : "ok"}">${p.enabled === false ? "停用" : "启用"}</span></td>
          <td><button class="btn tiny" data-act="edit">编辑</button>
              <button class="btn tiny" data-act="fetch">获取模型</button>
              <button class="btn tiny" data-act="del">删除</button></td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty">暂无端点</div>`}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" onclick="AH.addProv()">添加端点</button>
        <button class="btn" onclick="AH.importModal()">批量导入</button>
      </div>
    </div>

  <div class="cfg-sec">
    <h3>提示词（${S.prompts.length}）</h3>
    <div class="table-wrap"><table><thead><tr><th>标签</th><th>内容</th><th>期望</th><th></th></tr></thead>
      <tbody>${S.prompts.map((p, i) => `<tr>
        <td><b>${esc(p.label)}</b></td>
        <td><span class="sub">${esc(p.user.slice(0, 40))}…</span></td>
        <td>${esc(p.expect || "—")}</td>
        <td><button class="btn tiny" onclick="AH.delPrompt(${i})">删除</button></td>
      </tr>`).join("")}</tbody></table></div>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>标签</label><input id="np_label" placeholder="例如：数学计算"></div>
      <div class="field"><label>期望关键词（可空）</label><input id="np_expect" placeholder="例如：436"></div>
    </div>
    <div class="field"><label>提示词内容</label><textarea id="np_user" placeholder="发给模型的问题"></textarea></div>
    <button class="btn" onclick="AH.addPrompt()">添加提示词</button>
  </div>

  <div class="cfg-sec">
    <h3>数据</h3>
    <div class="btn-row">
      <button class="btn" onclick="AH.openDir()">打开数据目录</button>
      <button class="btn" onclick="AH.exportConfig()">导出配置 JSON</button>
      <button class="btn danger" onclick="AH.clearHistory()">清空历史</button>
    </div>
    <div class="field" style="margin-top:12px"><label>导入配置（粘贴 JSON）</label><textarea id="cfg_import" placeholder='{"providers":[...],"settings":{...},"prompts":[...]}'></textarea></div>
    <button class="btn" onclick="AH.importConfig()">导入配置</button>
  </div>`;
  el.querySelectorAll("#view-config tr[data-id]").forEach((tr) => {
    const id = tr.dataset.id;
    tr.addEventListener("contextmenu", (e) => providerMenu(id, e));
    tr.querySelector('[data-act="edit"]')?.addEventListener("click", () => editProvider(id));
    tr.querySelector('[data-act="fetch"]')?.addEventListener("click", () => fetchModelsFor(id, true));
    tr.querySelector('[data-act="del"]')?.addEventListener("click", () => delProv(id));
  });
}

// ---------------- 检测编排 ----------------
function pickModels(p) {
  if (p.selModels && p.selModels.length) return p.selModels;
  if (p.models && p.models.length) return p.models.slice(0, 2);
  return [];
}
function pushRow(row) {
  const r = { ...row };
  delete r.content;
  S.rows.push(r);
  if (S.activeRun) S.activeRun.rows.push(r);
  if (S.tab === "records" || S.tab === "dash") { renderRecords(); }
  renderHud();
}

// 失败归因：把失败按「主因」聚成一句结论，避免只看一堆红字不知道问题在哪
function summarizeFailures(rows) {
  const fails = rows.filter((r) => !r.ok);
  if (!fails.length) return "";
  const cls = (e) => {
    const s = String(e || "");
    if (/缺少关键词/.test(s)) return "回答不符预期";
    if (/空内容/.test(s)) return "空响应";
    if (/超时/.test(s)) return "超时";
    if (/429/.test(s)) return "限流(429)";
    if (/5\d\d/.test(s)) return "上游5xx";
    if (/401|403|鉴权|key/i.test(s)) return "鉴权/额度";
    if (/已取消/.test(s)) return "已取消";
    return "其他";
  };
  const by = new Map();
  for (const r of fails) {
    const k = cls(r.error);
    by.set(k, (by.get(k) || 0) + 1);
  }
  const aff = new Map();  // 受影响的模型
  for (const r of fails) {
    const k = cls(r.error);
    if (!aff.has(k)) aff.set(k, new Set());
    if (r.model) aff.get(k).add(r.model);
  }
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}（${[...(aff.get(k) || [])].slice(0, 2).join(", ")}${(aff.get(k)?.size || 0) > 2 ? " 等" + aff.get(k).size + " 个模型" : ""}）`)
    .join(" · ");
}

// 模型名缩写（端点卡上的阶段文字用）
const shortModel = (m) => {
  const t = String(m || "");
  return t.length > 18 ? t.slice(0, 17) + "…" : t;
};

function setRunUI(on) {
  S.running = on;
  $("#btnRunQuick").disabled = on;
  $("#btnRunFull").disabled = on;
  $("#btnStop").disabled = !on;
}

// ---- 开跑前预估：用例数 / 预计耗时，长跑先确认 ----
function buildPlan(targets, full) {
  const t = S.settings.tests;
  const useConcur = !!full || !!t.concur;
  const concurN = Math.max(1, Math.min(64, parseInt(S.settings.concurN, 10) || 4));
  // 每个模型的单次用例数（连通对端点只算一次，这里按模型计其余项）
  let perModel = 0;
  if (t.latency) perModel += (S.settings.latencyN || 3) * (1 + (S.settings.retries || 0) * 0.3);
  if (t.stream) perModel += 1.2;
  if (t.tps) perModel += 1.2;
  if (useConcur) perModel += concurN * 1.2;
  let total = 0, modelCount = 0;
  for (const p of targets) {
    total += 1;                                  // 连通
    if (p.type === "custom") continue;
    const n = (p.selModels?.length || (p.models?.length ? Math.min(2, p.models.length) : 0));
    modelCount += n;
    total += n * perModel;
  }
  total = Math.round(total);
  // 单请求按 1.8s 估（真实数据里 p50 约 1.5–5.9s，取偏乐观值）
  const secs = Math.max(1, Math.round(total * 1.8 + targets.length * 0.6));
  const estText = secs < 60 ? `${secs}s` : `${(secs / 60).toFixed(1)} 分钟`;
  return {
    total, modelCount, useConcur, concurN,
    estSecs: secs, estText,
    // 超过 3 分钟就算长跑，先让用户确认
    longRun: secs > 180,
  };
}

async function runBattery(full, onlyIds) {
  if (S.running) return;
  const only = Array.isArray(onlyIds) && onlyIds.length ? onlyIds : null;
  const targets = S.providers.filter((p) => p.enabled !== false && (!only || only.includes(p.id)));
  if (!targets.length) { toast("没有启用的端点，先添加或导入", "bad"); return; }

  // ---- 开跑前预检：这些问题不该等到跑完才发现 ----
  const plan = buildPlan(targets, full);
  if (!plan.total) { toast("没有可测的模型：请先在端点里「获取模型」或指定测试模型", "bad"); return; }
  if (plan.longRun) {
    const go = confirm(
      `本次预计执行 ${plan.total} 个用例、约 ${plan.estText}。\n\n` +
      `端点 ${targets.length} · 模型 ${plan.modelCount} · 并发 ${plan.useConcur ? plan.concurN : "关"}\n\n继续？`
    );
    if (!go) return;
  }

  S.rows = [];
  S.filterRun = null;
  S.activeRun = { ts: Date.now(), rows: [], concur: [] };
  S.abort = new AbortController();
  S.doneIds = new Set();
  S.runCursor = null;
  setRunUI(true);
  ecgState("busy");
  setStatus("检测开始…");
  const retries = Math.max(0, Math.min(3, parseInt(S.settings.retries, 10) || 0));
  // 阶段提示：同时写状态栏与端点卡「正在测试」文字
  const phase = (p, text) => { setStatus(`检测 ${p.name} · ${text}`); setProvPhase(text); };
  let retryCount = 0;
  const useConcur = !!full || !!S.settings.tests.concur;
  const concurN = () => Math.max(1, Math.min(64, parseInt(S.settings.concurN, 10) || 4));

  try {
    for (const p of targets) {
      if (!S.running) break;
      markProvTesting(p.id, "连通性检测");
      setProgress("");
      if (S.settings.tests.connect) {
        const c = await opConnectivity(p, { timeoutMs: S.settings.connectTimeoutMs, signal: S.abort.signal });
        pushRow(c);
        if (p.type !== "custom" && c.ok && c.models?.length) { p.models = c.models; await storeSave("providers", S.providers); renderProviders(); }
      }
      if (p.type === "custom") { markProvDone(p.id); continue; }

      let models = pickModels(p);
      if (!models.length) {
        phase(p, "拉取模型");
        try {
          const ms = await listModels(p, { timeoutMs: S.settings.connectTimeoutMs, signal: S.abort.signal });
          p.models = ms;
          await storeSave("providers", S.providers);
          renderProviders();
          models = ms.slice(0, 2);
        } catch (e) {
          pushRow({ provider: p.name, kind: "connect", ok: false, status: 0, error: "模型列表拉取失败：" + e.message, latencyMs: 0, t: Date.now(), preview: "" });
          markProvDone(p.id);
          continue;
        }
      }

      let mi = 0;
      for (const model of models) {
        if (!S.running) break;
        setProvPhase(`${shortModel(model)} 测试中`);
        const prompt = S.prompts[mi++ % S.prompts.length];
        if (S.settings.tests.latency) {
          phase(p, `${shortModel(model)} · 延迟×${S.settings.latencyN}`);
          const agg = await opLatency(p, model, prompt, {
            n: S.settings.latencyN, timeoutMs: S.settings.timeoutMs, signal: S.abort.signal,
            retries,
            onRow: (r) => { if (r.retried) retryCount++; pushRow({ ...r, kind: "chat" }); },
          });
          pushRow({
            provider: p.name, model, kind: "latency", agg: true,
            ok: agg.samples > 0 && agg.ok === agg.samples,
            p50: agg.p50, p95: agg.p95, latencyMs: agg.p50 ?? 0,
            error: agg.ok === agg.samples ? "" : `${agg.samples - agg.ok}/${agg.samples} 失败`,
            tokens: null, chars: 0, t: Date.now(), preview: `n=${agg.samples}`,
          });
        }
        if (S.settings.tests.stream) {
          phase(p, `${shortModel(model)} · 流式`);
          let liveChars = 0;
          const r = await opChatRetry(p, model, prompt, {
            stream: true, timeoutMs: S.settings.timeoutMs, signal: S.abort.signal, retries,
            onDelta: (d) => { liveChars += d.length; setProgress(`流式接收 ${liveChars} 字`); },
          });
          if (r.retried) retryCount++;
          pushRow(r);
          setProgress("");
        }
        if (S.settings.tests.tps) {
          phase(p, `${shortModel(model)} · Token 速率`);
          const r = await opChatRetry(p, model, prompt, { kind: "tps", timeoutMs: S.settings.timeoutMs, signal: S.abort.signal, retries });
          if (r.retried) retryCount++;
          pushRow(r);
        }
        if (useConcur) {
          const n = concurN();
          phase(p, `${shortModel(model)} · 并发×${n}`);
          const t0c = Date.now();
          const res = await opConcurrent(p, model, S.prompts, {
            n, timeoutMs: S.settings.timeoutMs, signal: S.abort.signal,
            onProgress: (ev) => {
              const el = (Date.now() - t0c) / 1000;
              setProgress(`并发 ${n} — ${ev.finished}/${ev.total} · 已 ${el.toFixed(0)}s`);
            },
          });
          S.activeRun.concur.push(res);
          const v = concurrencyVerdict(res);
          pushRow({
            provider: p.name, model, kind: "concur", agg: true,
            ok: !!v?.supported,
            p50: res.p50, p95: res.p95, latencyMs: res.p50 ?? 0,
            t: Date.now(),
            error: v?.supported ? "" : `${res.fail}/${res.ok + res.fail} 失败：${res.errors.join(" | ")}`,
            preview: `并发 ${res.concurrency} · 通过 ${res.ok}/${res.ok + res.fail} · ${
              res.throughput != null ? res.throughput + " req/s" : "—"} · 墙钟 ${res.wallMs}ms`,
          });
          setProgress("");
        }
        if (S.settings.gapMs) await sleep(S.settings.gapMs);
      }
      markProvDone(p.id);
    }
  } catch (e) {
    toast("检测异常：" + e.message, "bad");
    setStatus("异常：" + e.message);
  }

  // 收尾
  S.running = false;
  S.runCursor = null;
  if (S.doneIds) S.doneIds.clear();
  setRunUI(false);
  renderProviders();
  renderVitals();
  setProgress("");
  const rows = S.activeRun.rows;
  const stats = { pass: rows.filter((r) => r.ok).length, fail: rows.filter((r) => !r.ok).length };
  const rec = {
    ts: S.activeRun.ts, durationMs: Date.now() - S.activeRun.ts,
    providerCount: targets.length, stats, rows, concur: S.activeRun.concur,
    retries: retryCount, interrupted: S.abort.signal.aborted,
  };
  const interrupted = S.abort.signal.aborted;
  S.activeRun = null;
  if (rows.length) {
    S.runs.unshift(rec);
    if (S.runs.length > 100) S.runs.length = 100;
    await storeSave("history", S.runs);
  }
  ecgState(!rows.length ? "idle" : stats.fail === 0 ? "ok" : stats.pass === 0 ? "bad" : "busy");
  setStatus(
    `${interrupted ? "已停止" : "完成"} · 通过 ${stats.pass} · 失败 ${stats.fail}` +
    `${retryCount ? ` · 重试 ${retryCount}` : ""} · ${(rec.durationMs / 1000).toFixed(1)}s`
  );
  if (rows.length) {
    const summary = summarizeFailures(rows);
    toast(
      `检测完成：${stats.pass} 通过 / ${stats.fail} 失败${retryCount ? `（自动重试 ${retryCount} 次）` : ""}` +
      (summary ? `\n主因：${summary}` : ""),
      stats.fail ? "bad" : "ok"
    );
  }
  renderAll();
}

function stopRun() {
  if (!S.running) return;
  S.running = false;
  try { S.abort.abort(); } catch {}
  setStatus("正在停止…");
}

// ---------------- 渲染汇总 ----------------
function renderAll() {
  renderHud();
  renderProviders();
  renderVitals();
  renderRecords();
  renderHistory();
  renderConfig();
  if (S.tab === "dash") renderCharts();
}

// ---------------- 端点编辑 ----------------
// 模型选择器状态：已选集合（拉取到的模型勾选）+ 手写补充
const SEL = { set: new Set(), extra: "" };

function providerForm(p) {
  const pulled = [...new Set(p.models || [])].sort();
  const sel = new Set(p.selModels || []);
  const extra = (p.selModels || []).filter((m) => !pulled.includes(m));
  SEL.set = new Set([...sel].filter((m) => pulled.includes(m)));
  SEL.extra = extra.join("\n");
  return `
    <div class="grid2">
      <div class="field"><label>名称</label><input id="f_name" value="${esc(p.name || "")}" placeholder="例如：主力中转·A"></div>
      <div class="field"><label>协议类型</label><select id="f_type">
        ${TYPES.map((t) => `<option value="${t.value}" ${p.type === t.value ? "selected" : ""}>${t.label}</option>`).join("")}
      </select></div>
    </div>

    <div class="field">
      <label>BaseURL</label>
      <div class="row-inline">
        <input id="f_base" value="${esc(p.baseUrl || "")}" placeholder="https://host/v1">
        <button class="btn tiny" id="f_fetch" type="button">获取模型</button>
      </div>
      <div class="hint">填中转/官方地址即可，只写域名会自动补 <b>/v1</b>；粘错成 <b>/chat/completions</b> 也会自动纠正。</div>
    </div>

    <div class="field">
      <label>API Key</label>
      <div class="row-inline">
        <input id="f_key" type="password" value="${esc(p.apiKey || "")}" placeholder="sk-...">
        <button class="btn tiny" id="f_eye" type="button">显示</button>
        <button class="btn tiny" id="f_clip" type="button">识别剪贴板</button>
      </div>
    </div>

    <div class="field switch-field">
      <label class="switch"><input type="checkbox" id="f_enabled" ${p.enabled !== false ? "checked" : ""}><span class="track"></span><span>启用该端点（参与检测）</span></label>
    </div>

    <div class="field">
      <div class="model-head">
        <label style="margin:0">测试模型 <span class="count-pill" id="f_selcount">0</span></label>
        <span class="btn-row">
          <button class="btn tiny" id="f_all" type="button">全选</button>
          <button class="btn tiny" id="f_none" type="button">清空</button>
        </span>
      </div>
      <input id="f_search" class="model-search" placeholder="搜索模型…" ${pulled.length ? "" : "disabled"}>
      <div class="model-list" id="f_modellist">
        ${pulled.length
          ? pulled.map((m) => `<label class="model-row" data-m="${esc(m.toLowerCase())}">
              <input type="checkbox" data-model="${esc(m)}" ${SEL.set.has(m) ? "checked" : ""}>
              <span class="mn">${esc(m)}</span></label>`).join("")
          : `<div class="empty-sm">还没拉取到模型 · 点上方「获取模型」</div>`}
      </div>
      <label class="hint" style="margin-top:10px;display:block">手动补充模型（每行一个，拉取不到的可以手填）</label>
      <textarea id="f_selmodels" style="min-height:64px">${esc(extra.join("\n"))}</textarea>
      <div class="hint">不勾不填 = 检测时自动取前 2 个模型。</div>
    </div>`;
}

// 从表单读连接参数（不落库），供「获取模型」用当前输入直接探测
function readFormConn() {
  const type = $("#f_type")?.value || "openai";
  const raw = ($("#f_base")?.value || "").trim();
  return { type, baseUrl: raw ? normalizeBase(raw, type) : "", apiKey: ($("#f_key")?.value || "").trim() };
}
function refreshSelCount() {
  const n = SEL.set.size + SEL.extra.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  const el = $("#f_selcount");
  if (el) el.textContent = n;
}
function bindModelList() {
  const list = $("#f_modellist");
  if (!list) return;
  list.querySelectorAll("input[data-model]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) SEL.set.add(cb.dataset.model);
      else SEL.set.delete(cb.dataset.model);
      refreshSelCount();
    });
  });
  refreshSelCount();
}
function applyModelSearch(q) {
  const kw = String(q || "").trim().toLowerCase();
  $("#f_modellist")?.querySelectorAll(".model-row").forEach((row) => {
    row.classList.toggle("hidden", !!kw && !row.dataset.m.includes(kw));
  });
}
function renderFormModels(models) {
  const list = [...new Set(models)].sort();
  const box = $("#f_modellist");
  if (box) {
    box.innerHTML = list.length
      ? list.map((m) => `<label class="model-row" data-m="${esc(m.toLowerCase())}">
          <input type="checkbox" data-model="${esc(m)}" ${SEL.set.has(m) ? "checked" : ""}>
          <span class="mn">${esc(m)}</span></label>`).join("")
      : `<div class="empty-sm">该端点没有返回任何模型</div>`;
  }
  const s = $("#f_search");
  if (s) s.disabled = !list.length;
  bindModelList();
  applyModelSearch($("#f_search")?.value);
}
async function fetchModelsFromForm() {
  const btn = $("#f_fetch");
  const p = S.providers.find((x) => x.id === (S._editingId || ""));
  const conn = readFormConn();
  if (!conn.baseUrl) { toast("先填 BaseURL", "bad"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "获取中…"; }
  try {
    const models = await listModels(conn, { timeoutMs: S.settings.connectTimeoutMs });
    renderFormModels(models);
    if (p) { p.models = models; await storeSave("providers", S.providers); renderProviders(); }
    toast(`获取到 ${models.length} 个模型`, "ok");
  } catch (e) {
    toast("获取失败：" + e.message, "bad");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "获取模型"; }
  }
}
function selectAllFormModels(on) {
  if (on) {
    const all = [...new Set(S.providers.find((x) => x.id === (S._editingId || ""))?.models || [])];
    if (!all.length) { toast("还没有模型列表，先点「获取模型」", "bad"); return; }
    SEL.set = new Set(all);
  } else SEL.set = new Set();
  $("#f_modellist")?.querySelectorAll("input[data-model]").forEach((cb) => { cb.checked = on; });
  refreshSelCount();
}
function collectSelModels() {
  const checked = [...SEL.set];
  const extra = ($("#f_selmodels")?.value || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return [...new Set([...checked, ...extra])];
}

// 右键菜单：拉取模型列表（异步刷新，不阻塞 UI）
async function fetchModelsFor(id, notify) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  if (!p.baseUrl) { if (notify) toast("该端点没有 BaseURL", "bad"); return; }
  try {
    const models = await listModels(p, { timeoutMs: S.settings.connectTimeoutMs });
    p.models = models;
    await storeSave("providers", S.providers);
    renderProviders();
    renderAll();
    if (notify) toast(`${p.name}：获取到 ${models.length} 个模型`, "ok");
    return models;
  } catch (e) {
    if (notify) toast(`获取失败：${e.message}`, "bad");
  }
}

function editProvider(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  S._editingId = id;
  showModal(`编辑端点 · ${p.name || "(未命名)"}`, providerForm(p), [
    { label: "取消", cls: "", fn: hideModal },
    { label: "保存", cls: "primary", fn: () => saveProviderFromModal(p.id) },
  ]);
  bindModelList();
  $("#f_type")?.addEventListener("change", (e) => {
    const t = e.target.value;
    const base = $("#f_base");
    if (base && !base.value.trim()) {
      const a = ADAPTERS[t];
      if (a && a.defaultBase) base.value = a.defaultBase();
    }
  });
  $("#f_fetch")?.addEventListener("click", fetchModelsFromForm);
  $("#f_all")?.addEventListener("click", () => selectAllFormModels(true));
  $("#f_none")?.addEventListener("click", () => selectAllFormModels(false));
  $("#f_search")?.addEventListener("input", (e) => applyModelSearch(e.target.value));
  $("#f_selmodels")?.addEventListener("input", refreshSelCount);
  $("#f_eye")?.addEventListener("click", () => {
    const el = $("#f_key");
    if (!el) return;
    const show = el.type === "password";
    el.type = show ? "text" : "password";
    $("#f_eye").textContent = show ? "隐藏" : "显示";
  });
  $("#f_clip")?.addEventListener("click", () => tryClipboardIntoForm({ manual: true }));
}

function saveProviderFromModal(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  const nm = $("#f_name").value.trim();
  const rawBase = $("#f_base").value.trim();
  if (!nm || !rawBase) { toast("名称和 BaseURL 必填", "bad"); return; }
  const baseUrl = normalizeBase(rawBase, $("#f_type").value);
  p.name = nm;
  p.type = $("#f_type").value;
  p.baseUrl = baseUrl;
  p.apiKey = $("#f_key").value.trim();
  p.enabled = $("#f_enabled").checked;
  p.selModels = collectSelModels();
  hideModal();
  storeSave("providers", S.providers);
  renderAll();
  toast(`已保存 ${p.name}（测试模型 ${p.selModels.length || "自动"}）`, "ok");
}

// 把连接信息写进表单（供「识别剪贴板」用）
function writeFormConn(conn, overwrite) {
  if (!conn) return;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el || !val) return;
    if (!overwrite && el.value && el.value.trim()) return;
    el.value = val;
  };
  if (conn.type) {
    const sel = $("#f_type");
    if (sel && TYPES.some((t) => t.value === conn.type)) {
      // 仅在用户没手动改过类型时套用（新建端点视为未改）
      if (overwrite || sel.dataset.touched !== "1") {
        sel.value = conn.type;
        $("#customFields")?.classList.toggle("hidden", sel.value !== "custom");
      }
    }
  }
  set("f_base", conn.baseUrl);
  set("f_key", conn.apiKey);
  if (conn.name) set("f_name", conn.name);
}

// 「添加端点」时探测剪贴板：有连接信息就在表单上方浮出提示条（不打断编辑表单）
async function tryClipboardIntoForm(opts = {}) {
  const manual = !!opts.manual;
  const text = await clipRead();
  if (!text) {
    if (manual) toast("剪贴板为空或不可读", "bad");
    return;
  }
  const conn = parseConnText(text);
  if (!conn || (!conn.baseUrl && !conn.apiKey)) {
    if (manual) toast("剪贴板里没识别到连接信息", "bad");
    return;
  }
  showConnTip(conn);
}

let _tipEl = null;
function closeConnTip() { if (_tipEl) { _tipEl.remove(); _tipEl = null; } }
function showConnTip(conn) {
  closeConnTip();
  const el = document.createElement("div");
  el.className = "conn-tip";
  el.innerHTML = `
    <div class="ct-head"><span class="ct-ic">📋</span>识别到剪贴板连接信息</div>
    <div class="ct-body">
      <div class="kv"><span>名称</span><b>${esc(conn.name || "—")}</b></div>
      <div class="kv"><span>类型</span><b>${esc(TYPE_LABEL[conn.type] || conn.type)}</b></div>
      <div class="kv"><span>BaseURL</span><b>${esc(conn.baseUrl || "—")}</b></div>
      <div class="kv"><span>API Key</span><b>${esc(conn.apiKey || "—")}</b></div>
    </div>
    <div class="ct-actions">
      <button class="btn tiny primary" id="ct_fill">填入表单</button>
      <button class="btn tiny" id="ct_keyonly">只填 Key</button>
      <button class="btn tiny" id="ct_ignore">忽略</button>
    </div>`;
  document.body.appendChild(el);
  _tipEl = el;
  invoke("log", { data: "conn-tip shown " + (conn.baseUrl || "") + " key=" + (conn.apiKey ? "yes" : "no") });
  el.querySelector("#ct_fill").addEventListener("click", () => {
    writeFormConn(conn, true);
    closeConnTip();
    toast("已填入连接信息", "ok");
  });
  el.querySelector("#ct_keyonly").addEventListener("click", () => {
    writeFormConn({ apiKey: conn.apiKey }, true);
    closeConnTip();
    toast("已填入 API Key", "ok");
  });
  el.querySelector("#ct_ignore").addEventListener("click", closeConnTip);
}

function addProv() {
  const p = { id: uid(), name: "", type: "openai", baseUrl: "", apiKey: "", enabled: true, models: [], selModels: [] };
  S.providers.push(p);
  editProvider(p.id);
  // 自动探测剪贴板（不阻塞、失败静默）
  setTimeout(() => { tryClipboardIntoForm().catch(() => {}); }, 260);
}
function delProv(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`删除端点「${p.name}」？`)) return;
  S.providers = S.providers.filter((x) => x.id !== id);
  storeSave("providers", S.providers);
  renderAll();
}

// ---------------- 批量导入 ----------------
function parseImport(text) {
  const out = [];
  const t = String(text || "").trim();
  if (!t) return out;
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : (j.providers || []);
      for (const x of arr) {
        if (!x) continue;
        const baseUrl = x.baseUrl || x.url || "";
        if (!baseUrl) continue;
        out.push({
          name: x.name || baseUrl, type: TYPES.some((tt) => tt.value === x.type) ? x.type : "openai",
          baseUrl, apiKey: String(x.apiKey || x.key || "").replace(/^Bearer\s+/i, ""),
        });
      }
      return out;
    } catch { /* 继续按行解析 */ }
  }
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const parts = s.split("|").map((x) => x.trim());
    let name, type = "openai", baseUrl, apiKey = "";
    if (parts.length >= 4) { [name, type, baseUrl, apiKey] = parts; }
    else if (parts.length === 3) {
      if (TYPES.some((tt) => tt.value === parts[1].toLowerCase())) { [name, type, baseUrl] = parts; }
      else { [name, baseUrl, apiKey] = parts; }
    } else if (parts.length === 2) { [name, baseUrl] = parts; }
    else { baseUrl = parts[0]; name = parts[0]; }
    if (!baseUrl) continue;
    if (!TYPES.some((tt) => tt.value === type)) type = "openai";
    apiKey = String(apiKey || "").replace(/^Bearer\s+/i, "");
    out.push({ name: name || baseUrl, type, baseUrl, apiKey });
  }
  return out;
}

function importModal() {
  const help = `每行一个端点，格式任选：<br>
  <span class="hint">名称 | 类型 | BaseURL | Key<br>名称 | BaseURL | Key<br>名称 | BaseURL<br>BaseURL</span><br><br>
  <span class="hint">类型：openai（OpenAI 兼容·默认）/ anthropic / gemini / custom；也支持直接粘贴 JSON 数组。</span>`;
  showModal("批量导入端点", `
    <div class="field"><label>端点列表</label><textarea id="imp_text" style="min-height:160px" placeholder="中转A | openai | https://a.example.com/v1 | sk-xxx
中转B | https://b.example.com/v1 | sk-yyy
Claude | anthropic | https://api.anthropic.com | sk-ant-xxx
Gemini | gemini | https://generativelanguage.googleapis.com/v1beta | AIza...
探针 | custom | https://example.com/health"></textarea></div>
    <div class="hint">${help}</div>`, [
    { label: "取消", fn: hideModal },
    { label: "导入", cls: "primary", fn: importFromModal },
  ]);
}

function importFromModal() {
  const list = parseImport($("#imp_text").value);
  if (!list.length) { toast("没解析到有效端点", "bad"); return; }
  let added = 0, skipped = 0;
  for (const item of list) {
    if (S.providers.some((p) => p.name === item.name && p.baseUrl === item.baseUrl)) { skipped++; continue; }
    S.providers.push({ id: uid(), enabled: true, models: [], selModels: [], ...item });
    added++;
  }
  hideModal();
  storeSave("providers", S.providers);
  renderAll();
  toast(`导入完成：新增 ${added}${skipped ? " · 跳过重复 " + skipped : ""}`, "ok");
}

// ---------------- 设置 / 提示词 / 数据 ----------------
async function saveSettings() {
  const g = (id, def) => { const el = document.getElementById(id); return el ? el.value : def; };
  S.settings.timeoutMs = Math.max(1000, parseInt(g("cfg_timeout", 60000)) || 60000);
  S.settings.connectTimeoutMs = Math.max(1000, parseInt(g("cfg_ctimeout", 15000)) || 15000);
  S.settings.latencyN = Math.max(1, Math.min(20, parseInt(g("cfg_latn", 3)) || 3));
  S.settings.concurN = Math.max(1, Math.min(64, parseInt(g("cfg_concur", 4)) || 4));
  S.settings.retries = Math.max(0, Math.min(3, parseInt(g("cfg_retries", 1)) || 0));
  S.settings.gapMs = Math.max(0, parseInt(g("cfg_gap", 150)) || 0);
  const on = document.getElementById("cfg_concur_on");
  if (on) S.settings.tests.concur = on.checked;
  await storeSave("settings", S.settings);
  renderToggles();
  renderConfig();
  toast("参数已保存", "ok");
}
function toggleConcur(on) {
  S.settings.tests.concur = !!on;
  storeSave("settings", S.settings);
  renderToggles();
  toast(on ? `并发开：按 ${S.settings.concurN || 4} 并发发起请求` : "并发关：逐个请求", "ok");
}

function addPrompt() {
  const label = $("#np_label").value.trim();
  const user = $("#np_user").value.trim();
  const expect = $("#np_expect").value.trim();
  if (!label || !user) { toast("标签和内容必填", "bad"); return; }
  S.prompts.push({ label, user, expect: expect || null });
  storeSave("prompts", S.prompts);
  renderConfig();
  toast("已添加提示词", "ok");
}
function delPrompt(i) {
  S.prompts.splice(i, 1);
  storeSave("prompts", S.prompts);
  renderConfig();
}

function openDir() {
  if (inWV) invoke("openDataDir").then((r) => toast(r && r.ok ? "已打开：" + (r.data || "") : "打开失败", r && r.ok ? "ok" : "bad"));
  else toast("浏览器模式下无数据目录", "bad");
}
function exportConfig() {
  const data = { providers: S.providers, settings: S.settings, prompts: S.prompts, exportedAt: new Date().toISOString() };
  const name = `config-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
  if (inWV) {
    invoke("save", { name, data: JSON.stringify(data, null, 2) }).then((r) =>
      toast(r && r.ok ? `已导出：${name}` : "导出失败", r && r.ok ? "ok" : "bad"));
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = name; a.click();
  }
}
function importConfig() {
  const txt = $("#cfg_import")?.value?.trim();
  if (!txt) { toast("先粘贴配置 JSON", "bad"); return; }
  try {
    const j = JSON.parse(txt);
    if (Array.isArray(j.providers)) S.providers = j.providers.map((p) => ({ id: uid(), enabled: true, models: [], selModels: [], ...p }));
    if (j.settings) S.settings = { ...DEFAULT_SETTINGS, ...j.settings, tests: { ...DEFAULT_SETTINGS.tests, ...(j.settings.tests || {}) } };
    if (Array.isArray(j.prompts) && j.prompts.length) S.prompts = j.prompts;
    storeSave("providers", S.providers);
    storeSave("settings", S.settings);
    storeSave("prompts", S.prompts);
    renderAll();
    toast("配置已导入", "ok");
  } catch (e) {
    toast("JSON 解析失败：" + e.message, "bad");
  }
}
async function clearHistory() {
  if (!confirm("清空全部历史记录？")) return;
  S.runs = [];
  await storeSave("history", S.runs);
  renderAll();
  toast("历史已清空", "ok");
}

// ---------------- 右键菜单 ----------------
let _menuEl = null;
function closeMenu() {
  if (_menuEl) { _menuEl.remove(); _menuEl = null; }
}
function openMenu(x, y, title, items) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "ctxmenu";
  const rows = items.filter(Boolean).map((it) => {
    if (it.sep) return `<div class="ctx-sep"></div>`;
    return `<button class="ctx-item ${it.kind || ""}" data-act="${esc(it.id || it.label)}" ${it.disabled ? "disabled" : ""}>${esc(it.label)}${it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ""}</button>`;
  }).join("");
  el.innerHTML = (title ? `<div class="ctx-title">${esc(title)}</div>` : "") + rows;
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  el.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  _menuEl = el;
  el.querySelectorAll(".ctx-item").forEach((b) => {
    b.addEventListener("click", async () => {
      const it = items.find((x) => !x.sep && (x.id || x.label) === b.dataset.act);
      closeMenu();
      if (it && it.fn) await it.fn();
    });
  });
}
function menuAt(e, title, items) {
  e.preventDefault();
  e.stopPropagation();
  openMenu(e.clientX, e.clientY, title, items);
}

// 复制动作：值 + 标签
const cp = (val, label) => ({ label: "复制" + (label || ""), fn: () => copyText(val, label || "") });

function providerMenu(id, e) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  const items = [
    { label: "编辑端点…", fn: () => editProvider(id) },
    { label: "检测此端点", fn: () => runBattery(false, [id]) },
    { label: "获取模型列表", hint: (p.models || []).length ? p.models.length + " 个" : "", fn: () => fetchModelsFor(id, true) },
    { label: (p.enabled === false ? "启用" : "停用") + "该端点", fn: async () => { p.enabled = p.enabled === false; await storeSave("providers", S.providers); renderAll(); } },
    { sep: true },
    cp(p.name, "名称"),
    cp(p.baseUrl, "BaseURL"),
    cp(p.apiKey, "API Key"),
    { label: "复制连接配置（URL + Key）", fn: () => copyText(`${p.baseUrl}\n${p.apiKey || ""}`, "连接配置") },
    { label: "复制已拉取模型列表", disabled: !(p.models || []).length, fn: () => copyText((p.models || []).join("\n"), (p.models || []).length + " 个模型") },
    { sep: true },
    { label: "删除端点", kind: "danger", fn: () => delProv(id) },
  ];
  menuAt(e, p.name || "端点", items);
}

function chartMenu(hostId, e) {
  const c = charts[hostId];
  if (!c) return;
  const src = chartSrc();
  const items = [
    { label: "刷新图表", fn: () => { try { c.resize(); } catch {} renderCharts(); } },
    { label: "导出本图表 PNG", fn: () => exportChartPng(hostId) },
    { sep: true },
    { label: "复制本轮数据 JSON", fn: () => copyText(JSON.stringify(src, null, 2), "本轮数据") },
    cp(new Date(src.ts || Date.now()).toLocaleString("zh-CN", { hour12: false }), "时间"),
    { sep: true },
    { label: "导出报告表格（CSV）", fn: () => exportReportCsv(src) },
  ];
  menuAt(e, "图表", items);
}

function exportChartPng(hostId) {
  const c = charts[hostId];
  if (!c) { toast("图表未就绪", "bad"); return; }
  try {
    const url = c.getDataURL({ pixelRatio: 2, backgroundColor: pal().panel });
    const name = `chart-${hostId}-${stampName()}.png`;
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    toast("已导出图表：" + name, "ok");
  } catch (err) { toast("导出失败：" + err.message, "bad"); }
}

function currentRows() {
  return S.filterRun ? S.filterRun.rows : (S.runs.length && !S.running ? S.runs[0].rows : S.rows);
}
function rowSourceTs() {
  if (S.filterRun) return S.filterRun.ts;
  if (S.runs.length && !S.running) return S.runs[0].ts;
  return S.activeRun ? S.activeRun.ts : null;
}

function recordMenu(idx, e) {
  const r = (S._shownRows || currentRows())[idx];
  if (!r) return;
  const items = [
    { label: r.ok ? "复制详情" : "复制错误", fn: () => copyText(r.error || r.preview || "", "详情") },
    cp(r.provider || "", "端点"),
    cp(r.model || "", "模型"),
    { label: "复制整行（TSV）", fn: () => copyText(rowTsv(r), "整行") },
    { sep: true },
    { label: "只看此端点", fn: () => { S.filterProv = r.provider; S.filter = "all"; renderRecords(); } },
    { label: "只看失败", fn: () => { S.filter = "fail"; renderRecords(); } },
    { sep: true },
    { label: "导出报告表格（CSV）", fn: () => exportReportCsv(S.filterRun || { ts: rowSourceTs(), rows: currentRows() }) },
    { label: "导出本表格（CSV）", fn: () => exportCsv() },
  ];
  menuAt(e, KINDS[r.kind] || "记录", items);
}
const rowTsv = (r) => [
  hhmmss(r.t || Date.now()), r.provider, KINDS[r.kind] || r.kind, r.model || "",
  r.ok ? "通过" : "失败",
  r.agg ? `p50 ${r.p50} / p95 ${r.p95}` : (r.latencyMs ?? ""),
  r.ttftMs ?? "", r.tps != null ? `${r.tps} ${r.unit || ""}` : "", r.error || r.preview || "",
].join("\t");

function historyMenu(ts, e) {
  const r = S.runs.find((x) => x.ts === ts);
  if (!r) return;
  const items = [
    { label: "查看本轮", fn: () => window.AH.viewRun(ts) },
    { label: "导出报告表格（CSV）", fn: () => exportReportCsv(r) },
    { sep: true },
    cp(new Date(r.ts).toLocaleString("zh-CN", { hour12: false }), "时间"),
    { label: "复制本轮摘要", fn: () => copyText(`${new Date(r.ts).toLocaleString("zh-CN", { hour12: false })} 端点${r.providerCount} 用例${r.rows.length} 通过${r.stats.pass} 失败${r.stats.fail} ${(r.durationMs / 1000).toFixed(1)}s`, "摘要") },
    { sep: true },
    { label: "清空本轮记录", kind: "danger", fn: () => { S.filterRun = r; clearRecords(); } },
    { label: "删除本轮", kind: "danger", fn: () => window.AH.delRun(ts) },
  ];
  menuAt(e, "历史记录", items);
}

// ---------------- 报告导出（端点 × 模型 × 明细） ----------------
function stampName() {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
}
// 统一落盘：原生壳写数据目录 / 浏览器走下载
function saveFile(name, text) {
  if (inWV) {
    invoke("save", { name, data: text }).then((r) =>
      toast(r && r.ok ? `已导出到数据目录：${name}` : "导出失败", r && r.ok ? "ok" : "bad"));
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name; a.click();
  }
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csvRow = (arr) => arr.map(csvCell).join(",");

// 汇总某个模型在本次检测中的表现
function modelStat(rows) {
  const ok = rows.filter((r) => r.ok).length;
  const fail = rows.length - ok;
  const lat = rows.filter((r) => r.ok && r.latencyMs != null).map((r) => r.latencyMs);
  const ttfts = rows.filter((r) => r.ok && r.ttftMs != null).map((r) => r.ttftMs);
  const tps = rows.filter((r) => r.ok && r.tps != null).map((r) => r.tps);
  const aggRows = rows.filter((r) => r.agg);
  const errs = [...new Set(rows.filter((r) => !r.ok).map((r) => r.error || r.preview || "失败"))];
  return {
    ok, fail,
    total: rows.length,
    status: !rows.length ? "未测试" : fail === 0 ? "成功" : ok === 0 ? "失败" : "部分成功",
    p50: aggRows.length ? aggRows[aggRows.length - 1].p50 : pct(lat, 0.5),
    p95: aggRows.length ? aggRows[aggRows.length - 1].p95 : pct(lat, 0.95),
    ttft: ttfts.length ? Math.round(avg(ttfts)) : null,
    tps: tps.length ? Math.round(avg(tps) * 10) / 10 : null,
    unit: rows.find((r) => r.unit)?.unit || "tok/s",
    errors: errs.slice(0, 3),
    kinds: [...new Set(rows.map((r) => KINDS[r.kind] || r.kind))],
  };
}

// 报告：块1 = 端点（API/Key + 成功模型/失败模型），块2 = 逐模型，块3 = 用例明细
function buildReport(run) {
  const src = run || { ts: rowSourceTs() || Date.now(), rows: currentRows(), concur: [] };
  const rows = (src.rows || []);
  const when = new Date(src.ts || Date.now()).toLocaleString("zh-CN", { hour12: false });
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.filter((r) => !r.ok).length;
  const tested = S.providers.filter((p) => rows.some((r) => r.provider === p.name));

  const head = [
    `# API 健康检测报告`,
    `# 时间,${csvCell(when)}`,
    `# 端点,${tested.length}(已测) / ${S.providers.length}(配置)`,
    `# 用例,${rows.length}  通过,${pass}  失败,${fail}`,
    "",
  ];

  // 块1：端点汇总 —— 含 API / Key / 成功模型 / 失败模型
  const block1 = [csvRow(["端点汇总", "", "", "", "", "", "", "", "", ""])];
  block1.push(csvRow(["端点", "类型", "BaseURL", "APIKey", "已测模型", "成功模型", "部分成功", "失败模型", "通过", "失败", "连接状态"]));
  for (const p of S.providers) {
    const prows = rows.filter((r) => r.provider === p.name);
    const conn = prows.find((r) => r.kind === "connect");
    const models = [...new Set(prows.map((r) => r.model).filter(Boolean))];
    const s = models.map((m) => ({ m, st: modelStat(prows.filter((r) => r.model === m)) }));
    const goodM = s.filter((x) => x.st.status === "成功").map((x) => x.m);
    const partM = s.filter((x) => x.st.status === "部分成功").map((x) => x.m);
    const badM = s.filter((x) => x.st.status === "失败").map((x) => x.m);
    block1.push(csvRow([
      p.name, TYPE_LABEL[p.type] || p.type, p.baseUrl, p.apiKey || "",
      models.length, goodM.join(" / "), partM.join(" / "), badM.join(" / "),
      prows.filter((r) => r.ok).length, prows.filter((r) => !r.ok).length,
      !prows.length ? "未测试" : (conn ? (conn.ok ? `正常 ${conn.latencyMs}ms` : "失败") : (p.agg ? `p50 ${p.p50} / p95 ${p.p95}` : p.name && "—")),
    ]));
  }
  block1.push("");

  // 块2：逐模型结果
  const block2 = [csvRow(["模型结果", "", "", "", "", "", "", "", "", ""])];
  block2.push(csvRow(["端点", "模型", "状态", "用例", "通过", "失败", "p50(ms)", "p95(ms)", "TTFT(ms)", "速率", "失败原因"]));
  for (const p of S.providers) {
    const prows = rows.filter((r) => r.provider === p.name);
    const models = [...new Set(prows.map((r) => r.model).filter(Boolean))];
    if (!models.length) {
      block2.push(csvRow([p.name, "—", prows.length ? "端点级失败" : "未测试", prows.length, 0, prows.length, "", "", "", "", prows[0]?.error || ""]));
      continue;
    }
    for (const m of models) {
      const st = modelStat(prows.filter((r) => r.model === m));
      block2.push(csvRow([
        p.name, m, st.status, st.total, st.ok, st.fail,
        st.p50 ?? "", st.p95 ?? "", st.ttft ?? "",
        st.tps != null ? `${st.tps} ${st.unit}` : "",
        st.errors.join(" | "),
      ]));
    }
  }
  block2.push("");

  // 块3：用例明细
  const block3 = [csvRow(["用例明细", "", "", "", "", "", "", "", "", "", ""])];
  block3.push(csvRow(["时间", "端点", "模型", "测试项", "结果", "延迟ms", "TTFTms", "速率", "详情"]));
  const detail = rows.length ? rows : (S.filterRun?.rows || S.runs[0]?.rows || S.rows);
  for (const r of detail) {
    block3.push(csvRow([
      new Date(r.t || src.ts || Date.now()).toLocaleString("zh-CN", { hour12: false }),
      r.provider || "", r.model || "—", (KINDS[r.kind] || r.kind || "") + (r.agg ? " 聚合" : ""),
      r.ok ? "通过" : "失败",
      r.agg ? `p50 ${r.p50} / p95 ${r.p95}` : (r.latencyMs ?? ""),
      r.ttftMs ?? "", r.tps != null ? `${r.tps} ${r.unit || ""}` : "",
      r.error || r.preview || "",
    ]));
  }

  // 块4：并发测试（有才输出）
  const cur = src.concur || [];
  let block4 = [];
  if (cur.length) {
    block4 = ["", csvRow(["并发测试", "", "", "", "", "", "", "", "", ""])];
    block4.push(csvRow(["端点", "模型", "并发数", "成功", "失败", "avg(ms)", "p50(ms)", "p95(ms)", "吞吐(req/s)", "墙钟(ms)", "错误"]));
    for (const r of cur) {
      block4.push(csvRow([
        r.provider || "", r.model || "", r.concurrency, r.ok, r.fail,
        r.avgMs ?? "", r.p50 ?? "", r.p95 ?? "", r.throughput ?? "", r.wallMs ?? "",
        (r.errors || []).join(" | "),
      ]));
    }
  }
  return [...head, ...block1, ...block2, ...block3, ...block4].join("\r\n") + "\r\n";
}

function exportReportCsv(run) {
  try {
    const text = "\ufeff" + buildReport(run);
    const name = `api-health-report-${stampName()}.csv`;
    saveFile(name, text);
    toast("报告已生成（端点 / 模型 / 明细 / 并发）", "ok");
  } catch (e) {
    toast("报告生成失败：" + e.message, "bad");
  }
}

// ---------------- 模态 / Toast ----------------
function showModal(title, bodyHtml, actions) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  const acts = $("#modalActions");
  acts.innerHTML = "";
  (actions || []).forEach((a) => {
    const b = document.createElement("button");
    b.className = "btn " + (a.cls || "");
    b.textContent = a.label;
    b.addEventListener("click", a.fn);
    acts.appendChild(b);
  });
  $("#modal").classList.remove("hidden");
}
function hideModal() { $("#modal").classList.add("hidden"); }

let toastSeq = 0;
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  // 支持多行：第一行标题，后续行次要色（textContent 不解析 \n，需按行建节点）
  const lines = String(msg ?? "").split("\n");
  lines.forEach((line, i) => {
    const span = document.createElement("span");
    span.className = i === 0 ? "t1" : "t2";
    span.textContent = line;
    el.appendChild(span);
  });
  el.id = "toast_" + (++toastSeq);
  $("#toasts").appendChild(el);
  // 行数多时多留一会儿
  const ttl = 3200 + Math.max(0, lines.length - 1) * 1400;
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, ttl);
  setTimeout(() => el.remove(), ttl + 400);
}

// ---------------- 静态绑定 ----------------
function bindStatic() {
  $("#btnRunQuick").addEventListener("click", () => runBattery(false));
  $("#btnRunFull").addEventListener("click", () => runBattery(true));
  $("#btnStop").addEventListener("click", stopRun);
  $("#btnImport").addEventListener("click", importModal);
  $("#btnAddProv").addEventListener("click", addProv);
  $("#themeToggle").addEventListener("click", cycleTheme);
  $("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) hideModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideModal(); closeMenu(); closeConnTip(); }
  });

  // 右键：空白处给通用菜单；输入框放行（保留原生剪贴板菜单）
  document.addEventListener("contextmenu", (e) => {
    const t = e.target;
    const tag = (t && t.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, "操作", [
      { label: "识别剪贴板连接信息", fn: () => tryClipboardIntoForm({ manual: true }) },
      { label: "添加端点", fn: addProv },
      { label: "批量导入", fn: importModal },
      { sep: true },
      { label: "快速检测", fn: () => runBattery(false) },
      { label: (S.settings.tests.concur ? "关闭并发" : "打开并发") + "开关", fn: () => toggleConcur(!S.settings.tests.concur) },
      { sep: true },
      { label: "导出报告表格（CSV）", fn: () => exportReportCsv(null) },
      { label: "导出本表格（CSV）", fn: () => exportCsv() },
      { label: "打开数据目录", fn: openDir },
      { sep: true },
      { label: "切换主题（跟随系统/浅色/深色）", fn: cycleTheme },
    ]);
  });
  // 点别处 / 滚动 / 失焦 → 关菜单（点菜单内部不关，交给菜单项自己处理）
  document.addEventListener("click", (e) => {
    if (!_menuEl) return;
    if (_menuEl.contains(e.target)) return;
    closeMenu();
  }, true);
  window.addEventListener("blur", () => closeMenu());
  document.addEventListener("scroll", () => closeMenu(), true);

  document.querySelectorAll(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      S.tab = b.dataset.tab;
      ["dash", "records", "history", "config"].forEach((t) => {
        $("#view-" + t).classList.toggle("hidden", t !== S.tab);
      });
      if (S.tab === "dash") { renderVitals(); renderCharts(); }
      if (S.tab === "records") renderRecords();
      if (S.tab === "history") renderHistory();
      if (S.tab === "config") renderConfig();
    });
  });

  window.addEventListener("resize", () => {
    Object.values(charts).forEach((c) => { try { c.resize(); } catch {} });
  });
}

// 模型结果聚合：provider × model 的状态（成功 / 部分成功 / 失败）汇总
function aggregateModelResults(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.model) continue;
    const k = r.provider + "\u0000" + r.model;
    const e = by.get(k) || { provider: r.provider, model: r.model, rows: [] };
    e.rows.push(r);
    by.set(k, e);
  }
  return [...by.values()].map((e) => ({ ...e, stat: modelStat(e.rows) }));
}

// 全局动作（供内联 onclick 调用）
window.AH = {
  saveSettings, addPrompt, delPrompt, openDir, exportConfig, importConfig, clearHistory,
  addProv, editProv: editProvider, delProv, importModal, setTheme, toggleConcur,
  exportReport: () => exportReportCsv(null),
  exportCsv,
  clearRecords,
  clearAllHistory,
  detectClipboard: () => tryClipboardIntoForm({ manual: true }),
  // 测试钩子：解析任意文本里的连接信息
  parseConn: parseConnText,
  buildReport,
  state: S,
  viewRun: (ts) => {
    const r = S.runs.find((x) => x.ts === ts);
    if (!r) return;
    S.filterRun = r;
    S.filter = "all";
    document.querySelector('.tabs button[data-tab="records"]').click();
    renderRecords();
  },
  delRun: async (ts) => {
    if (!confirm("删除这条历史？")) return;
    S.runs = S.runs.filter((x) => x.ts !== ts);
    if (S.filterRun && S.filterRun.ts === ts) S.filterRun = null;
    await storeSave("history", S.runs);
    renderAll();
  },
};