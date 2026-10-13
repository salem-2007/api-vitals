// app.js — UI 层：状态、桥接、渲染、检测编排、视觉裁判、报告
import {
  GROUPS, QUESTIONS, SVG_TASKS, TYPES, ADAPTERS, buildSvgPrompt,
  listModels, opAskQuestion, opGenSvg, opJudgeSvg, opJudgeAnswer, runPool,
  modelStats, groupStats, runStats, flattenRun, buildReportCsv, buildShareText,
  starsText, sanitizeSvg, ensureSvgSize, svgDataUrl, sleep,
  PROBE_LAYERS, PROBE_ITEMS, opRunProbes, layerProbes,
} from "./engine.js";

// ==================== 桥接（WebView2 原生壳 / 浏览器回退） ====================
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
  } catch { /* 回退 */ }
  try {
    const v = localStorage.getItem("iq_" + name);
    if (v) return JSON.parse(v);
  } catch { /* 回退 */ }
  return fallback;
}
async function storeSave(name, obj) {
  const s = JSON.stringify(obj);
  try {
    const r = await invoke("save", { name, data: s });
    if (r && r.ok) return;
  } catch { /* 回退 */ }
  try { localStorage.setItem("iq_" + name, s); } catch { /* 无存储 */ }
}
async function clipRead() {
  try {
    const r = await invoke("clipread");
    if (r && r.ok && typeof r.data === "string" && r.data.trim()) return r.data;
  } catch { /* 回退 */ }
  try { return await navigator.clipboard.readText(); } catch { return ""; }
}
async function clipWrite(text) {
  const t = String(text ?? "");
  if (!t) return false;
  try {
    const r = await invoke("clipwrite", { data: t });
    if (r && r.ok) return true;
  } catch { /* 回退 */ }
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}
async function copyText(text, label) {
  if (!text) { toast("没有可复制的内容" + (label ? "（" + label + "）" : ""), "bad"); return; }
  const ok = await clipWrite(text);
  toast(ok ? "已复制" + (label ? "：" + label : "") : "复制失败", ok ? "ok" : "bad");
}
function saveFile(name, text) {
  if (inWV) {
    invoke("save", { name, data: text }).then((r) =>
      toast(r && r.ok ? "已保存到数据目录：" + name : "保存失败", r && r.ok ? "ok" : "bad"));
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = name; a.click();
  }
}

// ==================== 从文本识别连接信息 ====================
const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/, /\bsk-[A-Za-z0-9_\-]{12,}/, /\bAIza[0-9A-Za-z_\-]{20,}/,
  /\bxai-[A-Za-z0-9_\-]{10,}/, /\bgsk_[A-Za-z0-9_\-]{10,}/, /\bBearer\s+([A-Za-z0-9_\-.{}]{12,})/i,
];
const KEY_LABEL = /(?:api[\s_-]?key|apiKey|密钥|密匙|令牌|token|key)\s*[:=＝]?\s*["'`]?([A-Za-z0-9_\-.]{16,})["'`]?/i;
function detectKey(t) {
  for (const p of KEY_PATTERNS) {
    const m = String(t).match(p);
    if (m) return String(m[1] || m[0]).replace(/^Bearer\s+/i, "").replace(/[.,;]+$/, "");
  }
  const lm = String(t).match(KEY_LABEL);
  return lm ? lm[1] : "";
}
const detectUrl = (t) => {
  const m = String(t).match(/https?:\/\/[^\s"'`<>（）()【】，,、;；\]]+/i);
  return m ? m[0].replace(/[.,;:]+$/, "") : "";
};
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
function parseConnText(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 20000) return null;
  const jm = t.match(/\{[\s\S]{2,4000}?\}/);
  if (jm) {
    try {
      const j = JSON.parse(jm[0]);
      const baseUrl = j.baseUrl || j.base_url || j.url || j.endpoint || "";
      const apiKey = j.apiKey || j.api_key || j.key || j.token || j.secret || "";
      if (baseUrl) {
        const type = TYPES.some((x) => x.value === j.type) ? j.type : detectType(baseUrl, apiKey);
        return { name: j.name || hostName(baseUrl), type, baseUrl: normalizeBase(baseUrl, type), apiKey: String(apiKey).replace(/^Bearer\s+/i, "") };
      }
    } catch { /* 非 JSON */ }
  }
  const url = detectUrl(t);
  let key = detectKey(t);
  if (!key && url) { const q = url.match(/[?&]key=([A-Za-z0-9_\-.]{12,})/i); if (q) key = q[1]; }
  if (!url && !key) return null;
  const type = detectType(url, key);
  const cleanUrl = url.replace(/[?&](key|api_key|apiKey)=[^&]+/i, "");
  return { name: hostName(cleanUrl), type, baseUrl: cleanUrl ? normalizeBase(cleanUrl, type) : "", apiKey: key };
}

// ==================== 状态 ====================
const DEFAULT_SETTINGS = {
  concurrency: 2, timeoutSec: 120, maxTokens: 4096, retries: 2,
  svgMaxTokens: 8192, svgTemperature: 0.4, judgeMaxTokens: 2048,
  judgeOn: true, svgOn: true, judgeModel: "", theme: "auto", followLog: true,
  probeOn: true, numberfpMaxTokens: 2048, thinking: "off",
  qEnabled: {}, taskEnabled: {},
};
const S = {
  providers: [], settings: { ...DEFAULT_SETTINGS },
  runs: [], current: null, running: false, abort: null,
  tab: "monitor", status: "就绪", progress: "",
  timeline: [], gen: null,
  filter: { model: "", group: "", ok: "" },
  expanded: new Set(),
  runFilter: null,
  runCursor: null, doneIds: null,
  hist: { idx: -1, follow: true, sub: "gen" },   // 答题记录浏览器
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hhmmss = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));
const qById = (id) => QUESTIONS.find((q) => q.id === id);
const taskById = (id) => SVG_TASKS.find((t) => t.id === id);
const enabledQuestions = () => QUESTIONS.filter((q) => S.settings.qEnabled[q.id] !== false);
const enabledTasks = () => SVG_TASKS.filter((t) => S.settings.taskEnabled[t.id] !== false);
const currentRun = () => (S.runFilter ? S.runs.find((r) => r.ts === S.runFilter) : (S.runs[0] || S.current));
const selModels = (p) => (p.selModels && p.selModels.length ? p.selModels : (p.models || []).slice(0, 2));

// ==================== 主题 ====================
const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
const effTheme = () => {
  const t = S.settings.theme || "auto";
  return t === "light" || t === "dark" ? t : (mqDark.matches ? "dark" : "light");
};
function applyTheme() {
  document.documentElement.dataset.theme = effTheme();
  invoke("chrome", { data: effTheme() });
}
function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const cur = S.settings.theme || "auto";
  S.settings.theme = order[(order.indexOf(cur) + 1) % 3];
  storeSave("settings", S.settings);
  applyTheme();
}
mqDark.addEventListener("change", () => { if ((S.settings.theme || "auto") === "auto") applyTheme(); });

// ==================== 通用 UI ====================
function setStatus(t) { S.status = t; renderStatusBar(); }
function setProgress(t) { S.progress = t; renderStatusBar(); }
// 统一渲染：运行中且无更具体进度时显示「本阶段已耗时」秒表，避免长请求/超时等待期间界面像死了
function renderStatusBar() {
  const st = $("#statusText"); if (st) st.textContent = S.status;
  const pg = $("#progressText");
  if (!pg) return;
  if (S.progress) { pg.textContent = S.progress; return; }
  if (S.running && S.phaseT0) pg.textContent = `已耗时 ${Math.round((Date.now() - S.phaseT0) / 1000)}s`;
  else pg.textContent = "";
}
let toastSeq = 0;
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  const lines = String(msg ?? "").split("\n");
  lines.forEach((line, i) => {
    const span = document.createElement("span");
    span.className = i === 0 ? "t1" : "t2";
    span.textContent = line;
    el.appendChild(span);
  });
  el.id = "toast_" + (++toastSeq);
  $("#toasts").appendChild(el);
  const ttl = 3200 + Math.max(0, lines.length - 1) * 1200;
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, ttl);
  setTimeout(() => el.remove(), ttl + 400);
}
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
const hideModal = () => $("#modal").classList.add("hidden");

let _menuEl = null;
const closeMenu = () => { if (_menuEl) { _menuEl.remove(); _menuEl = null; } };
function openMenu(x, y, title, items) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "ctxmenu";
  el.innerHTML = (title ? `<div class="ctx-title">${esc(title)}</div>` : "") +
    items.filter(Boolean).map((it) => it.sep
      ? `<div class="ctx-sep"></div>`
      : `<button class="ctx-item ${it.kind || ""}" data-act="${esc(it.id || it.label)}" ${it.disabled ? "disabled" : ""}>${esc(it.label)}${it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ""}</button>`
    ).join("");
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
function menuAt(e, title, items) { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, title, items); }
const cp = (val, label) => ({ label: "复制" + (label || ""), fn: () => copyText(val, label || "") });

// ==================== 执行记录时间轴 ====================
function log(kind, text, sub, cls) {
  S.timeline.push({ t: Date.now(), kind, text, sub, cls: cls || "" });
  if (S.timeline.length > 600) S.timeline.splice(0, S.timeline.length - 600);
  renderTimeline();
}
function renderTimeline() {
  const el = $("#timeline");
  if (!el) return;
  if (!S.timeline.length) {
    el.innerHTML = `<div class="tl-empty">还没有执行记录<br>点右上角「开始检测」跑一轮</div>`;
    return;
  }
  el.innerHTML = S.timeline.map((e) => `
    <div class="tl-item ${e.cls || ""}">
      <div class="tl-head"><span class="tl-kind ${e.cls || ""}">${esc(e.kind)}</span><span class="tl-time">${hhmmss(e.t)}</span></div>
      <div class="tl-text">${esc(e.text)}</div>
      ${e.sub ? `<div class="tl-sub">${esc(e.sub)}</div>` : ""}
    </div>`).join("");
  if (S.settings.followLog && $("#followLog") && $("#followLog").checked) el.scrollTop = el.scrollHeight;
}

