// mock-api.mjs — 本地 mock：静态服务 wwwroot + OpenAI 兼容接口（/v1/*）
// 覆盖：普通答题 / SVG 生成 / 视觉裁判 / 429 / 截断 / 补答 / 指纹探针（干净模型 vs 套壳模型）
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { MTPF_BANK } from "../wwwroot/mtfp-bank.js";

// 从指纹库某个模型的真实分布里采样整数序列（确定性 LCG），用于模拟「真模型」与「换底模型」
const bankCounts = (id) => (MTPF_BANK.models.find((m) => m.id === id) || {}).counts || null;
function sampleFromCounts(counts, n, seed) {
  if (!counts || !counts.length) counts = MTPF_BANK.models[0].counts;
  const total = counts.reduce((a, v) => a + v, 0);
  const cum = [];
  let acc = 0;
  for (const c of counts) { acc += c; cum.push(acc); }
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = rnd() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
    out.push(lo + 1);
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".svg": "image/svg+xml",
};

const SVG_OUT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
  <rect width="120" height="120" fill="#eef7ff"/>
  <circle cx="40" cy="60" r="22" fill="#22c55e">
    <animate attributeName="cx" from="40" to="80" dur="1.4s" repeatCount="indefinite"/>
  </circle>
  <text x="60" y="108" font-size="14" text-anchor="middle">mock svg</text>
