// engine.js — API 健康检测引擎（纯逻辑层，浏览器 / Node 双端通用）
// 适配器架构：openai / anthropic / gemini / custom
// 检测维度：连通、延迟、流式、Token 速率、并发阶梯

export const DEFAULT_PROMPTS = [
  { label: "文本摘要", user: "请用一句话概括：机器学习是人工智能的一个分支，通过算法让计算机从数据中学习规律，而无需显式编程。", expect: "机器学习" },
  { label: "数学计算", user: "计算 17 × 23 + 45 的结果，只输出数字。", expect: "436" },
  { label: "JSON 生成", user: "请输出一个包含 name 和 age 两个字段的 JSON 对象，name 为 Alice，age 为 30。只输出 JSON，不要其他文字。", expect: "Alice" },
  { label: "翻译任务", user: "将以下句子翻译成英文：今天天气很好，适合出去散步。", expect: "weather" },
  { label: "逻辑推理", user: "小明比小红高，小红比小刚高，那么三人中谁最矮？只回答名字。", expect: "小刚" },
  { label: "常识问答", user: "水的化学式是什么？只输出化学式。", expect: "H2O" },
  { label: "单位换算", user: "把 2.5 千米换算成米，只输出数字。", expect: "2500" },
  { label: "分类判断", user: "判断这条评论是正面还是负面（只输出：正面 或 负面）：这家店的菜太咸了，服务也很慢。", expect: "负面" },
];

export const TYPES = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "custom", label: "自定义 HTTP" },
];

const now = () => (globalThis.performance && globalThis.performance.now ? globalThis.performance.now() : Date.now());
const dec = new TextDecoder();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rt = (x) => Math.round(x);
export const avg = (a) => (a && a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : null);
export function pct(arr, p) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return Math.round(a[i]);
}

const trimBase = (u) => String(u || "").replace(/\/+$/, "");

// 空内容归因：光说「返回空内容」没法排查，这里把最可能的三个原因点出来
function diagEmpty(j, raw) {
  const ch = j?.choices?.[0] || {};
  const msg = ch.message || {};
  const fr = ch.finish_reason || j?.stop_reason || "";
  const parts = [];
  if (msg.reasoning_content || msg.reasoning) parts.push("正文在 reasoning_content（推理模型）");
  if (msg.tool_calls?.length) parts.push("只有 tool_calls 没有正文");
  if (String(fr).toLowerCase() === "length") parts.push("被 max_tokens 截断（finish_reason=length）");
  if (String(fr).toLowerCase() === "content_filter") parts.push("被内容审核拦截");
  if (!fr) parts.push("上游无 finish_reason");
  if (j?.error) parts.push("错误体：" + String(j.error?.message || j.error).slice(0, 80));
  if (!parts.length) parts.push("响应结构非标准：" + String(raw || "").slice(0, 100));
  return "（" + parts.join("；") + "）";
}

// 关键词比对归一化：模型回「H₂O」/「Ｈ２Ｏ」/「H 2 O」都应判为命中 H2O。
// NFKC 负责全角→半角、下标→数字；再去掉空白与常见标点后做包含判断。
const normCmp = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u00a0\u200b]+/g, "")
    .replace(/[，。、；：！？""''（）【】《》,.!?;:'"()[\]{}<>_\-—…·]/g, "");

// 期望命中判定：优先归一化包含；数值类额外做「去千分位/单位」宽松匹配
export function matchExpect(content, expect) {
  if (!expect) return true;
  const c = normCmp(content);
  const e = normCmp(expect);
  if (!e) return true;
  if (c.includes(e)) return true;
  // 数值宽松：期望是数字时，允许 2,500 / 2500.0 这类写法
  if (/^\d+(\.\d+)?$/.test(e)) {
    const nums = c.match(/\d+(\.\d+)?/g) || [];
    if (nums.some((n) => n === e || Math.abs(Number(n) - Number(e)) < 1e-9)) return true;
  }
  return false;
}

function httpErr(txt, status) {
  try {
    const j = JSON.parse(txt);
    const m = (j && (j.error?.message || j.message || j.error)) || "";
    if (m) return typeof m === "string" ? m : JSON.stringify(m);
  } catch {}
  return "HTTP " + status + (txt ? " · " + String(txt).slice(0, 140) : "");
}

async function fetchWithTimeout(url, init, timeoutMs, outerSignal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch {} }, timeoutMs);
  const onAbort = () => { try { ctrl.abort(); } catch {} };
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
    return { res, cleanup, timedOut: () => timedOut };
  } catch (e) {
    cleanup();
    if (timedOut) throw new Error("请求超时（" + timeoutMs + "ms）");
    if (e && e.name === "AbortError") throw new Error("已取消");
    throw e;
  }
}