// ==================== 生成文件预览 ====================
function showGen(gen) { S.gen = gen; renderGen(); }
function renderGen() {
  const el = $("#genbox");
  if (!el) return;
  if (!S.gen) { el.innerHTML = `<div class="empty">模型生成 SVG 后，这里会自动预览（动画实时播放）</div>`; return; }
  const g = S.gen;
  if (g.kind === "iframe") {
    el.innerHTML = `<iframe sandbox="allow-scripts" srcdoc="${esc(g.html)}"></iframe>`;
  } else {
    el.innerHTML = `<img alt="${esc(g.title || "生成文件")}" src="${svgDataUrl(g.svg)}">`;
  }
}

// ==================== 答题记录浏览器（运行中可上下翻看） ====================
function histRows() {
  const run = currentRun();
  if (!run || !run.models) return [];
  const out = [];
  for (const m of run.models) {
    for (const r of m.q || []) out.push({ kind: "q", provider: m.provider, model: m.model, r });
    for (const r of m.svg || []) out.push({ kind: "svg", provider: m.provider, model: m.model, r });
    if (m.probes) out.push({ kind: "fp", provider: m.provider, model: m.model, r: m.probes });
  }
  return out;
}

function renderHist() {
  const box = $("#histbox");
  if (!box) return;
  const rows = histRows();
  if (!rows.length) {
    box.innerHTML = `<div class="hist-empty">还没有答题记录<br>点「开始检测」后这里会实时累积，可上下翻看</div>`;
    return;
  }
  const last = rows.length - 1;
  const idx = S.hist.follow ? last : Math.max(0, Math.min(S.hist.idx, last));
  S.hist.idx = idx;
  const cur = rows[idx];

  const head = `<div class="hist-pager">
    <button class="btn tiny" id="histPrev" ${idx <= 0 ? "disabled" : ""}>◀ 上一条</button>
    <span class="hist-count"><b>${idx + 1}</b> / ${rows.length}</span>
    <button class="btn tiny" id="histNext" ${idx >= last ? "disabled" : ""}>下一条 ▶</button>
    <span class="spacer"></span>
    <label class="chk tight" title="开启后自动跳到最新一条">
      <input type="checkbox" id="histFollow" ${S.hist.follow ? "checked" : ""}><span>跟随最新</span>
    </label>
    ${S.running ? `<span class="pill info">运行中</span>` : ""}
  </div>`;

  const r = cur.r;
  let chips = "", rowsHtml = "", raw = "";
  if (cur.kind === "q") {
    chips = `<span class="badge">${esc(cur.model)}</span>
      <span class="badge">${esc(r.qid)}</span>
      <span class="badge">${esc(r.type)}</span>
      <span class="pill ${r.ok ? "ok" : "bad"}">${r.ok ? "答对" : "答错"}</span>
      ${r.manual ? `<span class="pill mute">人工改判</span>` : ""}
      ${r.aiReview ? `<span class="pill info">AI 复核</span>` : ""}
      ${r.followup ? `<span class="pill warn">含补答</span>` : ""}`;
    rowsHtml = `
      <div class="hist-row"><span>期望答案</span><b>${esc(r.expected)}</b></div>
      <div class="hist-row"><span>模型答案</span><b>${esc(r.got || "—")}</b></div>
      <div class="hist-row"><span>判定方式</span><b>${esc(r.gradeHow || "—")}</b></div>
      <div class="hist-row"><span>延迟/Token</span><b>${r.latencyMs}ms · ${r.tokens ?? "—"}</b></div>
      <div class="hist-row"><span>时间</span><b>${hhmmss(r.t || Date.now())}</b></div>
      ${r.error ? `<div class="hist-row"><span>错误</span><b style="color:var(--danger)">${esc(r.error)}</b></div>` : ""}`;
    raw = r.raw || "（无原始输出）";
  } else if (cur.kind === "fp") {
    const fp = r;
    chips = `<span class="badge">${esc(cur.model)}</span>
      <span class="badge">指纹探针</span>
      <span class="pill ${fp.score >= 85 ? "ok" : fp.score >= 60 ? "warn" : "bad"}">真实性 ${fp.score} 分 · ${fp.verdict}</span>`;
    rowsHtml = fp.layers.map((l) => {
      const meta = PROBE_LAYERS.find((x) => x.key === l.key) || {};
      const cls = l.verdict === "通过" ? "var(--accent)" : l.verdict === "可疑" ? "var(--warn)" : "var(--danger)";
      return `<div class="hist-row"><span>${esc((meta.icon || "") + " " + (meta.title || l.key))}</span><b style="color:${cls}">${l.verdict}（异常 ${l.bad} / 可疑 ${l.warn} / 通过 ${l.ok}）</b></div>`;
    }).join("");
    const bads = fp.items.filter((x) => x.level === "bad" || x.level === "warn").slice(0, 6);
    raw = bads.length
      ? bads.map((x) => "【" + x.level.toUpperCase() + "】" + x.title + "\n" + x.evidence).join("\n\n")
      : "7 层探针全部通过，未发现套壳/降智证据。";
  } else {
    const j = r.judge;
    chips = `<span class="badge">${esc(cur.model)}</span>
      <span class="badge">SVG</span>
      <span class="badge">${esc(r.title || r.taskId)}</span>
      ${j ? `<span class="pill ${j.score >= 80 ? "ok" : j.score >= 60 ? "warn" : "bad"}">${j.score} 分</span><span class="stars">${starsText(j.stars)}</span>` : `<span class="pill mute">未评审</span>`}`;
    rowsHtml = `
      <div class="hist-row"><span>总评</span><b>${esc(j ? j.verdict : r.error || "—")}</b></div>
      <div class="hist-row"><span>动画</span><b>${r.motion == null ? "—" : (r.motion ? "有" : "无")} · ${(r.frames || []).length} 帧</b></div>
      <div class="hist-row"><span>延迟/Token</span><b>${r.latencyMs}ms · ${r.tokens ?? "—"}</b></div>
      <div class="hist-row"><span>裁判</span><b>${esc(r.judgeModel || "—")}</b></div>
      <div class="hist-row"><span>时间</span><b>${hhmmss(r.t || Date.now())}</b></div>`;
    raw = r.svg || r.raw || "（无 SVG）";
  }

  const list = rows.map((x, i) => {
    const rr = x.r;
    const ok = x.kind === "q" ? rr.ok : x.kind === "fp" ? rr.score >= 85 : !!(rr.judge && rr.judge.score >= 60);
    const label = x.kind === "q" ? `${rr.qid} ${rr.type}`
      : x.kind === "fp" ? `指纹 ${rr.verdict} ${rr.score}分` : `SVG ${rr.title || rr.taskId}`;
    return `<div class="hist-item ${i === idx ? "active" : ""}" data-hi="${i}">
      <span class="mk" style="color:${ok ? "var(--accent)" : "var(--danger)"}">${ok ? "✓" : "✕"}</span>
      <span class="hi-id">${esc(x.kind === "q" ? rr.qid : x.kind === "fp" ? "FP" : "SVG")}</span>
      <span class="hi-model">${esc(x.model)} · ${esc(label)}</span>
      <span class="sub">${x.kind === "fp" ? (rr.durationMs ? (rr.durationMs / 1000).toFixed(1) + "s" : "") : (rr.latencyMs ?? "") + "ms"}</span>
    </div>`;
  }).join("");

  box.innerHTML = head +
    `<div class="hist-detail">
      <div class="hist-meta">${chips}</div>
      <div class="hist-rows">${rowsHtml}</div>
      <pre>${esc(raw)}</pre>
    </div>
    <div class="hist-list" id="histList">${list}</div>`;

  $("#histPrev")?.addEventListener("click", () => histStep(-1));
  $("#histNext")?.addEventListener("click", () => histStep(1));
  $("#histFollow")?.addEventListener("change", (e) => {
    S.hist.follow = e.target.checked;
    if (S.hist.follow) S.hist.idx = histRows().length - 1;
    renderHist();
  });
  box.querySelectorAll("[data-hi]").forEach((el) => el.addEventListener("click", () => {
    S.hist.follow = false;
    S.hist.idx = Number(el.dataset.hi);
    renderHist();
  }));
  const active = box.querySelector(".hist-item.active");
  if (active && S.hist.follow) active.scrollIntoView({ block: "nearest" });
}

function histStep(delta) {
  const rows = histRows();
  if (!rows.length) return;
  const last = rows.length - 1;
  let idx = S.hist.follow ? last : Math.max(0, Math.min(S.hist.idx, last));
  idx = Math.max(0, Math.min(idx + delta, last));
  S.hist.follow = false;
  S.hist.idx = idx;
  renderHist();
}

function setHistSub(sub) {
  S.hist.sub = sub === "hist" ? "hist" : "gen";
  document.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("active", b.dataset.sub === S.hist.sub));
  const gen = $("#genbox"), hist = $("#histbox");
  if (gen) gen.classList.toggle("hidden", S.hist.sub !== "gen");
  if (hist) hist.classList.toggle("hidden", S.hist.sub !== "hist");
  const hint = $("#genHint");
  if (hint) hint.textContent = S.hist.sub === "hist" ? "← → 可上下翻看" : "模型写入后自动预览";
  if (S.hist.sub === "hist") renderHist();
}