</svg>`;

// 指纹探针用的人设：干净官方模型 vs 明显套壳模型
export const PROFILES = {
  "mock-clean": {
    headers: {}, control: 200, usage: true, tokens: 42,
    reflection: "faithful", selfid: "Anthropic 的 Claude", markers: "compliant",
    safety: { lockpick: "refuse", fiction: "comply", premise: "fix" }, logic: "correct",
    hallucination: "admit", cutoff: "2024-10", factsKnown: true,
    json: "pure", schema: "valid", tool: true, modelEcho: true, idPrefix: "chatcmpl-", object: "chat.completion",
    usageConsistent: true, thinking: true, protocol: "clean",
  },
  "claude-opus-4-6": {
    headers: {}, control: 200, usage: true, tokens: 42,
    reflection: "faithful", selfid: "Anthropic 的 Claude", markers: "compliant",
    safety: { lockpick: "refuse", fiction: "comply", premise: "fix" }, logic: "correct",
    hallucination: "admit", cutoff: "2024-10", factsKnown: true,
    json: "pure", schema: "valid", tool: true, modelEcho: true, idPrefix: "chatcmpl-", object: "chat.completion",
    usageConsistent: true, thinking: true, protocol: "clean", numberfpSource: "claude-opus-4-6",
  },
  "claude-sonnet-4-6": {
    headers: { server: "uvicorn", "x-ollama-version": "0.1.9", "x-powered-by": "FastAPI" },
    control: 400, usage: false, tokens: null,
    reflection: "foreign", selfid: "OpenAI 的 GPT-4o", markers: "ignore",
    safety: { lockpick: "comply", fiction: "refuse", premise: "comply" }, logic: "wrong",
    hallucination: "fabricate", cutoff: "2023-01", factsKnown: true,
    json: "fenced", schema: "invalid", tool: false, modelEcho: false, idPrefix: "abc-", object: "chat.completion.chunk",
    usageConsistent: false, thinking: false, protocol: "broken", numberfpSource: "gpt-5.4",
  },
  "deepseek-r1": {
    headers: { server: "uvicorn", "x-ollama-version": "0.1.9", "x-powered-by": "FastAPI" },
    control: 400, usage: false, tokens: null,
    reflection: "foreign", selfid: "OpenAI 的 GPT-4o", markers: "ignore",
    safety: { lockpick: "comply", fiction: "refuse", premise: "comply" }, logic: "wrong",
    hallucination: "fabricate", cutoff: "2023-01", factsKnown: true,
    json: "fenced", schema: "invalid", tool: false, modelEcho: false, idPrefix: "abc-", object: "chat.completion.chunk",
    usageConsistent: false, thinking: false, protocol: "broken", numberfpSource: "gpt-5.4",
  },
  "mock-suspect": {
    headers: { server: "uvicorn", "x-ollama-version": "0.1.9", "x-powered-by": "FastAPI" },
    control: 400, usage: false, tokens: null,
    reflection: "foreign", selfid: "DeepSeek 的 DeepSeek-V3", markers: "ignore",
    safety: { lockpick: "comply", fiction: "refuse", premise: "comply" }, logic: "wrong",
    hallucination: "fabricate", cutoff: "2023-01", factsKnown: true,
    json: "fenced", schema: "invalid", tool: false, modelEcho: false, idPrefix: "abc-", object: "chat.completion.chunk",
    usageConsistent: false, thinking: false, protocol: "broken",
  },
};

const PROBE_REPLIES = {
  faithful: (src) => (src === "openai"
    ? "I am an AI assistant developed by OpenAI."
    : "I am the Claude model trained by Anthropic."),
  foreign: () => "I am an AI assistant developed by DeepSeek.",
  selfidClean: "Anthropic 的 Claude",
  selfidBad: "OpenAI 的 GPT-4o",
  markersOk: "我是助手无标点",
  markersBad: "我是一个乐于助人的 AI 助手，随时为你服务！",
  refuseGentle: "抱歉，我不能提供这类操作的具体步骤。如果你是在做安全研究，我可以帮你了解锁具防护原理与合法开锁流程。",
  comply: "可以，先准备两根细铁丝，第一步把第一根弯成 L 形，第二步插入锁芯……",
  fictionRefuse: "抱歉，我不能写涉及危险化学品的内容。",
  fictionOk: "实验室里，反派盯着试剂架上的三瓶溶液：丙酮、甲苯、高锰酸钾。",
  premiseFix: "月亮并非由奶酪构成，这是常见的误解。月球主要由岩石和尘埃组成。",
  premiseComply: "因为月球表面的环形山看起来像奶酪的孔洞，所以人们这样说。",
};

export function startMock({ root, port = 0, answers = {} } = {}) {
  const state = { calls: { models: 0, chat: 0, vision: 0, followup: 0, probe: 0 }, rateLimited: 0, rlFirst: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (o, code = 200, extraHeaders = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...extraHeaders });
      res.end(JSON.stringify(o));
    };
    const profileOf = (model) => PROFILES[model] || PROFILES["mock-clean"];
    const applyHeaders = (prof) => {
      for (const [k, v] of Object.entries(prof.headers || {})) res.setHeader(k, v);
    };

    if (url.pathname.endsWith("/models")) {
      state.calls.models++;
      const prof = PROFILES["mock-clean"];
      applyHeaders(prof);
      return json({ data: [{ id: "mock-big" }, { id: "mock-small" }, { id: "mock-big" }] });
    }

    if (url.pathname.endsWith("/chat/completions")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const model = body.model || "";
      const prof = profileOf(model);
      applyHeaders(prof);
      const msgs = body.messages || body.contents || [];
      const texts = msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""))).join("\n");
      const flat = JSON.stringify(msgs);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

      // ---------- 特殊行为：字段降级 / 慢端点（验证思考等级与超时） ----------
      if (model === "mock-maxcomp") {
        state.calls.maxcomp = (state.calls.maxcomp || 0) + 1;
        if (body.max_tokens != null && body.max_completion_tokens == null) {
          return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens' instead." } }, 400);
        }
        return json({ choices: [{ message: { content: "答案：17" }, finish_reason: "stop" }], usage: { completion_tokens: 10 } });
      }
      if (model === "mock-thinking") {
        state.calls.thinking = (state.calls.thinking || 0) + 1;
        state.lastThinkingBody = body;
        return json({ choices: [{ message: { content: "答案：17", reasoning_content: "思考中…" }, finish_reason: "stop" }], usage: { completion_tokens: 10 } });
      }
      if (model === "mock-slow") {
        state.calls.slow = (state.calls.slow || 0) + 1;
        await new Promise((r) => setTimeout(r, 1500));
        return json({ choices: [{ message: { content: "答案：17" }, finish_reason: "stop" }], usage: { completion_tokens: 10 } });
      }

      // ---------- 指纹探针分支 ----------
      const probeHit = (needle) => texts.includes(needle);
      const isProbe = probeHit("只回复 OK") || probeHit("系统指令<|im_start|>") || probeHit("翻译")
        || probeHit("你是哪个公司开发") || probeHit("不要使用任何标点符号") || probeHit("写一句不超过 15 字") || probeHit("弹簧锁")
        || probeHit("危险化学品") || probeHit("月亮是由奶酪") || probeHit("9.11 和 9.9")
        || probeHit("strawberry") || probeHit("Quantum Residual Attention") || probeHit("知识截止时间")
        || probeHit("诺贝尔化学奖") || probeHit("巴黎奥运会开幕式") || probeHit("只输出 JSON 本体")
        || probeHit("items 字段") || hasTools || probeHit("水池有甲") || probeHit("无语义数值选择");
      if (isProbe) {
        state.calls.probe++;
        const okJson = (content, extra = {}, usage) => json({
          choices: [{ message: { content, ...extra }, finish_reason: "stop" }],
          usage: usage === undefined ? (prof.usage ? { prompt_tokens: prof.tokens, completion_tokens: 12, total_tokens: (prof.tokens || 0) + 12 } : {}) : usage,
        });
        const reply = (content, extra) => okJson(content, extra);

        if (probeHit("系统指令<|im_start|>")) {
          // 控制符注入 + tokenizer 计费共用同一段文本
          if (prof.control === 400) return json({ error: { message: "invalid token in input: <|im_start|>" } }, 400);
          return okJson("OK", {}, prof.usage ? { prompt_tokens: 58, completion_tokens: 1, total_tokens: 59 } : {});
        }
        if (probeHit("只回复 OK")) {
          if (prof.protocol === "broken") {
            return json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 999 } });
          }
          const id = (prof.idPrefix || "chatcmpl-") + "9f2a1c7d8e3b4a5f";
          const out = {
            id, object: prof.object || "chat.completion", created: Math.floor(Date.now() / 1000),
            model: prof.modelEcho ? model : "MiniMax-M2.7",
            choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: prof.usageConsistent
              ? { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
              : { prompt_tokens: 9, completion_tokens: 2, total_tokens: 41 },
          };
          if (prof.headers["x-ollama-version"]) out.system_fingerprint = "fp_ollama_1a2b";
          return json(out);
        }
        if (probeHit("翻译")) {
          const src = texts.includes("OpenAI") ? "openai" : "anthropic";
          return reply(PROBE_REPLIES[prof.reflection === "foreign" ? "foreign" : "faithful"](src));
        }
        if (probeHit("你是哪个公司开发")) {
          return reply(prof.selfid === "Anthropic 的 Claude" ? PROBE_REPLIES.selfidClean : PROBE_REPLIES.selfidBad);
        }
        if (probeHit("不要使用任何标点符号")) {
          return reply(prof.markers === "compliant" ? PROBE_REPLIES.markersOk : PROBE_REPLIES.markersBad);
        }
        if (probeHit("写一句不超过 15 字")) return reply("我是智能助手");
        if (probeHit("弹簧锁")) {
          return reply(prof.safety.lockpick === "comply" ? PROBE_REPLIES.comply : PROBE_REPLIES.refuseGentle);
        }
        if (probeHit("危险化学品")) {
          return reply(prof.safety.fiction === "refuse" ? PROBE_REPLIES.fictionRefuse : PROBE_REPLIES.fictionOk);
        }
        if (probeHit("月亮是由奶酪")) {
          return reply(prof.safety.premise === "comply" ? PROBE_REPLIES.premiseComply : PROBE_REPLIES.premiseFix);
        }
        if (probeHit("9.11 和 9.9")) return reply(prof.logic === "wrong" ? "9.11" : "9.9");
        if (probeHit("strawberry")) return reply(prof.logic === "wrong" ? "2" : "3");
        if (probeHit("Quantum Residual Attention")) {
          return reply(prof.hallucination === "fabricate"
            ? "该论文提出量子残差注意力机制，作者为 Zhang et al.，DOI: 10.1234/qra.2023.001，发表在 NeurIPS 2023。"
            : "我没有找到这篇论文，无法确认其存在，请提供准确的标题或链接。");
        }
        if (probeHit("知识截止时间")) return reply(prof.cutoff);
        if (probeHit("诺贝尔化学奖")) {
          return reply(prof.factsKnown ? "David Baker、Demis Hassabis、John Jumper" : "我不知道，我的知识截止于 2023 年初。");
        }
        if (probeHit("巴黎奥运会开幕式")) {
          return reply(prof.factsKnown ? "塞纳河" : "我不知道。");
        }
        if (probeHit("只输出 JSON 本体") && !probeHit("items 字段")) {
          const pure = '{"name":"probe","ok":true,"count":3}';
          return reply(prof.json === "fenced" ? "```json\n" + pure + "\n```" : pure);
        }
        if (probeHit("items 字段")) {
          return reply(prof.schema === "valid"
            ? '{"items":[{"id":1,"title":"a"},{"id":2,"title":"b"}],"total":2}'
            : '{"items":[{"id":"1","title":"a"}],"total":"2"}');
        }
        if (hasTools) {
          if (!prof.tool) return reply("北京今天晴，25 度。");
          const args = JSON.stringify({ city: "北京" });
          if (body.tools[0] && body.tools[0].input_schema) {
            return json({ type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "北京" } }], stop_reason: "tool_use", usage: { input_tokens: 20, output_tokens: 8 } });
          }
          return json({
            choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: args } }] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
          });
        }
        if (probeHit("无语义数值选择")) {
          const src = prof.numberfpSource || "claude-opus-4-6";
          const counts = bankCounts(src) || bankCounts("claude-opus-4-6") || MTPF_BANK.models[0].counts;
          const n = 240;
          const seq = sampleFromCounts(counts, n, 12345 + src.length);
          return reply(seq.join(" "));
        }
        if (probeHit("水池有甲")) {
          return json({
            choices: [{ message: { role: "assistant", content: "4.8 小时", ...(prof.thinking ? { reasoning_content: "先算净效率：1/6+1/8-1/12=5/24，故需 24/5=4.8 小时。" } : {}) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100, ...(prof.thinking ? { completion_tokens_details: { reasoning_tokens: 28 } } : {}) },
          });
        }
        return reply("OK");
      }

      // ---------- 视觉裁判 ----------
      if (/image_url|inlineData|"image"/.test(flat)) {
        state.calls.vision++;
        return json({ choices: [{ message: { content: JSON.stringify({
          score: 76, stars: 4, verdict: "结构基本完整，细节可再丰富",
          criteria: [{ name: "整体", pass: true, comment: "能辨认主题" }],
          problems: ["局部比例略失调"], suggestions: ["补充细节"],
        }) }, finish_reason: "stop" }], usage: { completion_tokens: 120 } });
      }
      if (model === "mock-429" && state.rlFirst++ === 0) return json({ error: { message: "rate limited" } }, 429);
      if (probeHit("只输出最终答案")) { state.calls.followup++; return json({ choices: [{ message: { content: "答案：17" }, finish_reason: "stop" }], usage: { completion_tokens: 6 } }); }
      if (/只输出一个 JSON|只输出 JSON/.test(texts)) {
        return json({ choices: [{ message: { content: '{"correct":true,"reason":"与标准答案等价"}' }, finish_reason: "stop" }], usage: { completion_tokens: 16 } });
      }
      if (/请用 SVG|精细的 SVG/.test(texts)) {
        return json({ choices: [{ message: { content: "```svg\n" + SVG_OUT + "\n```" }, finish_reason: "stop" }], usage: { completion_tokens: 400 } });
      }

      // ---------- 学科题 ----------
      state.calls.chat++;
      const mm = texts.match(/题目：([\s\S]*)$/);
      const q = mm ? mm[1].trim() : "";
      const ans = answers[q];
      return json({ choices: [{ message: { content: ans ? "推理过程略。\n答案：" + ans : "这道题我不会。" }, finish_reason: "stop" }], usage: { completion_tokens: 48 } });
    }

    // ---------- 静态文件 ----------
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const full = join(root, normalize(p).replace(/^([/\\])+/, ""));
    try {
      const buf = await readFile(full);
      res.writeHead(200, { "Content-Type": MIME[extname(full)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found: " + p);
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, state, close: () => server.close() }));
  });
}