// 通用 SSE 读取：openai / anthropic / gemini(alt=sse) 都走这里
async function readSSE(res, hooks) {
  const { onDelta, extractDelta, doneCheck, usageOf } = hooks || {};
  const reader = res.body.getReader();
  const t0 = now();
  let buf = "", content = "", chunks = 0, done = false, ttft = null, bytes = 0, usage = null;
  const handleBlock = (block) => {
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") { done = true; continue; }
      let j; try { j = JSON.parse(payload); } catch { continue; }
      const d = extractDelta ? extractDelta(j) : (j?.choices?.[0]?.delta?.content);
      if (typeof d === "string" && d.length) {
        if (ttft == null) ttft = now() - t0;
        chunks++; content += d;
        if (onDelta) onDelta(d);
      }
      const u = usageOf ? usageOf(j) : j?.usage;
      if (u) usage = { ...(usage || {}), ...u };
      if (doneCheck && doneCheck(j)) done = true;
    }
  };
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    bytes += r.value ? r.value.length : 0;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      handleBlock(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) handleBlock(buf);
  return { content, chunks, done, ttftMs: ttft == null ? null : rt(ttft), usage, bytes };
}

// ---------------- 适配器 ----------------

const gb = (p) => {
  let b = trimBase(p.baseUrl || ADAPTERS.gemini.defaultBase());
  if (!/\/v\d+(beta)?$/.test(b)) b += "/v1beta";
  return b;
};

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
    buildChat(p, model, prompt, stream, maxTokens) {
      const b = {
        model,
        messages: [
          { role: "system", content: "你是一个有用的助手。请准确回答用户的问题。" },
          { role: "user", content: prompt?.user ?? "" },
        ],
        max_tokens: maxTokens || 200,
        temperature: 0,
      };
      if (stream) { b.stream = true; b.stream_options = { include_usage: true }; }
      return b;
    },
    parseChat(j) {
      return {
        content: String(j?.choices?.[0]?.message?.content ?? "").trim(),
        tokens: j?.usage?.completion_tokens ?? null,
      };
    },
    sseHooks: null, // 默认 openai 格式
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
    buildChat(p, model, prompt, stream) {
      const b = { model, max_tokens: 200, messages: [{ role: "user", content: prompt?.user ?? "" }] };
      if (stream) b.stream = true;
      return b;
    },
    parseChat(j) {
      const t = (j?.content || []).map((c) => c?.text || "").join("").trim();
      return { content: t, tokens: j?.usage?.output_tokens ?? null };
    },
    sseHooks: {
      extractDelta: (j) => (j?.type === "content_block_delta" ? (j?.delta?.text || "") : ""),
      doneCheck: (j) => j?.type === "message_stop",
      usageOf: (j) => {
        if (j?.type === "message_delta" && j?.usage) return { completion_tokens: j.usage.output_tokens ?? null };
        if (j?.type === "message_start" && j?.message?.usage) return { completion_tokens: j.message.usage.output_tokens ?? null };
        return null;
      },
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
    chatUrl: (p, model, stream) =>
      gb(p) + "/models/" + encodeURIComponent(model) + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent"),
    buildChat(p, model, prompt) {
      return {
        contents: [{ role: "user", parts: [{ text: prompt?.user ?? "" }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0 },
      };
    },
    parseChat(j) {
      const t = (j?.candidates?.[0]?.content?.parts || []).map((x) => x?.text || "").join("").trim();
      return { content: t, tokens: j?.usageMetadata?.candidatesTokenCount ?? null };
    },
    sseHooks: {
      extractDelta: (j) => ((j?.candidates?.[0]?.content?.parts || []).map((x) => x?.text || "").join("")),
      doneCheck: (j) => {
        const fr = j?.candidates?.[0]?.finishReason;
        return !!fr && fr !== "FINISH_REASON_UNSPECIFIED";
      },
      usageOf: (j) => (j?.usageMetadata ? { completion_tokens: j.usageMetadata.candidatesTokenCount ?? null } : null),
    },
  },

  custom: {
    label: "自定义 HTTP",
    defaultBase: () => "https://example.com/health",
    headers() { return {}; },
    async ping(p, opts = {}) {
      const { timeoutMs = 15000, signal } = opts;
      const method = String(p.method || "GET").toUpperCase();
      const h = {};
      if (p.apiKey) h[p.keyHeader || "Authorization"] = (p.keyPrefix != null ? p.keyPrefix : "Bearer ") + p.apiKey;
      if (p.headers && typeof p.headers === "object") Object.assign(h, p.headers);
      const init = { method, headers: h };
      if (method !== "GET" && method !== "HEAD" && p.body) {
        init.body = typeof p.body === "string" ? p.body : JSON.stringify(p.body);
        if (!h["Content-Type"]) h["Content-Type"] = "application/json";
      }
      const t0 = now();
      const { res, cleanup } = await fetchWithTimeout(p.baseUrl, init, timeoutMs, signal);
      try {
        const txt = await res.text().catch(() => "");
        const latencyMs = rt(now() - t0);
        const ok = res.status >= 200 && res.status < 400;
        return { ok, status: res.status, latencyMs, preview: String(txt).slice(0, 200), error: ok ? "" : httpErr(txt, res.status) };
      } finally { cleanup(); }
    },
  },
};

export const adapterOf = (p) => ADAPTERS[p?.type] || ADAPTERS.openai;

// ---------------- 检测操作 ----------------

export async function listModels(p, opts = {}) {
  const a = adapterOf(p);
  const { timeoutMs = 15000, signal } = opts;
  if (!a.modelsUrl) throw new Error("该类型不支持模型列表");
  const { res, cleanup } = await fetchWithTimeout(a.modelsUrl(p), { method: "GET", headers: a.headers(p, false) }, timeoutMs, signal);
  try {
    const txt = await res.text();
    if (!res.ok) { const e = new Error(httpErr(txt, res.status)); e.status = res.status; throw e; }
    let j; try { j = JSON.parse(txt); } catch { throw new Error("模型列表响应非 JSON"); }
    return [...new Set(a.parseModels(j))].sort();
  } finally { cleanup(); }
}

// 连通测试
export async function opConnectivity(p, opts = {}) {
  const a = adapterOf(p);
  const t0 = now();
  if (p.type === "custom") {
    try {
      const r = await a.ping(p, opts);
      return { provider: p.name, kind: "connect", models: [], t: Date.now(), ...r };
    } catch (e) {
      return { provider: p.name, kind: "connect", ok: false, status: 0, latencyMs: rt(now() - t0), models: [], error: String(e?.message || e), preview: "", t: Date.now() };
    }
  }
  try {
    const models = await listModels(p, opts);
    return { provider: p.name, kind: "connect", ok: true, status: 200, latencyMs: rt(now() - t0), models, error: "", preview: models.slice(0, 3).join(", "), t: Date.now() };
  } catch (e) {
    return { provider: p.name, kind: "connect", ok: false, status: e.status || 0, latencyMs: rt(now() - t0), models: [], error: String(e?.message || e), preview: "", t: Date.now() };
  }
}

// 对话测试（流式 / 非流式通用）
export async function opChat(p, model, prompt, opts = {}) {
  const a = adapterOf(p);
  const { stream = false, timeoutMs = 60000, signal, onDelta, kind, maxTokens } = opts;
  const t0 = now();
  const row = {
    provider: p?.name || "", type: p?.type || "", model, label: prompt?.label ?? "",
    kind: kind || (stream ? "stream" : "chat"), stream,
    ok: false, status: 0, error: "", latencyMs: 0, ttftMs: null,
    tokens: null, chars: 0, tps: null, unit: null, preview: "", streamInfo: null, t: Date.now(),
  };
  try {
    const url = a.chatUrl(p, model, stream);
    if (!url) throw new Error("该类型不支持对话测试");
    const body = a.buildChat(p, model, prompt, stream, maxTokens);
    const init = { method: "POST", headers: a.headers(p, true), body: JSON.stringify(body) };
    const { res, cleanup } = await fetchWithTimeout(url, init, timeoutMs, signal);
    try {
      row.status = res.status;
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const e = new Error(httpErr(txt, res.status)); e.status = res.status; throw e;
      }
      if (stream) {
        const hooks = a.sseHooks || {};
        const s = await readSSE(res, { onDelta, extractDelta: hooks.extractDelta, doneCheck: hooks.doneCheck, usageOf: hooks.usageOf });
        row.latencyMs = rt(now() - t0);
        row.ttftMs = s.ttftMs;
        row.tokens = (s.usage && s.usage.completion_tokens != null) ? s.usage.completion_tokens : s.chunks;
        row.chars = s.content.length;
        row.streamInfo = { chunks: s.chunks, done: !!s.done, usage: !!s.usage, bytes: s.bytes };
        row.preview = s.content.slice(0, 80);
        if (!s.content) {
          row.error = "流式返回空内容";
        } else {
          if (!matchExpect(s.content, prompt?.expect)) {
            row.error = "缺少关键词「" + prompt.expect + "」";
          } else {
            row.ok = true;
            if (!s.done) row.error = "未见结束标记（内容正常）";
          }
        }
      } else {
        const txt = await res.text();
        row.latencyMs = rt(now() - t0);
        row.ttftMs = row.latencyMs;
        let j; try { j = JSON.parse(txt); } catch { throw new Error("响应非 JSON: " + String(txt).slice(0, 120)); }
        const pr = a.parseChat(j);
        row.tokens = pr.tokens;
        row.chars = pr.content.length;
        row.preview = pr.content.slice(0, 80);
        if (!pr.content) {
          // 空内容但 HTTP 200：多半是 reasoning 模型把正文放进了 reasoning_content，
          // 或 finish_reason=length 被 max_tokens 截断，或上游返回了非标准结构。
          const raw = JSON.stringify(j);
          const d = diagEmpty(j, raw);
          row.error = "模型返回空内容" + d;
          row.preview = raw.slice(0, 200);
          // 截断 / 空正文这类多为偶发或额度不足，值得加大 max_tokens 重试一次
          row.retryable = /截断|无 finish_reason|非标准/.test(d);
        } else {
          if (!matchExpect(pr.content, prompt?.expect)) row.error = "缺少关键词「" + prompt.expect + "」";
          row.ok = !row.error;
        }
        row.content = pr.content.slice(0, 4000);
      }
      const secs = row.latencyMs / 1000;
      if (secs > 0) {
        if (row.tokens) { row.tps = Math.round((row.tokens / secs) * 10) / 10; row.unit = "tok/s"; }
        else if (row.chars) { row.tps = Math.round((row.chars / secs) * 10) / 10; row.unit = "char/s"; }
      }
    } finally { cleanup(); }
  } catch (e) {
    row.latencyMs = rt(now() - t0);
    row.error = String(e?.message || e);
    row.status = row.status || (e?.status || 0);
    row.ok = false;
    // 5xx / 429 / 网络抖动可重试；4xx 参数或鉴权错误重试无意义
    const st = row.status || 0;
    row.retryable = st === 0 || st === 429 || st >= 500;
  }
  return row;
}