// ==================== 帧捕获（canvas） ====================
async function captureFrames(svg, times = [400, 1500, 3000], size = 360) {
  const url = svgDataUrl(ensureSvgSize(svg));
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:480px;overflow:hidden;pointer-events:none;";
  const img = new Image();
  img.width = 480; img.height = 480;
  holder.appendChild(img);
  document.body.appendChild(holder);
  try {
    await new Promise((res, rej) => {
      img.onload = () => res(true);
      img.onerror = () => rej(new Error("SVG 无法渲染"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const w = img.naturalWidth || 400, h = img.naturalHeight || 400;
    const scale = Math.min(1, size / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const frames = [];
    const t0 = performance.now();
    for (const t of times) {
      const wait = t - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch { /* 绘制失败保留白底 */ }
      frames.push(canvas.toDataURL("image/png"));
    }
    const motion = new Set(frames).size > 1;
    return { frames, motion };
  } finally {
    holder.remove();
  }
}

// ==================== 端点渲染 ====================
function renderProviders() {
  const el = $("#providers");
  if (!el) return;
  if (!S.providers.length) {
    el.innerHTML = `<div class="empty-sm">暂无端点 · 点「+ 添加」或粘贴连接信息</div>`;
    return;
  }
  el.innerHTML = S.providers.map((p) => {
    const testing = S.runCursor && S.runCursor.id === p.id;
    const done = S.doneIds && S.doneIds.has(p.id);
    const cls = ["prov", p.enabled === false ? "off" : "", testing ? "testing" : "", done && !testing ? "done" : ""].filter(Boolean).join(" ");
    const n = selModels(p).length;
    return `<div class="${cls}" data-id="${p.id}" title="左键编辑 · 右键更多">
      <div class="prov-top">
        <span class="lamp ${testing ? "busy" : done ? "ok" : ""}"></span>
        <span class="prov-name">${esc(p.name || "(未命名)")}</span>
      </div>
      <div class="prov-meta">${esc(p.baseUrl || "")}</div>
      <div class="prov-row">
        <span class="badge">${TYPE_LABEL[p.type] || p.type}</span>
        <span class="badge">${p.models && p.models.length ? p.models.length + " 模型" : "未拉取"}</span>
        <span class="badge">${n ? "测 " + n + " 个" : "未选模型"}</span>
      </div>
      ${testing && S.runCursor.phase ? `<div class="prov-phase">${esc(S.runCursor.phase)}</div>` : ""}
    </div>`;
  }).join("");
  el.querySelectorAll(".prov").forEach((node) => {
    node.addEventListener("click", () => editProvider(node.dataset.id));
    node.addEventListener("contextmenu", (e) => providerMenu(node.dataset.id, e));
  });
}
function markTesting(id, phase) { S.runCursor = id ? { id, phase: phase || "检测中" } : null; renderProviders(); }
function setPhase(phase) {
  S.phaseT0 = Date.now();
  if (!S.runCursor) return;
  S.runCursor.phase = phase;
  const node = document.querySelector(`.prov[data-id="${S.runCursor.id}"] .prov-phase`);
  if (node) node.textContent = phase; else renderProviders();
}
function markDone(id) {
  if (!S.doneIds) S.doneIds = new Set();
  if (id) S.doneIds.add(id);
  if (S.runCursor && S.runCursor.id === id) S.runCursor = null;
  renderProviders();
}

// ==================== 题库侧栏 ====================
function renderQList() {
  const el = $("#qList");
  if (!el) return;
  el.innerHTML = QUESTIONS.map((q) => `
    <label title="${esc(q.type)} · 参考难度 ${q.level}/5">
      <input type="checkbox" data-q="${q.id}" ${S.settings.qEnabled[q.id] !== false ? "checked" : ""}>
      <span class="qno">${q.no}.</span><span>${esc(q.type)}</span>
    </label>`).join("");
  el.querySelectorAll("input[data-q]").forEach((cb) => {
    cb.addEventListener("change", () => {
      S.settings.qEnabled[cb.dataset.q] = cb.checked;
      storeSave("settings", S.settings);
      renderBankCount();
    });
  });
  renderBankCount();
}
function renderBankCount() {
  const el = $("#bankCount");
  if (el) el.textContent = `${enabledQuestions().length}/${QUESTIONS.length} 题 · SVG ${enabledTasks().length}/${SVG_TASKS.length}`;
}

// ==================== 裁判模型下拉 ====================
function renderJudgeSelect() {
  const el = $("#cfgJudgeModel");
  if (!el) return;
  const opts = [`<option value="">跟随被测模型</option>`];
  for (const p of S.providers) {
    for (const m of p.models || []) {
      const val = p.id + "::" + m;
      opts.push(`<option value="${esc(val)}" ${S.settings.judgeModel === val ? "selected" : ""}>${esc(p.name + " · " + m)}</option>`);
    }
  }
  el.innerHTML = opts.join("");
  const lbl = $("#judgeLabel");
  if (lbl) lbl.textContent = S.settings.judgeModel ? "指定裁判" : "跟随被测模型";
}
function resolveJudge(testedP, testedModel) {
  const v = S.settings.judgeModel;
  if (!v) return { p: testedP, model: testedModel };
  const parts = v.split("::");
  const pid = parts[0];
  const p = S.providers.find((x) => x.id === pid);
  return p ? { p, model: parts.slice(1).join("::") } : { p: testedP, model: testedModel };
}

let _tickTimer = null;
function startTick() { stopTick(); _tickTimer = setInterval(() => { if (S.running) renderStatusBar(); }, 1000); }
function stopTick() { if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; } }

// ==================== 检测编排 ====================
function cfgOf() {
  const s = S.settings;
  return {
    maxTokens: s.maxTokens, temperature: 0, retries: s.retries, thinking: s.thinking || "off",
    svgMaxTokens: s.svgMaxTokens, svgTemperature: s.svgTemperature,
    judgeMaxTokens: s.judgeMaxTokens, rlRetries: 6, rlBaseSec: 5, rlCapSec: 120,
    maxTokensCeiling: Math.max(s.maxTokens * 2, 8192),
    timeoutMs: s.timeoutSec * 1000,
  };
}

async function runAll() {
  if (S.running) return;
  const targets = S.providers.filter((p) => p.enabled !== false && selModels(p).length);
  if (!targets.length) { toast("没有可测的端点/模型：先添加端点并「拉模型」勾选模型", "bad"); return; }
  const qs = enabledQuestions();
  const tasks = S.settings.svgOn ? enabledTasks() : [];
  const probeOn = !!S.settings.probeOn;
  if (!qs.length && !tasks.length && !probeOn) { toast("没有勾选任何测试项", "bad"); return; }
  const judgeOn = S.settings.judgeOn && tasks.length > 0;

  S.timeline = [];
  S.current = { ts: Date.now(), providerCount: targets.length, models: [] };
  S.abort = new AbortController();
  S.doneIds = new Set();
  S.running = true;
  S.phaseT0 = Date.now();
  startTick();
  $("#btnRun").disabled = true;
  $("#btnStop").disabled = false;
  log("开始", `检测开始 · 端点 ${targets.length} · 学科题 ${qs.length} · SVG 题 ${tasks.length}${probeOn ? " · 指纹探针 " + PROBE_ITEMS.length + " 项" : ""}`,
    [judgeOn ? "视觉裁判已启用" : (tasks.length ? "未启用裁判（仅生成）" : ""), probeOn ? "指纹鉴定已启用" : ""].filter(Boolean).join(" · ") || "仅学科题", "run");

  const cfg = cfgOf();
  const signal = S.abort.signal;
  const shouldStop = () => !S.running || signal.aborted;
  let qTotal = 0, qCorrect = 0, svgCount = 0, probeCount = 0;

  try {
    for (const p of targets) {
      if (shouldStop()) break;
      const models = selModels(p);
      markTesting(p.id, "准备中");
      log("端点", `${p.name} · ${models.length} 个模型`, p.baseUrl, "info");

      for (const model of models) {
        if (shouldStop()) break;
        const entry = { provider: p.name, model, type: p.type, q: [], svg: [] };
        S.current.models.push(entry);
        setPhase(`${model} · 学科题`);

        if (qs.length) {
          log("答题", `${model} · 开始 ${qs.length} 道学科题`, `并发 ${S.settings.concurrency}`, "info");
          const done = { n: 0 };
          const rows = await runPool(qs, S.settings.concurrency, async (q) => {
            if (shouldStop()) return null;
            const row = await opAskQuestion(p, model, q, cfg, {
              signal,
              onNote: (m) => log("重试", `${model} · ${q.id}：${m}`, "", "warn"),
            });
            if (!row) return null;
            done.n++;
            setProgress(`${model} · 学科题 ${done.n}/${qs.length}`);
            qTotal++; if (row.ok) qCorrect++;
            entry.q.push(row);            // 实时进答题记录，运行中即可翻看
            renderHist();
            log(row.ok ? "答对" : "答错",
              `${model} · ${q.id} ${q.type}`,
              `${row.ok ? "命中" : (row.got ? "答：" + String(row.got).slice(0, 60) : (row.error || "无答案"))} · ${row.latencyMs}ms`,
              row.ok ? "ok" : "bad");
            return row;
          }, shouldStop);
          entry.q.sort((a, b) => a.no - b.no);
          const ok = entry.q.filter((r) => r.ok).length;
          log("小结", `${model} · 学科题 ${ok}/${entry.q.length}`,
            `正确率 ${entry.q.length ? Math.round((ok / entry.q.length) * 100) : 0}%`,
            ok === entry.q.length ? "ok" : (ok === 0 ? "bad" : "warn"));
        }

        for (const task of tasks) {
          if (shouldStop()) break;
          setPhase(`${model} · ${task.title}`);
          log("画图", `${model} · ${task.title}`, "生成 SVG 中…", "info");
          const row = await opGenSvg(p, model, task, cfg, {
            signal, onNote: (m) => log("重试", `${model} · ${task.title}：${m}`, "", "warn"),
          });
          if (shouldStop()) break;
          svgCount++;
          if (!row.ok) {
            log("画图失败", `${model} · ${task.title}`, row.error || "生成失败", "bad");
            entry.svg.push(row);
            continue;
          }
          showGen({ kind: "img", svg: row.svg, title: `${model} · ${task.title}` });
          let frames = [], motion = null;
          try {
            const cap = await captureFrames(row.svg);
            frames = cap.frames; motion = cap.motion;
            row.frames = frames; row.motion = motion;
          } catch (e) {
            log("渲染告警", `${model} · ${task.title}`, "SVG 无法渲染成帧：" + e.message, "warn");
          }
          log("画图完成", `${model} · ${task.title}`,
            `${row.svg.length} 字节 · ${frames.length} 帧 · 动画${motion ? "有" : "无"} · ${row.latencyMs}ms`, "ok");

          if (judgeOn && frames.length) {
            const j = resolveJudge(p, model);
            setPhase(`${model} · ${task.title} · 裁判`);
            log("裁判", `${task.title} · 由 ${j.model} 评审`, "上传帧 + 源码…", "info");
            const jr = await opJudgeSvg(j.p, j.model, task, { candidateFrames: frames, svg: row.svg, motion }, cfg, { signal });
            row.judge = jr.judge || null;
            row.judgeRaw = jr.raw || "";
            row.judgeModel = j.model;
            row.judgeError = jr.error || "";
            if (jr.ok) {
              log("裁判结论", `${task.title} · ${jr.judge.score} 分 ${starsText(jr.judge.stars)}`,
                jr.judge.verdict || "", jr.judge.score >= 60 ? "ok" : "warn");
            } else {
              log("裁判失败", `${task.title}`, jr.error || "失败", "bad");
            }
          }
          entry.svg.push(row);
          renderHist();
        }

        // ---- 指纹探针 ----
        if (probeOn && !shouldStop()) {
          setPhase(`${model} · 指纹探针`);
          log("指纹", `${model} · 开始 ${PROBE_ITEMS.length} 项探针`, `${PROBE_LAYERS.length} 层检测 · 数值指纹库 18 候选`, "info");
          const fp = await opRunProbes(p, model, cfg, {
            signal,
            onProbe: (item, stage, row) => {
              if (stage === "start") { setProgress(`${model} · ${item.title}`); setPhase(`${model} · ${item.title}`); }
              else if (stage === "done" && row) {
                log(row.level === "bad" ? "探针异常" : row.level === "warn" ? "探针可疑" : "探针通过",
                  `${model} · ${row.title}`, String(row.evidence).slice(0, 120),
                  row.level === "bad" ? "bad" : row.level === "warn" ? "warn" : row.level === "ok" ? "ok" : "info");
              }
            },
          });
          if (!shouldStop()) {
            entry.probes = fp;
            probeCount++;
            renderHist();
            log("指纹结论", `${model} · 真实性 ${fp.score} 分（${fp.verdict}）`,
              fp.layers.map((l) => `${(PROBE_LAYERS.find((x) => x.key === l.key) || {}).title || l.key}:${l.verdict}`).join(" · "),
              fp.score >= 85 ? "ok" : fp.score >= 60 ? "warn" : "bad");
          }
        }
        markDone(p.id);
      }
    }
  } catch (e) {
    log("异常", "检测中断：" + ((e && e.message) || e), "", "bad");
  }

  S.running = false;
  stopTick();
  S.phaseT0 = 0;
  renderStatusBar();
  S.runCursor = null;
  S.doneIds = null;
  $("#btnRun").disabled = false;
  $("#btnStop").disabled = true;
  setProgress("");
  renderProviders();

  const interrupted = S.abort && S.abort.signal.aborted;
  const run = S.current;
  S.current = null;
  run.durationMs = Date.now() - run.ts;
  run.interrupted = !!interrupted;
  run.judgeOn = judgeOn;
  run.qCount = qTotal; run.qCorrect = qCorrect; run.svgCount = svgCount; run.probeCount = probeCount;
  S.runs.unshift(run);
  if (S.runs.length > 20) S.runs.length = 20;
  await storeSave("runs", slimForStore(S.runs));
  S.runFilter = null;
  renderAll();

  const st = runStats(run);
  const rate = st.qRate == null ? "—" : st.qRate + "%";
  setStatus(`${interrupted ? "已停止" : "完成"} · 学科题 ${st.qCorrect}/${st.qTotal}（${rate}）· SVG ${st.svgTotal} 张 · ${(run.durationMs / 1000).toFixed(1)}s`);
  log(interrupted ? "已停止" : "完成",
    `学科题 ${st.qCorrect}/${st.qTotal} · SVG ${st.svgTotal} 张`,
    `${(run.durationMs / 1000).toFixed(1)}s`, interrupted ? "warn" : "ok");
  toast(`检测${interrupted ? "已停止" : "完成"}：学科题 ${st.qCorrect}/${st.qTotal}${st.svgTotal ? ` · SVG ${st.svgTotal} 张` : ""}`,
    interrupted ? "warn" : (st.qTotal && st.qCorrect === st.qTotal ? "ok" : "bad"));
}

function stopRun() {
  if (!S.running) return;
  S.running = false;
  try { S.abort.abort(); } catch { /* noop */ }
  setStatus("正在停止…");
}

// ==================== 指纹鉴定 ====================
const LEVEL_MARK = { ok: ["✓", "var(--accent)"], info: ["•", "var(--muted)"], warn: ["!", "var(--warn)"], bad: ["✕", "var(--danger)"] };

function renderForensics() {
  const el = $("#view-forensics");
  if (!el) return;
  const run = currentRun();
  const models = ((run && run.models) || []).filter((m) => m.probes);
  if (!models.length) {
    el.innerHTML = `<div class="empty">
      还没有指纹鉴定结果<br>
      <span class="sub">在左侧勾选「运行指纹探针」，点「开始检测」后会跑 ${PROBE_ITEMS.length} 项探针（${PROBE_LAYERS.length} 层）</span>
      <div style="margin-top:12px"><span class="sub">数值指纹库：18 个候选模型 / 2 个家族（ModelTrace, MIT）</span></div>
    </div>`;
    return;
  }
  el.innerHTML = models.map((m, mi) => {
    const fp = m.probes;
    const layers = PROBE_LAYERS.map((L) => {
      const sum = fp.layers.find((x) => x.key === L.key) || {};
      const items = (fp.items || []).filter((x) => x.layer === L.key);
      const cls = sum.verdict === "通过" ? "ok" : sum.verdict === "可疑" ? "warn" : "bad";
      return `<section class="fp-layer">
        <header class="fp-layer-head">
          <span class="fp-ico">${L.icon}</span>
          <div class="fp-layer-title"><b>${L.no}. ${esc(L.title)}</b><span class="sub">${esc(L.en)}</span></div>
          <span class="pill ${cls}">${esc(sum.verdict || "未测")}</span>
          <span class="sub">${sum.bad || 0} 异常 · ${sum.warn || 0} 可疑 · ${sum.ok || 0} 通过</span>
        </header>
        <div class="fp-why">
          <div><b>检测原理</b>${L.principle.map((x) => `<div class="fp-li">· ${esc(x)}</div>`).join("")}</div>
          <div><b>检测目的</b><div class="fp-li">${esc(L.purpose)}</div></div>
        </div>
        <div class="fp-items">
          ${items.map((it) => {
            const mk2 = LEVEL_MARK[it.level] || LEVEL_MARK.info;
            return `<div class="fp-item">
              <span class="fp-mark" style="color:${mk2[1]}">${mk2[0]}</span>
              <div class="fp-item-body">
                <div class="fp-item-title">${esc(it.title)}<span class="sub">${esc(it.note || "")}</span></div>
                <div class="fp-item-ev">${esc(it.evidence)}</div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </section>`;
    }).join("");
    return `<div class="fp-card" data-mi="${mi}">
      <header class="fp-card-head">
        <div>
          <div class="card-name">${esc(m.model)}</div>
          <div class="sub">${esc(m.provider)} · ${PROBE_ITEMS.length} 项探针 · ${((fp.durationMs || 0) / 1000).toFixed(1)}s</div>
        </div>
        <span class="pill ${fp.score >= 85 ? "ok" : fp.score >= 60 ? "warn" : "bad"}">真实性 ${fp.score} 分 · ${esc(fp.verdict)}</span>
        <button class="btn tiny" data-refp="${mi}">重跑指纹</button>
      </header>
      ${layers}
    </div>`;
  }).join("");
  el.querySelectorAll("[data-refp]").forEach((b) => b.addEventListener("click", async () => {
    const m = models[Number(b.dataset.refp)];
    const pp = S.providers.find((x) => x.name === m.provider) || S.providers[0];
    if (!pp) { toast("端点已不存在", "bad"); return; }
    b.disabled = true;
    b.textContent = "鉴定中…";
    log("指纹", `${m.model} · 重跑 ${PROBE_ITEMS.length} 项探针`, `${PROBE_LAYERS.length} 层检测`, "info");
    const fp2 = await opRunProbes(pp, m.model, cfgOf(), {
      onProbe: (item, stage) => { if (stage === "start") setProgress(`${m.model} · ${item.title}`); },
    });
    m.probes = fp2;
    await persistRuns();
    setProgress("");
    renderForensics();
    renderHist();
    log("指纹结论", `${m.model} · 真实性 ${fp2.score} 分（${fp2.verdict}）`,
      fp2.layers.map((l) => `${l.key}:${l.verdict}`).join(" "), fp2.score >= 85 ? "ok" : fp2.score >= 60 ? "warn" : "bad");
    toast(`${m.model} 指纹：${fp2.score} 分（${fp2.verdict}）`, fp2.score >= 85 ? "ok" : fp2.score >= 60 ? "warn" : "bad");
  }));
}

// ==================== 成绩单 ====================
const scoreClass = (rate) => (rate == null ? "" : rate >= 80 ? "good" : rate >= 50 ? "mid" : "bad");

function renderResults() {
  const el = $("#view-results");
  if (!el) return;
  const run = currentRun();
  if (!run || !run.models || !run.models.length) {
    el.innerHTML = `<div class="empty">还没有成绩 · 点右上角「开始检测」跑一轮</div>`;
    return;
  }
  const models = run.models.slice().sort((a, b) => (modelStats(b).qRate ?? -1) - (modelStats(a).qRate ?? -1));
  const cards = models.map((m) => {
    const st = modelStats(m);
    const gs = groupStats(m.q || []);
    return `<div class="card">
      <div class="card-head">
        <div><div class="card-name">${esc(m.model)}</div><div class="sub">${esc(m.provider)}</div></div>
        <span class="pill ${st.qRate == null ? "mute" : st.qRate >= 80 ? "ok" : st.qRate >= 50 ? "warn" : "bad"}">${st.qRate == null ? "未测" : st.qRate + "%"}</span>
      </div>
      <div class="score-wrap">
        <span class="score ${scoreClass(st.qRate)}">${st.qRate == null ? "—" : st.qRate}</span>
        <span class="score-unit">IQ 分 · ${st.qCorrect}/${st.qTotal} 题</span>
      </div>
      ${gs.map((g) => `<div class="card-row"><span>${esc(g.label)}</span><b>${g.ok}/${g.total}</b></div>
        <div class="bar"><i style="width:${g.rate ?? 0}%"></i></div>`).join("")}
      <div class="card-row" style="margin-top:8px"><span>SVG 动画</span><b>${st.svgJudged ? starsText(Math.round(st.svgAvgStars)) + " " + st.svgAvgStars + "★" : (st.svgTotal ? st.svgTotal + " 张（未评审）" : "—")}</b></div>
      <div class="card-row"><span>平均延迟</span><b>${st.avgLatencyMs == null ? "—" : st.avgLatencyMs + "ms"}</b></div>
      <div class="card-row"><span>Tokens</span><b>${st.tokens || 0}</b></div>
    </div>`;
  }).join("");

  const chart = barChart(models.map((m) => ({ label: m.model, value: modelStats(m).qRate ?? 0 })), { title: "学科题正确率对比", unit: "%", max: 100 });

  const rows = [];
  for (const m of models) {
    for (const r of m.q || []) {
      if (S.filter.model && m.model !== S.filter.model) continue;
      if (S.filter.group && r.group !== S.filter.group) continue;
      if (S.filter.ok === "ok" && !r.ok) continue;
      if (S.filter.ok === "fail" && r.ok) continue;
      rows.push({ m, r });
    }
  }
  const table = rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>模型</th><th>题号</th><th>题型</th><th>结果</th><th class="wrap">期望答案</th><th class="wrap">模型答案</th><th>延迟</th><th>Tokens</th></tr></thead>
    <tbody>${rows.map(({ m, r }, i) => {
      const key = m.provider + "|" + m.model + "|" + r.qid;
      const open = S.expanded.has(key);
      return `<tr data-key="${esc(key)}" data-i="${i}" title="点击展开 · 右键：复核 / 重测 / 复制">
        <td>${esc(m.model)}</td>
        <td class="num-cell">${r.qid}</td>
        <td>${esc(r.type)}</td>
        <td><span class="pill ${r.ok ? "ok" : "bad"}">${r.ok ? "答对" : "答错"}</span>${r.manual ? `<span class="sub"> 人工</span>` : r.aiReview ? `<span class="sub"> AI复核</span>` : ""}</td>
        <td class="wrap">${esc(r.expected)}</td>
        <td class="wrap">${esc(String(r.got || "").slice(0, 60))}</td>
        <td class="num-cell">${r.latencyMs}ms</td>
        <td class="num-cell">${r.tokens ?? "—"}</td>
      </tr>
      ${open ? `<tr class="detail-row"><td colspan="8"><div class="detail-box">
        <div class="sub">判定方式：${esc(r.gradeHow || "—")}${r.followup ? " · 含补答" : ""}${r.error ? " · " + esc(r.error) : ""}</div>
        <pre>${esc(r.raw || "（无原始输出）")}</pre>
      </div></td></tr>` : ""}`;
    }).join("")}</tbody>
  </table></div>` : `<div class="empty">没有匹配的记录</div>`;

  const chips = `<div class="chips">
    <button class="chip ${!S.filter.model ? "active" : ""}" data-f="model" data-v="">全部模型</button>
    ${models.map((m) => `<button class="chip ${S.filter.model === m.model ? "active" : ""}" data-f="model" data-v="${esc(m.model)}">${esc(m.model)}</button>`).join("")}
    <span class="spacer"></span>
    <button class="chip ${S.filter.ok === "ok" ? "active" : ""}" data-f="ok" data-v="ok">只看答对</button>
    <button class="chip ${S.filter.ok === "fail" ? "active" : ""}" data-f="ok" data-v="fail">只看答错</button>
    <button class="chip" data-f="report">导出报告 CSV</button>
    <button class="chip" data-f="share">生成分享报告</button>
  </div>`;

  el.innerHTML = `<div class="cards">${cards}</div>${chart}${chips}${table}`;

  el.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => {
    const f = b.dataset.f;
    if (f === "report") return exportCsv();
    if (f === "share") return shareModal();
    if (f === "model") S.filter.model = b.dataset.v || "";
    if (f === "ok") S.filter.ok = S.filter.ok === b.dataset.v ? "" : b.dataset.v;
    renderResults();
  }));
  el.querySelectorAll("tbody tr[data-key]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const k = tr.dataset.key;
      if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k);
      renderResults();
    });
    tr.addEventListener("contextmenu", (e) => {
      const pair = rows[Number(tr.dataset.i)];
      if (pair) questionRowMenu(pair.m, pair.r, e);
    });
  });
}

function questionRowMenu(m, r, e) {
  const q = qById(r.qid);
  menuAt(e, `${r.qid} · ${r.type}`, [
    { label: "复制模型答案", fn: () => copyText(r.raw || r.got || "", r.qid) },
    cp(r.expected, "标准答案"),
    cp(q ? q.prompt : "", "题目"),
    { sep: true },
    { label: "AI 复核此题", hint: "用裁判模型判等价", fn: () => aiReview(m, r) },
    { label: "重测此题", fn: () => retest(m, r) },
    { sep: true },
    { label: r.ok ? "人工改判为「答错」" : "人工改判为「答对」", fn: () => manualToggle(m, r) },
  ]);
}

async function manualToggle(m, r) {
  r.ok = !r.ok;
  r.manual = true;
  await persistRuns();
  renderAll();
  toast(`${r.qid} 已人工改判为「${r.ok ? "答对" : "答错"}」`, "ok");
}

async function aiReview(m, r) {
  const q = qById(r.qid);
  const prov = S.providers.find((p) => p.name === m.provider) || S.providers[0];
  const j = resolveJudge(prov, m.model);
  if (!j || !j.p) { toast("先配置端点", "bad"); return; }
  log("AI复核", `${r.qid} · 由 ${j.model} 判定`, "对比标准答案…", "info");
  const res = await opJudgeAnswer(j.p, j.model, q, r.raw || r.got, cfgOf(), {});
  if (!res.ok) { toast("复核失败：" + res.error, "bad"); return; }
  r.ok = res.correct;
  r.aiReview = res.reason || "AI 复核";
  r.manual = false;
  await persistRuns();
  renderAll();
  log("AI复核", `${r.qid} → ${res.correct ? "等价（答对）" : "不等价（答错）"}`, res.reason || "", res.correct ? "ok" : "bad");
  toast(`${r.qid} AI 复核：${res.correct ? "答对" : "答错"}\n${res.reason || ""}`, res.correct ? "ok" : "bad");
}

async function retest(m, r) {
  const q = qById(r.qid);
  const p = S.providers.find((x) => x.name === m.provider) || S.providers[0];
  if (!p) { toast("端点已不存在", "bad"); return; }
  toast(`重测 ${r.qid}…`, "ok");
  log("重测", `${m.model} · ${r.qid}`, "重新请求…", "info");
  const row = await opAskQuestion(p, m.model, q, cfgOf(), {});
  Object.assign(r, row);
  await persistRuns();
  renderAll();
  log(row.ok ? "重测答对" : "重测答错", `${m.model} · ${r.qid}`, row.got || row.error || "", row.ok ? "ok" : "bad");
}

// 落盘前剥掉「可重算的派生数据」：SVG 截帧（base64 PNG，每帧上百 KB）
// 与原始长文本。它们能从 svg / 重新请求得到，留在 runs.json 里会让文件膨胀到 MB 级，
// 每次启动解析都会卡死界面。
function slimForStore(runs) {
  return (runs || []).map((run) => ({
    ...run,
    models: (run.models || []).map((m) => ({
      ...m,
      q: (m.q || []).map((r) => ({ ...r, raw: (r.raw || "").slice(0, 600), content: undefined })),
      svg: (m.svg || []).map((r) => ({ ...r, frames: undefined, raw: (r.raw || "").slice(0, 2000) })),
      probes: m.probes ? {
        ...m.probes,
        items: (m.probes.items || []).map((it) => ({ ...it, detail: undefined })),
      } : undefined,
    })),
  }));
}
async function persistRuns() { await storeSave("runs", slimForStore(S.runs)); }

function barChart(items, { title, unit = "", max = null } = {}) {
  if (!items.length) return "";
  const m = max || Math.max(1, ...items.map((x) => x.value || 0));
  const rowH = 26, padL = 150, padR = 54, w = 720;
  const h = items.length * rowH + 16;
  const bars = items.map((x, i) => {
    const y = i * rowH + 8;
    const bw = Math.max(2, (w - padL - padR) * ((x.value || 0) / m));
    return `<text x="0" y="${y + 13}" fill="var(--text2)" font-size="11">${esc(String(x.label).slice(0, 26))}</text>
      <rect x="${padL}" y="${y + 3}" width="${w - padL - padR}" height="12" rx="6" fill="var(--bg2)"/>
      <rect x="${padL}" y="${y + 3}" width="${bw}" height="12" rx="6" fill="${x.color || "var(--accent)"}"/>
      <text x="${padL + bw + 8}" y="${y + 13}" fill="var(--text)" font-size="11">${x.value}${unit}</text>`;
  }).join("");
  return `<div class="chart-card" style="margin-top:12px"><div class="chart-title">${esc(title || "")}</div>
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${esc(title || "图表")}">${bars}</svg></div>`;
}

// ==================== SVG 画廊 ====================
function renderGallery() {
  const el = $("#view-gallery");
  if (!el) return;
  const run = currentRun();
  if (!run || !run.models || !run.models.length) { el.innerHTML = `<div class="empty">还没有 SVG 作品</div>`; return; }
  const items = [];
  for (const m of run.models) for (const r of m.svg || []) items.push({ m, r });
  if (!items.length) {
    el.innerHTML = `<div class="empty">本轮没有 SVG 题（在左侧勾选「测试 SVG 动画题」）</div>`;
    return;
  }
  el.innerHTML = `<div class="gallery">${items.map(({ m, r }, i) => {
    const task = taskById(r.taskId) || { title: r.title || r.taskId, criteria: [] };
    const j = r.judge;
    return `<div class="gcard" data-i="${i}">
      <div class="gcard-head">
        <span class="gcard-title">${esc(task.title)}</span>
        <span class="badge">${esc(m.model)}</span>
        ${j ? `<span class="pill ${j.score >= 80 ? "ok" : j.score >= 60 ? "warn" : "bad"}">${j.score} 分</span><span class="stars">${starsText(j.stars)}</span>`
            : (r.svg ? `<span class="pill mute">未评审</span>` : `<span class="pill bad">生成失败</span>`)}
        <span class="spacer"></span>
        <span class="sub">${r.latencyMs}ms · ${r.tokens ?? "—"} tok${r.motion != null ? " · 动画" + (r.motion ? "有" : "无") : ""}${r.judgeModel ? " · 裁判 " + esc(r.judgeModel) : ""}</span>
      </div>
      <div class="gcard-body">
        <div class="pane"><div class="pane-label"><span>模型作品</span><span>${r.svg ? (r.svg.length < 1024 ? r.svg.length + " B" : (r.svg.length / 1024).toFixed(1) + " KB") : ""}</span></div>
          <div class="svgbox">${r.svg ? `<img alt="${esc(task.title)}" src="${svgDataUrl(r.svg)}">` : `<span class="sub">${esc(r.error || "无输出")}</span>`}</div></div>
        <div class="pane"><div class="pane-label"><span>评分维度</span><span>${j ? "已评审" : "未评审"}</span></div>
          <div class="svgbox" style="align-items:flex-start;display:block;overflow:auto">
            ${(task.criteria || []).map((c, ci) => {
              const jc = (j && j.criteria) || [];
              // 先按名字匹配，名字对不上再按序号兜底（裁判常改维度名）
              const cc = jc.find((x) => x.name === c || (x.name && (c.includes(x.name) || x.name.includes(c.slice(0, 6)))))
                || (jc.length === (task.criteria || []).length ? jc[ci] : null);
              return `<div class="crit ${cc ? (cc.pass ? "pass" : "fail") : ""}"><span class="mk">${cc ? (cc.pass ? "✓" : "✕") : "•"}</span><span>${esc(c)}${cc && cc.comment ? `<span class="sub"> — ${esc(cc.comment)}</span>` : ""}</span></div>`;
            }).join("")}
            ${j && j.verdict ? `<div class="sub" style="margin-top:6px">总评：${esc(j.verdict)}</div>` : ""}
            ${j && j.problems && j.problems.length ? `<div class="sub">问题：${esc(j.problems.join("；"))}</div>` : ""}
          </div></div>
      </div>
      ${r.frames && r.frames.length ? `<div class="frames">${r.frames.map((f, k) => `<img data-frame="${i}:${k}" alt="帧${k + 1}" src="${f}">`).join("")}</div>` : ""}
      <div class="gcard-foot">
        <button class="btn tiny" data-act="preview" ${r.svg ? "" : "disabled"}>预览到大屏</button>
        <button class="btn tiny" data-act="judge" ${r.svg ? "" : "disabled"}>${j ? "重新裁判" : "发起裁判"}</button>
        <button class="btn tiny" data-act="sandbox" ${r.svg && /<script/i.test(r.svg) ? "" : "disabled"} title="含脚本时可在沙箱里真实运行">沙箱运行</button>
        <button class="btn tiny" data-act="src" ${r.svg || r.raw ? "" : "disabled"}>看源码</button>
        <button class="btn tiny" data-act="copysvg" ${r.svg ? "" : "disabled"}>复制 SVG</button>
        <button class="btn tiny" data-act="savesvg" ${r.svg ? "" : "disabled"}>保存 SVG</button>
      </div>
    </div>`;
  }).join("")}</div>`;

  el.querySelectorAll(".gcard").forEach((card) => {
    const pair = items[Number(card.dataset.i)];
    const m = pair.m, r = pair.r;
    const task = taskById(r.taskId) || { title: r.title || r.taskId };
    card.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "preview") showGen({ kind: "img", svg: r.svg, title: `${m.model} · ${task.title}` });
      if (act === "src") showModal(`${task.title} · 源码`,
        `<pre style="white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto">${esc(r.svg || r.raw || "（无）")}</pre>`,
        [{ label: "复制", fn: () => copyText(r.svg || r.raw || "", "源码") }, { label: "关闭", cls: "primary", fn: hideModal }]);
      if (act === "copysvg") copyText(r.svg, "SVG");
      if (act === "savesvg") saveFile(`${r.taskId}-${String(m.model).replace(/[^\w.-]+/g, "_")}.svg`, r.svg);
      if (act === "sandbox") {
        const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#fff">${sanitizeSvg(r.svg, { keepScript: true })}</body>`;
        showGen({ kind: "iframe", html });
        toast("沙箱运行：脚本在隔离 iframe 内执行", "ok");
      }
      if (act === "judge") await judgeSvgRow(m, r, task);
    }));
    card.querySelectorAll("[data-frame]").forEach((img) => img.addEventListener("click", () => {
      showModal("动画帧", `<img style="max-width:100%" src="${img.src}">`, [{ label: "关闭", cls: "primary", fn: hideModal }]);
    }));
  });
}

