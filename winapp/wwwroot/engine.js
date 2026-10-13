// engine.js — 模型智商检测引擎（纯逻辑层，浏览器 / Node 双端通用，不碰 DOM）
// 职责：协议适配（openai / anthropic / gemini）、答题、SVG 生成、视觉裁判、判分、统计、报告

import {
  GROUPS, QUESTIONS, SVG_TASKS, buildSvgPrompt, buildQuestionPrompt, QUESTION_SYSTEM,
} from "./questions.js";

export { GROUPS, QUESTIONS, SVG_TASKS, buildSvgPrompt, buildQuestionPrompt, QUESTION_SYSTEM };

export const TYPES = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
];

// ---------------- 小工具 ----------------
export const avg = (a) => (a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
export const rt = (x) => Math.round(x);
export function pct(arr, p) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return Math.round(a[i]);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const starsFromScore = (score) => Math.max(0, Math.min(5, Math.round((Number(score) || 0) / 20)));
export const starsText = (n) => "★".repeat(Math.max(0, Math.min(5, n | 0))) + "☆".repeat(5 - Math.max(0, Math.min(5, n | 0)));

// ---------------- 归一化与判分 ----------------
// 统一全角/半角、各种减号、上下标、去掉空白与常见标点；保留 +-*/^=√πλθ 等数学符号。
const DASHES = /[\u2010-\u2015\u2212\u2043\ufe63\uff0d]/g;
const DROP = /[\s\u00a0\u200b\u3000]+|[…·，。、；：！？""''「」『』《》〈〉【】〖〗`"'，]/g;
export function norm(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(DASHES, "-")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(DROP, "");
}

export function numbers(s) {
  const out = [];
  const re = /-?\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(norm(s)))) out.push(parseFloat(m[0]));
  return out;
}

// 按题目 grade 规格判分；候选字符串按顺序尝试，任一命中即算对
// 组判定：数组 = OR 子串；{any:[...], min:n} = 这些子串总出现次数 >= n
const hitGroup = (n, group) => {
  if (Array.isArray(group)) return group.some((x) => n.includes(norm(x)));
  if (group && Array.isArray(group.any)) {
    const total = group.any.map(norm).reduce((s, t) => (t ? s + n.split(t).length - 1 : s), 0);
    return total >= (group.min || 1);
  }
  return false;
};

export function gradeAnswer(q, candidates) {
  const g = q.grade || {};
  const list = (candidates || []).filter((s) => s != null && String(s).trim() !== "");
  for (const cand of list) {
    const n = norm(cand);
    if (!n) continue;
    if (g.exact && g.exact.some((x) => n === norm(x))) return { ok: true, how: "exact", hit: cand };
    if (g.digits && n.replace(/\D/g, "").includes(g.digits)) return { ok: true, how: "digits", hit: cand };
    if (g.num && numbers(n).some((v) => g.num.some((t) => Math.abs(v - t) < 1e-9))) return { ok: true, how: "num", hit: cand };
    if (g.nums && g.nums.every((t) => numbers(n).some((v) => Math.abs(v - t) < 1e-9))) return { ok: true, how: "nums", hit: cand };
    if (g.any && g.any.some((x) => n.includes(norm(x)))) return { ok: true, how: "any", hit: cand };
    if (g.all && g.all.every((group) => hitGroup(n, group))) return { ok: true, how: "all", hit: cand };
    if (g.alts && g.alts.some((set) => (set.all || []).every((group) => hitGroup(n, group))))
      return { ok: true, how: "alts", hit: cand };
  }
  return { ok: false, how: "", hit: "" };
}

// 从回答里抽出「答案：X」；找不到就退回最后一行 / 全文
export function extractAnswerLine(raw) {
  const text = String(raw ?? "");
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:最终答案|答案|answer|final(?:\s*answer)?)\s*[:：]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return "";
}

export function answerCandidates(raw) {
  const text = String(raw ?? "");
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const line = extractAnswerLine(text);
  if (line) out.push(line);
  const re = /(?:最终答案|答案|answer|final(?:\s*answer)?)\s*[:：]\s*([^\n]+)/gi;
  let m;
  while ((m = re.exec(text))) if (m[1] && m[1].trim()) out.push(m[1].trim());
  if (lines.length) out.push(lines[lines.length - 1]);
  out.push(text);
  return [...new Set(out)];
}

// ---------------- SVG 抽取 / 规整 / 净化 ----------------
export function extractSvg(text) {
  const t = String(text ?? "");
  const fence = t.match(/```(?:svg|xml|html)?\s*([\s\S]*?)```/i);
  if (fence && /<svg/i.test(fence[1])) return fence[1].trim();
  const low = t.toLowerCase();
  const start = low.indexOf("<svg");
  if (start >= 0) {
    const end = low.indexOf("</svg>", start);
    if (end >= 0) return t.slice(start, end + 6).trim();
  }
  return "";
}

// 补全 xmlns / width / height，保证能当图片加载
export function ensureSvgSize(svg, def = 400) {
  return String(svg ?? "").replace(/<svg\b[^>]*>/i, (tag) => {
    let out = tag;
    let w = null, h = null;
    const vb = tag.match(/viewBox\s*=\s*["']([^"']+)["']/i);
    if (vb) {
      const p = vb[1].trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p.every((x) => isFinite(x))) { w = p[2]; h = p[3]; }
    }
    if (!/\bwidth\s*=/i.test(out)) out = out.replace(/<svg/i, `<svg width="${w || def}"`);
    if (!/\bheight\s*=/i.test(out)) out = out.replace(/<svg/i, `<svg height="${h || def}"`);
    if (!/\bxmlns\s*=/i.test(out)) out = out.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    return out;
  });
}

// 净化：默认连 <script> 一起去掉（用于 <img> 渲染）；keepScript 时保留脚本（仅用于沙箱 iframe）
export function sanitizeSvg(svg, opts = {}) {
  let out = String(svg ?? "");
  if (!opts.keepScript) out = out.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<script\b[^>]*\/>/gi, "");
  out = out
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/(href|src|xlink:href)\s*=\s*["']https?:\/\/[^"']*["']/gi, "");
  return out;
}

export const svgDataUrl = (svg) =>
  "data:image/svg+xml;charset=utf-8," + encodeURIComponent(String(svg ?? ""));

// ---------------- 协议适配 ----------------
const trimBase = (u) => String(u || "").replace(/\/+$/, "");
const b64Of = (dataUrl) => String(dataUrl || "").replace(/^data:[^,]*,/, "");

function httpErr(txt, status) {
  try {
    const j = JSON.parse(txt);
    const m = j && (j.error?.message || j.message || j.error);
    if (m) return typeof m === "string" ? m : JSON.stringify(m);
  } catch { /* 非 JSON */ }
  return "HTTP " + status + (txt ? " · " + String(txt).slice(0, 160) : "");
}

export const ADAPTERS = {
  openai: {
    label: "OpenAI 兼容",
    defaultBase: () => "https://api.openai.com/v1",
    headers(p, json = true) {
      const h = {};
      if (p.apiKey) h.Authorization = "Bearer " + p.apiKey;
      if (json) h["Content-Type"] = "application/json";
      return h;
    },
    modelsUrl: (p) => trimBase(p.baseUrl) + "/models",
    parseModels: (j) => (j?.data || []).map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean).map(String),
    chatUrl: (p) => trimBase(p.baseUrl) + "/chat/completions",
    buildMessages(model, { system, user, parts, maxTokens, temperature }) {
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      if (parts) {
        messages.push({
          role: "user",
          content: parts.map((pt) => pt.type === "image"
            ? { type: "image_url", image_url: { url: pt.dataUrl } }
            : { type: "text", text: pt.text }),
        });
      } else {
        messages.push({ role: "user", content: user ?? "" });
      }
      return { model, messages, max_tokens: maxTokens, temperature };
    },
    parseChat(j) {
      const ch = j?.choices?.[0] || {};
      return {
        content: String(ch.message?.content ?? "").trim(),
        tokens: j?.usage?.completion_tokens ?? null,
        finish: String(ch.finish_reason ?? ""),
      };
    },
  },

  anthropic: {
    label: "Anthropic",
    defaultBase: () => "https://api.anthropic.com",
    headers(p, json = true) {
      const h = { "anthropic-version": "2023-06-01" };
      if (p.apiKey) h["x-api-key"] = p.apiKey;
      if (json) h["Content-Type"] = "application/json";
      return h;
    },
    modelsUrl: (p) => trimBase(p.baseUrl || ADAPTERS.anthropic.defaultBase()) + "/v1/models",
    parseModels: (j) => (j?.data || []).map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean).map(String),
    chatUrl: (p) => trimBase(p.baseUrl || ADAPTERS.anthropic.defaultBase()) + "/v1/messages",
    buildMessages(model, { system, user, parts, maxTokens, temperature }) {
      const b = { model, max_tokens: maxTokens, temperature };
      if (system) b.system = system;
      if (parts) {
        b.messages = [{
          role: "user",
          content: parts.map((pt) => pt.type === "image"
            ? { type: "image", source: { type: "base64", media_type: "image/png", data: b64Of(pt.dataUrl) } }
            : { type: "text", text: pt.text }),
        }];
      } else {
        b.messages = [{ role: "user", content: user ?? "" }];
      }
      return b;
    },
    parseChat(j) {
      const t = (j?.content || []).map((c) => c?.text || "").join("").trim();
      return { content: t, tokens: j?.usage?.output_tokens ?? null, finish: String(j?.stop_reason ?? "") };
    },
  },

  gemini: {
    label: "Gemini",
    defaultBase: () => "https://generativelanguage.googleapis.com/v1beta",
    headers(p) {
      const h = { "Content-Type": "application/json" };
      if (p.apiKey) h["x-goog-api-key"] = p.apiKey;
      return h;
    },
    modelsUrl: (p) => gb(p) + "/models",
    parseModels: (j) => (j?.models || []).map((m) => String(m?.name || "").replace(/^models\//, "")).filter(Boolean),
    chatUrl: (p, model) => gb(p) + "/models/" + encodeURIComponent(model) + ":generateContent",
    buildMessages(model, { system, user, parts, maxTokens, temperature }) {
      const b = { generationConfig: { maxOutputTokens: maxTokens, temperature } };
      if (system) b.systemInstruction = { parts: [{ text: system }] };
      if (parts) {
        b.contents = [{
          role: "user",
          parts: parts.map((pt) => pt.type === "image"
            ? { inlineData: { mimeType: "image/png", data: b64Of(pt.dataUrl) } }
            : { text: pt.text }),
        }];
      } else {
        b.contents = [{ role: "user", parts: [{ text: user ?? "" }] }];
      }
      return b;
    },
    parseChat(j) {
      const t = (j?.candidates?.[0]?.content?.parts || []).map((x) => x?.text || "").join("").trim();
      const fr = j?.candidates?.[0]?.finishReason;
      return { content: t, tokens: j?.usageMetadata?.candidatesTokenCount ?? null, finish: fr ? String(fr).toLowerCase() : "" };
    },
  },
};

function gb(p) {
  let b = trimBase(p.baseUrl || ADAPTERS.gemini.defaultBase());
  if (!/\/v\d+(beta)?$/.test(b)) b += "/v1beta";
  return b;
}

export const adapterOf = (p) => ADAPTERS[p?.type] || ADAPTERS.openai;

async function fetchJson(url, init, timeoutMs, outerSignal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch { /* noop */ } }, timeoutMs);
  const onAbort = () => { try { ctrl.abort(); } catch { /* noop */ } };
  if (outerSignal) {
    if (outerSignal.aborted) onAbort();
    else outerSignal.addEventListener("abort", onAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
  };
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const txt = await res.text();
    return { res, txt };
  } catch (e) {
    if (timedOut) throw new Error("请求超时（" + timeoutMs + "ms）");
    if (e && e.name === "AbortError") throw new Error("已取消");
    throw e;
  } finally {
    cleanup();
  }
}

export async function listModels(p, opts = {}) {
  const a = adapterOf(p);
  const { timeoutMs = 15000, signal } = opts;
  const { res, txt } = await fetchJson(a.modelsUrl(p), { method: "GET", headers: a.headers(p, false) }, timeoutMs, signal);
  if (!res.ok) { const e = new Error(httpErr(txt, res.status)); e.status = res.status; throw e; }
  let j; try { j = JSON.parse(txt); } catch { throw new Error("模型列表响应非 JSON"); }
  return [...new Set(a.parseModels(j))].sort();
}

export async function opConnectivity(p, opts = {}) {
  const t0 = Date.now();
  try {
    const models = await listModels(p, opts);
    return { provider: p.name, kind: "connect", ok: true, status: 200, latencyMs: Date.now() - t0, models, error: "", t: Date.now() };
  } catch (e) {
    return { provider: p.name, kind: "connect", ok: false, status: e.status || 0, latencyMs: Date.now() - t0, models: [], error: String(e?.message || e), t: Date.now() };
  }
}

// 单次对话请求（不含重试）
async function callChat(p, model, payloadOpts, opts = {}) {
  const a = adapterOf(p);
  const { timeoutMs = 120000, signal } = opts;
  const url = a.chatUrl(p, model);
  const body = a.buildMessages(model, payloadOpts);
  const t0 = Date.now();
  const { res, txt } = await fetchJson(url, { method: "POST", headers: a.headers(p, true), body: JSON.stringify(body) }, timeoutMs, signal);
  const latencyMs = Date.now() - t0;
  if (!res.ok) { const e = new Error(httpErr(txt, res.status)); e.status = res.status; e.retryAfter = res.headers.get("Retry-After"); throw e; }
  let j; try { j = JSON.parse(txt); } catch { throw new Error("响应非 JSON: " + String(txt).slice(0, 120)); }
  const parsed = a.parseChat(j);
  return { ...parsed, latencyMs, status: res.status };
}

// 带重试：429 指数退避持续重试；5xx/网络抖动按 retries 重试；length 截断自动抬高 maxTokens
export async function callChatRetry(p, model, payloadOpts, cfg = {}, opts = {}) {
  const retries = Math.max(0, cfg.retries ?? 2);
  const rlMax = Math.max(0, cfg.rlRetries ?? 6);
  const rlBase = Math.max(1, cfg.rlBaseSec ?? 5);
  const rlCap = Math.max(rlBase, cfg.rlCapSec ?? 120);
  const ceiling = Math.max(payloadOpts.maxTokens || 2048, cfg.maxTokensCeiling ?? 8192);
  const onNote = opts.onNote || (() => {});
  let maxTokens = payloadOpts.maxTokens || 2048;
  let rl = 0, normal = 0;
  for (;;) {
    if (opts.signal?.aborted) return { ok: false, content: "", tokens: null, latencyMs: 0, error: "已取消", rlRetries: rl };
    try {
      const r = await callChat(p, model, { ...payloadOpts, maxTokens }, opts);
      if (String(r.finish).toLowerCase() === "length" && maxTokens < ceiling) {
        const prev = maxTokens;
        maxTokens = Math.min(maxTokens * 2, ceiling);
        onNote(`输出在 ${prev} token 处截断，提高到 ${maxTokens} 后重试`);
        continue;
      }
      return { ok: true, ...r, maxTokensUsed: maxTokens, rlRetries: rl };
    } catch (e) {
      const st = e?.status || 0;
      if (st === 429 && rl < rlMax) {
        rl++;
        const ra = parseFloat(e.retryAfter);
        const wait = isFinite(ra) && ra > 0 ? Math.min(ra, rlCap) : Math.min(rlBase * 2 ** Math.min(rl - 1, 6), rlCap);
        onNote(`遇到 429 限流，等待 ${Math.round(wait)}s 后重试（第 ${rl} 次）`);
        await sleep(wait * 1000);
        continue;
      }
      const retryable = st === 0 || st === 429 || st >= 500;
      if (retryable && normal < retries) {
        normal++;
        await sleep(Math.min(2 ** normal, 8) * 1000);
        continue;
      }
      return { ok: false, content: "", tokens: null, latencyMs: 0, status: st, error: String(e?.message || e), rlRetries: rl };
    }
  }
}

// ---------------- 学科题：作答 + 自动判分 ----------------
export async function opAskQuestion(p, model, q, cfg = {}, opts = {}) {
  const t0 = Date.now();
  const row = {
    qid: q.id, no: q.no, group: q.group, type: q.type, level: q.level,
    provider: p.name, model, expected: q.answer,
    ok: false, got: "", raw: "", gradeHow: "", latencyMs: 0, tokens: null, error: "", t: Date.now(),
  };
  const res = await callChatRetry(p, model, {
    system: QUESTION_SYSTEM,
    user: buildQuestionPrompt(q),
    maxTokens: cfg.maxTokens ?? 2048,
    temperature: cfg.temperature ?? 0,
  }, cfg, { ...opts, onNote: opts.onNote });
  row.latencyMs = Date.now() - t0;
  if (!res.ok) { row.error = res.error || "请求失败"; row.rlRetries = res.rlRetries || 0; return row; }
  row.tokens = res.tokens;
  row.raw = res.content;
  row.rlRetries = res.rlRetries || 0;
  let grade = gradeAnswer(q, answerCandidates(res.content));
  // 有推理但没给出可判定的最终答案 → 追加一次短请求只让它补答案
  if (!grade.ok && String(res.content).trim() && opts.followup !== false) {
    const fu = await callChatRetry(p, model, {
      system: QUESTION_SYSTEM,
      user: `你刚才的分析如下：\n\n${String(res.content).slice(0, 4000)}\n\n请只输出最终答案，格式必须为：答案：<答案>`,
      maxTokens: 64,
      temperature: 0,
    }, { ...cfg, retries: 1 }, { ...opts, onNote: opts.onNote });
    if (fu.ok && fu.content) {
      row.raw = res.content + "\n\n[补答]\n" + fu.content;
      row.tokens = (res.tokens || 0) + (fu.tokens || 0);
      row.latencyMs = Date.now() - t0;
      row.followup = true;
      grade = gradeAnswer(q, answerCandidates(fu.content).concat(answerCandidates(res.content)));
    }
  }
  row.ok = grade.ok;
  row.got = grade.hit || extractAnswerLine(res.content) || "";
  row.gradeHow = grade.how;
  if (!row.ok && !row.error) row.error = res.content ? "答案不符" : "空响应";
  return row;
}

// ---------------- SVG 生成 ----------------
export async function opGenSvg(p, model, task, cfg = {}, opts = {}) {
  const t0 = Date.now();
  const row = {
    taskId: task.id, title: task.title, provider: p.name, model,
    ok: false, svg: "", raw: "", latencyMs: 0, tokens: null, error: "", t: Date.now(),
  };
  const res = await callChatRetry(p, model, {
    system: "你是资深 SVG 动画工程师，只输出可直接运行的 SVG 代码。",
    user: buildSvgPrompt(task),
    maxTokens: cfg.svgMaxTokens ?? 8192,
    temperature: cfg.svgTemperature ?? 0.4,
  }, { ...cfg, retries: Math.min(1, cfg.retries ?? 1) }, { ...opts, onNote: opts.onNote });
  row.latencyMs = Date.now() - t0;
  if (!res.ok) { row.error = res.error || "请求失败"; return row; }
  row.tokens = res.tokens;
  row.raw = res.content;
  const svg = extractSvg(res.content);
  if (!svg) { row.error = "未从回复中解析出 <svg>"; return row; }
  row.svg = ensureSvgSize(svg);
  row.ok = true;
  return row;
}

// ---------------- 视觉裁判 ----------------
export function buildJudgeParts(task, { candidateFrames = [], svg = "", motion = null }) {
  const parts = [];
  parts.push({
    type: "text",
    text: [
      `你是严格的 SVG 动画评审专家（视觉裁判）。`,
      `作品主题：${task.title}（${task.brief}）`,
      "",
      "评分维度：",
      ...task.criteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "下面是候选作品的动画截图与源码。",
      "请逐项判断是否达标，并给出总分（0-100）与星级（0-5）。",
      motion == null ? "" : `（帧间差异检测：${motion ? "有" : "无"}动画，请结合判断）`,
    ].filter(Boolean).join("\n"),
  });
  parts.push({ type: "text", text: "【动画帧】" });
  candidateFrames.forEach((f, i) => parts.push({ type: "image", dataUrl: f, label: `候选帧${i + 1}` }));
  parts.push({ type: "text", text: "【源码】\n```svg\n" + String(svg || "").slice(0, 6000) + "\n```" });
  parts.push({
    type: "text",
    text: [
      "请只输出一个 JSON 对象，不要任何额外文字，格式如下：",
      "{",
      '  "score": 0-100 的整数,',
      '  "stars": 0-5 的整数,',
      '  "verdict": "一句话总评",',
      '  "criteria": [{"name":"评分维度名","pass":true,"comment":"简短理由"}],',
      '  "problems": ["主要问题"],',
      '  "suggestions": ["改进建议"]',
      "}",
    ].join("\n"),
  });
  return parts;
}

export function parseJudgeJson(text) {
  const t = String(text ?? "");
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const tries = [];
  if (fence) tries.push(fence[1]);
  const s = t.indexOf("{");
  if (s >= 0) {
    let depth = 0, end = -1;
    for (let i = s; i < t.length; i++) {
      if (t[i] === "{") depth++;
      else if (t[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > s) tries.push(t.slice(s, end + 1));
  }
  tries.push(t);
  for (const cand of tries) {
    try {
      const j = JSON.parse(cand);
      if (j && typeof j === "object") {
        const score = Math.max(0, Math.min(100, Math.round(Number(j.score) || 0)));
        return {
          score,
          stars: Number.isFinite(Number(j.stars)) ? Math.max(0, Math.min(5, Math.round(Number(j.stars)))) : starsFromScore(score),
          verdict: String(j.verdict || ""),
          criteria: Array.isArray(j.criteria) ? j.criteria.map((c) => ({
            name: String(c?.name || ""), pass: !!c?.pass, comment: String(c?.comment || ""),
          })) : [],
          problems: Array.isArray(j.problems) ? j.problems.map(String) : [],
          suggestions: Array.isArray(j.suggestions) ? j.suggestions.map(String) : [],
        };
      }
    } catch { /* 换下一种解析 */ }
  }
  return null;
}

export async function opJudgeSvg(judgeProvider, judgeModel, task, payload, cfg = {}, opts = {}) {
  const t0 = Date.now();
  const parts = buildJudgeParts(task, payload);
  const res = await callChatRetry(judgeProvider, judgeModel, {
    system: "你是严格的 SVG 动画评审专家，只输出 JSON。",
    parts,
    maxTokens: cfg.judgeMaxTokens ?? 2048,
    temperature: 0,
  }, { retries: 1, rlRetries: cfg.rlRetries ?? 6 }, opts);
  const out = { ok: false, latencyMs: Date.now() - t0, tokens: null, error: "", raw: "", judge: null };
  if (!res.ok) { out.error = res.error || "裁判请求失败"; return out; }
  out.tokens = res.tokens;
  out.raw = res.content;
  out.judge = parseJudgeJson(res.content);
  if (!out.judge) { out.error = "裁判输出无法解析为 JSON"; return out; }
  out.ok = true;
  return out;
}

// ---------------- AI 复核：判两份答案是否等价 ----------------
export async function opJudgeAnswer(judgeProvider, judgeModel, q, answer, cfg = {}, opts = {}) {
  const t0 = Date.now();
  const res = await callChatRetry(judgeProvider, judgeModel, {
    system: "你是严格的阅卷老师，只输出 JSON，不做多余解释。",
    user: [
      `题目：${q.prompt}`,
      "",
      `标准答案：${q.answer}`,
      `考生答案：${String(answer || "").slice(0, 3000) || "（空）"}`,
      "",
      "请判断考生答案与标准答案是否在数学/逻辑上等价（允许不同写法、不同顺序、等价变形）。",
      '只输出 JSON：{"correct":true 或 false,"reason":"一句话理由"}',
    ].join("\n"),
    maxTokens: 256,
    temperature: 0,
  }, { retries: 1, rlRetries: cfg.rlRetries ?? 6 }, opts);
  const out = { ok: false, correct: null, reason: "", raw: "", latencyMs: Date.now() - t0, error: "" };
  if (!res.ok) { out.error = res.error || "复核请求失败"; return out; }
  out.raw = res.content;
  const t = String(res.content);
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      out.correct = !!j.correct;
      out.reason = String(j.reason || "");
      out.ok = true;
      return out;
    } catch { /* 落到兜底 */ }
  }
  out.error = "复核输出无法解析";
  return out;
}

// ---------------- 并发池 ----------------
export async function runPool(items, limit, worker, shouldStop = () => false) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(items.length || 1, limit | 0 || 1));
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------- 统计 ----------------
export function modelStats(m) {
  const q = m.q || [];
  const svg = m.svg || [];
  const correct = q.filter((r) => r.ok).length;
  const judged = svg.filter((r) => r.judge);
  const scores = judged.map((r) => r.judge.score);
  const stars = judged.map((r) => r.judge.stars);
  return {
    qTotal: q.length, qCorrect: correct, qWrong: q.length - correct,
    qRate: q.length ? Math.round((correct / q.length) * 100) : null,
    svgTotal: svg.length, svgDrawn: svg.filter((r) => r.svg).length,
    svgJudged: judged.length,
    svgAvgScore: scores.length ? Math.round(avg(scores)) : null,
    svgAvgStars: stars.length ? Math.round(avg(stars) * 10) / 10 : null,
    avgLatencyMs: q.length ? Math.round(avg(q.map((r) => r.latencyMs || 0))) : null,
    tokens: q.reduce((s, r) => s + (r.tokens || 0), 0) + svg.reduce((s, r) => s + (r.tokens || 0), 0),
  };
}

export function groupStats(qRows) {
  return GROUPS.map((g) => {
    const rows = qRows.filter((r) => r.group === g.key);
    const ok = rows.filter((r) => r.ok).length;
    return { key: g.key, label: g.label, total: rows.length, ok, rate: rows.length ? Math.round((ok / rows.length) * 100) : null };
  }).filter((g) => g.total > 0);
}

export function runStats(run) {
  const models = run?.models || [];
  const q = models.flatMap((m) => m.q || []);
  const svg = models.flatMap((m) => m.svg || []);
  const correct = q.filter((r) => r.ok).length;
  const judged = svg.filter((r) => r.judge);
  return {
    models: models.length,
    qTotal: q.length, qCorrect: correct,
    qRate: q.length ? Math.round((correct / q.length) * 100) : null,
    svgTotal: svg.length,
    svgAvgStars: judged.length ? Math.round(avg(judged.map((r) => r.judge.stars)) * 10) / 10 : null,
    best: models.slice().sort((a, b) => (modelStats(b).qRate ?? -1) - (modelStats(a).qRate ?? -1))[0] || null,
  };
}

// ---------------- 报告 ----------------
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csvRow = (arr) => arr.map(csvCell).join(",");

export function flattenRun(run) {
  const rows = [];
  for (const m of run?.models || []) {
    for (const r of m.q || []) {
      rows.push({
        kind: "question", provider: m.provider, model: m.model, t: r.t,
        id: r.qid, type: r.type, group: r.group, ok: r.ok, expected: r.expected,
        got: r.got, latencyMs: r.latencyMs, tokens: r.tokens, error: r.error,
        detail: String(r.raw || "").replace(/\s+/g, " ").slice(0, 500),
      });
    }
    for (const r of m.svg || []) {
      rows.push({
        kind: "svg", provider: m.provider, model: m.model, t: r.t,
        id: r.taskId, type: r.title, group: "SVG动画", ok: !!(r.judge && r.judge.score >= 60),
        expected: "按评分维度评审", got: r.judge ? `${r.judge.score}分 / ${r.judge.stars}★` : "",
        latencyMs: r.latencyMs, tokens: r.tokens, error: r.error,
        detail: r.judge ? r.judge.verdict : "",
      });
    }
  }
  return rows;
}

export function buildReportCsv(run) {
  const when = new Date(run?.ts || Date.now()).toLocaleString("zh-CN", { hour12: false });
  const lines = [
    csvRow(["模型智商检测报告", "", "", "", "", "", "", ""]),
    csvRow(["时间", when]),
    csvRow(["端点", run?.providerCount ?? "", "模型数", (run?.models || []).length]),
    "",
    csvRow(["模型成绩", "", "", "", "", "", "", ""]),
    csvRow(["端点", "模型", "学科题正确率", "答对/题数", "SVG 平均星", "平均延迟ms", "Tokens", "综合"]),
  ];
  for (const m of run?.models || []) {
    const st = modelStats(m);
    lines.push(csvRow([
      m.provider, m.model,
      st.qRate == null ? "" : st.qRate + "%", `${st.qCorrect}/${st.qTotal}`,
      st.svgAvgStars == null ? "" : st.svgAvgStars, st.avgLatencyMs ?? "", st.tokens,
      st.qRate == null ? "" : (st.svgAvgStars != null ? Math.round((st.qRate + st.svgAvgStars * 20) / 2) : st.qRate),
    ]));
  }
  lines.push("", csvRow(["逐题明细", "", "", "", "", "", "", "", ""]));
  lines.push(csvRow(["时间", "端点", "模型", "题号", "题型", "结果", "期望答案", "模型答案", "延迟ms", "Tokens", "详情"]));
  for (const r of flattenRun(run)) {
    lines.push(csvRow([
      new Date(r.t || Date.now()).toLocaleString("zh-CN", { hour12: false }),
      r.provider, r.model, r.id, r.type, r.ok ? "通过" : "未通过",
      r.expected, r.got, r.latencyMs ?? "", r.tokens ?? "", r.detail || r.error || "",
    ]));
  }
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

export function buildShareText(run) {
  const when = new Date(run?.ts || Date.now()).toLocaleString("zh-CN", { hour12: false });
  const models = (run?.models || []).slice().sort((a, b) => (modelStats(b).qRate ?? -1) - (modelStats(a).qRate ?? -1));
  const out = [`🧠 模型智商检测报告`, `时间：${when}`, `端点 ${run?.providerCount ?? 0} 个 · 模型 ${models.length} 个`, ""];
  models.forEach((m, i) => {
    const st = modelStats(m);
    out.push(`【${i + 1}】${m.model}  @ ${m.provider}`);
    out.push(`  学科题：${st.qRate == null ? "—" : st.qRate + "%"}（${st.qCorrect}/${st.qTotal}）`);
    const gs = groupStats(m.q || []).map((g) => `${g.label} ${g.ok}/${g.total}`).join(" · ");
    if (gs) out.push(`  分类：${gs}`);
    if (st.svgJudged) out.push(`  SVG 动画：${starsText(Math.round(st.svgAvgStars))} ${st.svgAvgStars}★（${st.svgJudged} 题，均分 ${st.svgAvgScore}）`);
    const fails = (m.q || []).filter((r) => !r.ok).slice(0, 3).map((r) => `${r.qid}`);
    if (fails.length) out.push(`  错题：${fails.join("、")}${(m.q || []).filter((r) => !r.ok).length > 3 ? " 等" : ""}`);
    out.push("");
  });
  out.push("—— 由「模型智商检测」生成");
  return out.join("\n");
}