// 带重试的对话测试：只重试「可重试」类失败（5xx/429/网络抖动/被截断），
// 关键词不符这类是模型的真实回答问题，重试无意义。
export async function opChatRetry(p, model, prompt, opts = {}) {
  const { retries = 1, ...rest } = opts;
  let row = await opChat(p, model, prompt, rest);
  let attempt = 0;
  while (!row.ok && row.retryable && attempt < retries && !rest.signal?.aborted) {
    attempt++;
    await sleep(400 * attempt);            // 退避一下再打
    const bigger = /截断/.test(row.error || "") ? { maxTokens: 800 } : {};
    const again = await opChat(p, model, prompt, { ...rest, ...bigger });
    again.retried = attempt;
    // 重试成功就采用新结果；仍失败但新结果更"真实"（有关键词）也采用
    if (again.ok || !again.retryable) { row = again; break; }
    row = again;
  }
  return row;
}

// 延迟测试：非流式采样 n 次（单次失败自动重试，避免网络抖动污染 p50/p95）
export async function opLatency(p, model, prompt, opts = {}) {
  const { n = 3, timeoutMs = 60000, signal, onRow, retries = 1 } = opts;
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (signal?.aborted) break;
    const r = await opChatRetry(p, model, prompt, { timeoutMs, signal, retries });
    rows.push(r);
    if (onRow) onRow(r);
  }
  const okRows = rows.filter((r) => r.ok);
  const lat = okRows.map((r) => r.latencyMs);
  return {
    provider: p.name, kind: "latency", model,
    samples: rows.length, ok: okRows.length,
    avgMs: avg(lat), p50: pct(lat, 0.5), p95: pct(lat, 0.95),
    rows, t: Date.now(),
  };
}