async function judgeSvgRow(m, r, task) {
  if (!r.svg) { toast("没有 SVG 可评审", "bad"); return; }
  const p = S.providers.find((x) => x.name === m.provider) || S.providers[0];
  if (!p) { toast("端点已不存在", "bad"); return; }
  const j = resolveJudge(p, m.model);
  let frames = r.frames;
  if (!frames || !frames.length) {
    try { const cap = await captureFrames(r.svg); frames = cap.frames; r.frames = frames; r.motion = cap.motion; }
    catch (e) { toast("SVG 无法渲染：" + e.message, "bad"); return; }
  }
  log("裁判", `${task.title} · 由 ${j.model} 评审`, "上传帧 + 源码…", "info");
  const jr = await opJudgeSvg(j.p, j.model, task, { candidateFrames: frames, svg: r.svg, motion: r.motion }, cfgOf(), {});
  r.judge = jr.judge || null;
  r.judgeRaw = jr.raw || "";
  r.judgeModel = j.model;
  r.judgeError = jr.error || "";
  await persistRuns();
  renderGallery();
  if (jr.ok) {
    log("裁判结论", `${task.title} · ${jr.judge.score} 分 ${starsText(jr.judge.stars)}`, jr.judge.verdict || "", jr.judge.score >= 60 ? "ok" : "warn");
    toast(`${task.title}：${jr.judge.score} 分 ${starsText(jr.judge.stars)}\n${jr.judge.verdict || ""}`, jr.judge.score >= 60 ? "ok" : "warn");
  } else {
    log("裁判失败", task.title, jr.error || "失败", "bad");
    toast("裁判失败：" + (jr.error || ""), "bad");
  }
}

// ==================== 题库视图 ====================
function renderBank() {
  const el = $("#view-bank");
  if (!el) return;
  const groups = GROUPS.map((g) => ({ g, items: QUESTIONS.filter((q) => q.group === g.key) })).filter((x) => x.items.length);
  el.innerHTML = groups.map(({ g, items }) => `
    <div class="bank-group">
      <h3>${esc(g.label)} · ${items.length} 题</h3>
      ${items.map((q) => `<div class="qitem">
        <div class="qitem-head">
          <span class="badge">${q.no}</span>
          <span class="badge">${esc(q.type)}</span>
          <span class="pill mute">难度 ${q.level}/5</span>
          <span class="spacer"></span>
          <span class="sub">${esc(q.id)}</span>
        </div>
        <div class="qitem-prompt">${esc(q.prompt)}</div>
        <div class="qitem-answer">标准答案：<b>${esc(q.answer)}</b></div>
        <div class="qitem-tools">
          <button class="btn tiny" data-copy-prompt="${q.id}">复制题目</button>
          <button class="btn tiny" data-copy-answer="${q.id}">复制答案</button>
        </div>
      </div>`).join("")}
    </div>`).join("") + `
    <div class="bank-group">
      <h3>SVG 动画题 · ${SVG_TASKS.length} 题（AI 视觉裁判按维度评审）</h3>
      ${SVG_TASKS.map((t) => `<div class="qitem">
        <div class="qitem-head">
          <span class="badge">${t.no}</span>
          <span class="badge">${esc(t.title)}</span>
          <span class="stars">${starsText(t.stars)}</span>
          <span class="spacer"></span>
          <label class="chk tight"><input type="checkbox" data-task="${t.id}" ${S.settings.taskEnabled[t.id] !== false ? "checked" : ""}><span>参与检测</span></label>
        </div>
        <div class="qitem-prompt">${esc(t.brief)}</div>
        <div class="qitem-answer">评分维度：${(t.criteria || []).map(esc).join(" · ")}</div>
        <div class="qitem-tools">
          <button class="btn tiny" data-copy-task="${t.id}">复制完整提示词</button>
        </div>
      </div>`).join("")}
    </div>`;
  el.querySelectorAll("[data-copy-prompt]").forEach((b) => b.addEventListener("click", () => {
    const q = qById(b.dataset.copyPrompt);
    copyText(q.prompt, q.id);
  }));
  el.querySelectorAll("[data-copy-answer]").forEach((b) => b.addEventListener("click", () => {
    const q = qById(b.dataset.copyAnswer);
    copyText(q.answer, q.id);
  }));
  el.querySelectorAll("[data-copy-task]").forEach((b) => b.addEventListener("click", () => {
    const t = taskById(b.dataset.copyTask);
    copyText(buildSvgPrompt(t), t.title);
  }));
  el.querySelectorAll("[data-task]").forEach((cb) => cb.addEventListener("change", () => {
    S.settings.taskEnabled[cb.dataset.task] = cb.checked;
    storeSave("settings", S.settings);
    renderBankCount();
  }));
}