// 并发测试：固定并发数，一次性并行发起 N 个请求，观察成功率 / 延迟 / 吞吐
// 要点：并发生效只取决于「同时在飞的请求数」，靠 worker 数量控制，
// 与 prompts 长度无关（早期版本会把 prompts 轮完才停，导致并发数被用例数限制）。
export async function opConcurrent(p, model, prompts, opts = {}) {
  const { n = 4, timeoutMs = 60000, signal, onProgress } = opts;
  const total = Math.max(1, Math.min(64, n));
  const list = (prompts && prompts.length) ? prompts : [{ label: "并发", user: "计算 1+1 的结果，只输出数字。", expect: "2" }];
  const lat = [];
  const errs = [];
  let ok = 0, fail = 0, finished = 0;
  const t0 = now();

  // 每批同时放 total 个请求，批内并发度 = total
  const jobs = Array.from({ length: total }, (_, k) => k);
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const k = jobs.shift();
      if (k === undefined) return;
      const r = await opChatRetry(p, model, list[k % list.length], { timeoutMs, signal, retries: 1 });
      if (r.ok) { ok++; lat.push(r.latencyMs); } else { fail++; errs.push(r.error || "失败"); }
      finished++;
      if (onProgress) onProgress({ finished, total });
    }
  };
  await Promise.all(Array.from({ length: total }, () => worker()));
  const wallMs = rt(now() - t0);
  const done = ok + fail;
  return {
    provider: p.name, model, concurrency: total,
    ok, fail,
    avgMs: avg(lat), p50: pct(lat, 0.5), p95: pct(lat, 0.95),
    wallMs,
    throughput: wallMs > 0 ? Math.round((done / (wallMs / 1000)) * 10) / 10 : null, // 请求/秒
    errors: [...new Set(errs)].slice(0, 3),
  };
}

// 并发结论：全部成功 = 该并发档位可用
export function concurrencyVerdict(res) {
  if (!res) return null;
  const total = res.ok + res.fail;
  if (!total) return null;
  const rate = res.ok / total;
  return {
    supported: res.fail === 0,
    rate,
    level: res.concurrency,
    p95: res.p95,
    throughput: res.throughput,
  };
}