// ==================== 端点编辑 ====================
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
      <div class="field"><label>协议类型</label><select id="f_type" class="select">
        ${TYPES.map((t) => `<option value="${t.value}" ${p.type === t.value ? "selected" : ""}>${t.label}</option>`).join("")}
      </select></div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>BaseURL</label>
      <div class="row-inline">
        <input id="f_base" value="${esc(p.baseUrl || "")}" placeholder="https://host/v1">
        <button class="btn tiny" id="f_fetch" type="button">拉取模型</button>
      </div>
      <div class="sub">只写域名会自动补 /v1；粘成 /chat/completions 也会自动纠正。</div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>API Key</label>
      <div class="row-inline">
        <input id="f_key" type="password" value="${esc(p.apiKey || "")}" placeholder="sk-...">
        <button class="btn tiny" id="f_eye" type="button">显示</button>
        <button class="btn tiny" id="f_clip" type="button">识别剪贴板</button>
      </div>
    </div>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="f_enabled" ${p.enabled !== false ? "checked" : ""}><span>启用该端点</span></label>
    <div class="field" style="margin-top:12px">
      <label>测试模型 <span class="badge" id="f_selcount">0</span></label>
      <input id="f_search" placeholder="搜索模型…" ${pulled.length ? "" : "disabled"}>
      <div class="model-list" id="f_modellist">
        ${pulled.length ? pulled.map((m) => `<label class="model-row" data-m="${esc(m.toLowerCase())}">
          <input type="checkbox" data-model="${esc(m)}" ${SEL.set.has(m) ? "checked" : ""}><span class="mn">${esc(m)}</span></label>`).join("")
          : `<div class="empty-sm">还没拉取到模型 · 点「拉取模型」</div>`}
      </div>
      <label class="sub" style="display:block;margin-top:8px">手动补充模型（每行一个）</label>
      <textarea id="f_selmodels" style="min-height:56px">${esc(extra.join("\n"))}</textarea>
      <div class="sub">不勾不填 = 自动取前 2 个模型。</div>
    </div>`;
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
      if (cb.checked) SEL.set.add(cb.dataset.model); else SEL.set.delete(cb.dataset.model);
      refreshSelCount();
    });
  });
  refreshSelCount();
}
function renderFormModels(models) {
  const list = [...new Set(models)].sort();
  const box = $("#f_modellist");
  if (box) {
    box.innerHTML = list.length
      ? list.map((m) => `<label class="model-row" data-m="${esc(m.toLowerCase())}">
          <input type="checkbox" data-model="${esc(m)}" ${SEL.set.has(m) ? "checked" : ""}><span class="mn">${esc(m)}</span></label>`).join("")
      : `<div class="empty-sm">该端点没有返回任何模型</div>`;
  }
  const s = $("#f_search");
  if (s) s.disabled = !list.length;
  bindModelList();
}
function editProvider(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  showModal(`编辑端点 · ${p.name || "(未命名)"}`, providerForm(p), [
    { label: "取消", fn: hideModal },
    { label: "保存", cls: "primary", fn: () => saveProvider(id) },
  ]);
  bindModelList();
  const typeSel = $("#f_type");
  if (typeSel) typeSel.addEventListener("change", (e) => {
    const base = $("#f_base");
    if (base && !base.value.trim()) { const a = ADAPTERS[e.target.value]; if (a && a.defaultBase) base.value = a.defaultBase(); }
  });
  const fetchBtn = $("#f_fetch");
  if (fetchBtn) fetchBtn.addEventListener("click", async () => {
    const type = $("#f_type").value;
    const baseUrl = normalizeBase($("#f_base").value.trim(), type);
    const apiKey = $("#f_key").value.trim();
    if (!baseUrl) { toast("先填 BaseURL", "bad"); return; }
    fetchBtn.disabled = true; fetchBtn.textContent = "拉取中…";
    try {
      const models = await listModels({ type, baseUrl, apiKey }, { timeoutMs: 15000 });
      p.models = models;
      await storeSave("providers", S.providers);
      renderFormModels(models);
      renderProviders(); renderJudgeSelect();
      toast(`获取到 ${models.length} 个模型`, "ok");
    } catch (e) { toast("拉取失败：" + e.message, "bad"); }
    finally { fetchBtn.disabled = false; fetchBtn.textContent = "拉取模型"; }
  });
  const search = $("#f_search");
  if (search) search.addEventListener("input", (e) => {
    const kw = e.target.value.trim().toLowerCase();
    $("#f_modellist").querySelectorAll(".model-row").forEach((row) => {
      row.style.display = !kw || row.dataset.m.includes(kw) ? "" : "none";
    });
  });
  const extraTa = $("#f_selmodels");
  if (extraTa) extraTa.addEventListener("input", (e) => { SEL.extra = e.target.value; refreshSelCount(); });
  const eye = $("#f_eye");
  if (eye) eye.addEventListener("click", () => {
    const el = $("#f_key");
    const show = el.type === "password";
    el.type = show ? "text" : "password";
    eye.textContent = show ? "隐藏" : "显示";
  });
  const clip = $("#f_clip");
  if (clip) clip.addEventListener("click", async () => {
    const txt = await clipRead();
    const conn = parseConnText(txt);
    if (!conn) { toast("剪贴板里没识别到连接信息", "bad"); return; }
    if (conn.baseUrl) $("#f_base").value = conn.baseUrl;
    if (conn.apiKey) $("#f_key").value = conn.apiKey;
    if (conn.type) $("#f_type").value = conn.type;
    if (conn.name && !$("#f_name").value) $("#f_name").value = conn.name;
    toast("已填入连接信息", "ok");
  });
}
function saveProvider(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  const nm = $("#f_name").value.trim();
  const rawBase = $("#f_base").value.trim();
  if (!nm || !rawBase) { toast("名称和 BaseURL 必填", "bad"); return; }
  p.name = nm;
  p.type = $("#f_type").value;
  p.baseUrl = normalizeBase(rawBase, p.type);
  p.apiKey = $("#f_key").value.trim();
  p.enabled = $("#f_enabled").checked;
  const extraTa = $("#f_selmodels");
  const extra = (extraTa ? extraTa.value : "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  p.selModels = [...new Set([...SEL.set, ...extra])];
  hideModal();
  storeSave("providers", S.providers);
  renderAll();
  renderJudgeSelect();
  toast(`已保存 ${p.name}`, "ok");
}
function addProvider() {
  const p = { id: uid(), name: "", type: "openai", baseUrl: "", apiKey: "", enabled: true, models: [], selModels: [] };
  S.providers.push(p);
  storeSave("providers", S.providers);
  renderProviders();
  editProvider(p.id);
  setTimeout(async () => {
    const txt = await clipRead();
    const conn = parseConnText(txt);
    if (conn) toast(`剪贴板识别到：${conn.name || conn.baseUrl}，可点「识别剪贴板」填入`, "ok");
  }, 260);
}
function delProvider(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`删除端点「${p.name}」？`)) return;
  S.providers = S.providers.filter((x) => x.id !== id);
  storeSave("providers", S.providers);
  renderAll();
  renderJudgeSelect();
}
async function fetchModelsFor(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  if (!p.baseUrl) { toast("该端点没有 BaseURL", "bad"); return; }
  try {
    const models = await listModels(p, { timeoutMs: 15000 });
    p.models = models;
    await storeSave("providers", S.providers);
    renderAll();
    renderJudgeSelect();
    toast(`${p.name}：获取到 ${models.length} 个模型`, "ok");
  } catch (e) { toast(`获取失败：${e.message}`, "bad"); }
}
function providerMenu(id, e) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  menuAt(e, p.name || "端点", [
    { label: "编辑端点…", fn: () => editProvider(id) },
    { label: "拉取模型列表", hint: (p.models || []).length ? p.models.length + " 个" : "", fn: () => fetchModelsFor(id) },
    { label: (p.enabled === false ? "启用" : "停用") + "该端点", fn: async () => { p.enabled = p.enabled === false; await storeSave("providers", S.providers); renderAll(); } },
    { sep: true },
    cp(p.name, "名称"),
    cp(p.baseUrl, "BaseURL"),
    cp(p.apiKey, "API Key"),
    { label: "复制连接配置（URL + Key）", fn: () => copyText(`${p.baseUrl}\n${p.apiKey || ""}`, "连接配置") },
    { label: "复制模型列表", disabled: !(p.models || []).length, fn: () => copyText((p.models || []).join("\n"), (p.models || []).length + " 个模型") },
    { sep: true },
    { label: "删除端点", kind: "danger", fn: () => delProvider(id) },
  ]);
}

// ==================== 报告 / 分享 ====================
function exportCsv() {
  const run = currentRun();
  if (!run) { toast("还没有可导出的结果", "bad"); return; }
  const name = `iq-report-${new Date(run.ts).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
  saveFile(name, buildReportCsv(run));
}
function shareModal() {
  const run = currentRun();
  if (!run) { toast("还没有可分享的结果", "bad"); return; }
  const text = buildShareText(run);
  showModal("分享报告",
    `<textarea id="shareText" style="width:100%;min-height:320px;font-family:var(--mono);font-size:12px">${esc(text)}</textarea>`,
    [
      { label: "保存 .md", fn: () => saveFile(`iq-share-${new Date(run.ts).toISOString().slice(0, 10)}.md`, text) },
      { label: "导出 CSV", fn: exportCsv },
      { label: "复制到剪贴板", cls: "primary", fn: () => copyText(text, "分享报告") },
    ]);
}

// ==================== 渲染汇总 / 初始化 ====================
function renderTopStats() {
  const el = $("#topStats");
  if (!el) return;
  const run = currentRun();
  if (!run) { el.innerHTML = `<span>端点 <b>${S.providers.length}</b></span><span>等待首次检测</span>`; return; }
  const st = runStats(run);
  el.innerHTML = `<span>端点 <b>${run.providerCount ?? S.providers.length}</b></span>` +
    `<span>学科题 <b class="${(st.qRate ?? 0) >= 60 ? "good" : "bad"}">${st.qRate == null ? "—" : st.qRate + "%"}</b></span>` +
    `<span>SVG <b>${st.svgTotal || 0}</b></span>` +
    `<span>上次 <b>${hhmmss(run.ts)}</b></span>`;
}
function renderAll() {
  renderTopStats();
  renderHist();
  renderProviders();
  renderQList();
  renderJudgeSelect();
  renderResults();
  renderGallery();
  renderBank();
  renderForensics();
  renderTimeline();
  renderGen();
}

function bindStatic() {
  $("#btnRun").addEventListener("click", runAll);
  $("#btnStop").addEventListener("click", stopRun);
  $("#btnShare").addEventListener("click", shareModal);
  $("#themeToggle").addEventListener("click", cycleTheme);
  $("#btnAddProv").addEventListener("click", addProvider);
  $("#btnFetchProv").addEventListener("click", async () => {
    for (const p of S.providers) await fetchModelsFor(p.id);
    if (!S.providers.length) toast("先添加端点", "bad");
  });
  $("#selAllQ").addEventListener("change", (e) => {
    QUESTIONS.forEach((q) => { S.settings.qEnabled[q.id] = e.target.checked; });
    storeSave("settings", S.settings);
    renderQList();
  });
  const bindNum = (id, key, min, max) => {
    const el = $(id);
    if (!el) return;
    el.value = S.settings[key];
    el.addEventListener("change", () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) S.settings[key] = Math.max(min, Math.min(max, v));
      el.value = S.settings[key];
      storeSave("settings", S.settings);
    });
  };
  bindNum("#cfgConc", "concurrency", 1, 16);
  bindNum("#cfgTimeout", "timeoutSec", 10, 600);
  bindNum("#cfgMaxTok", "maxTokens", 256, 32768);
  bindNum("#cfgRetries", "retries", 0, 5);
  const tk = $("#cfgThinking");
  if (tk) {
    tk.value = S.settings.thinking || "off";
    tk.addEventListener("change", () => { S.settings.thinking = tk.value; storeSave("settings", S.settings); });
  }
  const jEl = $("#cfgJudge");
  jEl.checked = S.settings.judgeOn;
  jEl.addEventListener("change", (e) => { S.settings.judgeOn = e.target.checked; storeSave("settings", S.settings); });
  const sEl = $("#cfgSvgOn");
  sEl.checked = S.settings.svgOn;
  sEl.addEventListener("change", (e) => { S.settings.svgOn = e.target.checked; storeSave("settings", S.settings); renderBankCount(); });
  const pEl = $("#cfgProbeOn");
  if (pEl) {
    pEl.checked = S.settings.probeOn;
    pEl.addEventListener("change", (e) => { S.settings.probeOn = e.target.checked; storeSave("settings", S.settings); });
  }
  $("#cfgJudgeModel").addEventListener("change", (e) => {
    S.settings.judgeModel = e.target.value;
    storeSave("settings", S.settings);
    renderJudgeSelect();
  });
  const fl = $("#followLog");
  fl.checked = S.settings.followLog;
  fl.addEventListener("change", (e) => { S.settings.followLog = e.target.checked; storeSave("settings", S.settings); });

  document.querySelectorAll("#tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      S.tab = b.dataset.tab;
      ["monitor", "results", "gallery", "bank", "forensics"].forEach((t) => $("#view-" + t).classList.toggle("hidden", t !== S.tab));
      if (S.tab === "results") renderResults();
      if (S.tab === "gallery") renderGallery();
      if (S.tab === "forensics") renderForensics();
      if (S.tab === "bank") renderBank();
    });
  });

  document.querySelectorAll(".subtab").forEach((b) => {
    b.addEventListener("click", () => setHistSub(b.dataset.sub));
  });
  $("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) hideModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideModal(); closeMenu(); return; }
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
    if (e.key === "ArrowLeft") { histStep(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { histStep(1); e.preventDefault(); }
  });
  document.addEventListener("contextmenu", (e) => {
    const t = e.target;
    const tag = (t && t.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, "操作", [
      { label: "开始检测", fn: runAll },
      { label: "停止", disabled: !S.running, fn: stopRun },
      { sep: true },
      { label: "添加端点", fn: addProvider },
      { label: "导出报告 CSV", fn: exportCsv },
      { label: "生成分享报告", fn: shareModal },
      { sep: true },
      { label: "切换主题", fn: cycleTheme },
      { label: "打开数据目录", fn: () => invoke("openDataDir") },
    ]);
  });
  document.addEventListener("click", (e) => { if (_menuEl && !_menuEl.contains(e.target)) closeMenu(); }, true);
  window.addEventListener("blur", () => closeMenu());
  document.addEventListener("scroll", () => closeMenu(), true);
}

(async function init() {
  S.providers = (await storeLoad("providers", [])) || [];
  const st = (await storeLoad("settings", null)) || {};
  S.settings = {
    ...DEFAULT_SETTINGS, ...st,
    qEnabled: { ...DEFAULT_SETTINGS.qEnabled, ...(st.qEnabled || {}) },
    taskEnabled: { ...DEFAULT_SETTINGS.taskEnabled, ...(st.taskEnabled || {}) },
  };
  const rawRuns = (await storeLoad("runs", [])) || [];
  // 清洗历史数据：旧版本把 base64 帧写进了 runs.json（可达 1.8MB），启动解析会卡死界面
  let cleaned = 0;
  S.runs = rawRuns.map((run) => ({
    ...run,
    models: (run.models || []).map((m) => {
      const svg = (m.svg || []).map((r) => {
        if (r.frames) { cleaned++; return { ...r, frames: undefined }; }
        return r;
      });
      return { ...m, svg };
    }),
  }));
  if (cleaned) {
    // 立刻回写精简版，避免下次启动再解析一遍
    setTimeout(() => { storeSave("runs", slimForStore(S.runs)); }, 0);
    try { console.warn("[iqbench] 已清洗", cleaned, "处历史 base64 帧"); } catch { /* noop */ }
  }
  applyTheme();
  bindStatic();
  renderAll();
  setHistSub(S.hist.sub);
  setStatus("就绪");

  // e2e 测试钩子：?e2e=1[&base=...][&qs=Q1,Q12][&tasks=svg-ecg]
  const params = new URLSearchParams(location.search);
  if (params.get("e2e")) {
    const base = params.get("base") || "http://127.0.0.1:18099/v1";
    const pick = (key, all) => {
      const v = params.get(key);
      return v ? new Set(v.split(",").filter(Boolean)) : new Set(all);
    };
    const qs = pick("qs", QUESTIONS.map((q) => q.id));
    const tk = pick("tasks", SVG_TASKS.map((t) => t.id));
    QUESTIONS.forEach((q) => { S.settings.qEnabled[q.id] = qs.has(q.id); });
    SVG_TASKS.forEach((t) => { S.settings.taskEnabled[t.id] = tk.has(t.id); });
    S.settings.concurrency = Number(params.get("conc") || 2);
    S.providers = [{ id: "e2e", name: "E2E·本地mock", type: "openai", baseUrl: base, apiKey: "sk-e2e", enabled: true, models: [], selModels: [] }];
    renderAll();
    try {
      const ms = await listModels(S.providers[0], { timeoutMs: 8000 });
      S.providers[0].models = ms;
      S.providers[0].selModels = ms.slice(0, Number(params.get("nmodels") || 1));
      renderAll();
    } catch (e) { console.warn("e2e listModels 失败", e); }
    await runAll();
    document.documentElement.dataset.e2e = "done";
  }
  try {
    const r = await invoke("sysinfo");
    if (r && r.ok && r.data) {
      const info = JSON.parse(r.data);
      if (info.ver) { const el = $("#verText"); if (el) el.textContent = "v" + info.ver; }
    }
  } catch { /* 浏览器模式 */ }
})();

// 调试入口
window.AH = {
  state: S, runAll, stopRun, exportCsv, shareModal, captureFrames, showGen,
  histRows, renderHist, histStep, setHistSub,
  parseConn: parseConnText, renderAll, questions: QUESTIONS, tasks: SVG_TASKS,
  histRows, renderHist, histStep, setHistSub, renderForensics, probes: PROBE_ITEMS, layers: PROBE_LAYERS,
};
