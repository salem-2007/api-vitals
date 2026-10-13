// mock-api.mjs — 本地 mock：静态服务 wwwroot + OpenAI 兼容接口（/v1/*）
// 用途：端到端测试时不打真实模型接口。行为是确定性的。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

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

export function startMock({ root, port = 0, answers = {} } = {}) {
  const state = { calls: { models: 0, chat: 0, vision: 0, followup: 0 }, rateLimited: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };

    if (url.pathname.endsWith("/models")) {
      state.calls.models++;
      return json({ data: [{ id: "mock-big" }, { id: "mock-small" }, { id: "mock-big" }] });
    }

    if (url.pathname.endsWith("/chat/completions")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const model = body.model || "";
      const msgs = body.messages || body.contents || [];
      const flat = JSON.stringify(msgs);

      // 视觉裁判（含图像）
      if (/image_url|inlineData|"image"/.test(flat)) {
        state.calls.vision++;
        return json({ choices: [{ message: { content: JSON.stringify({
          score: 76, stars: 4, verdict: "结构基本完整，细节可再丰富",
          criteria: [{ name: "整体", pass: true, comment: "能辨认主题" }],
          problems: ["局部比例略失调"], suggestions: ["补充细节"],
        }) }, finish_reason: "stop" }], usage: { completion_tokens: 120 } });
      }
      // 限流样本：第一次 429
      if (model === "mock-429" && state.rateLimited++ === 0) return json({ error: { message: "rate limited" } }, 429);
      // 补答请求
      if (/只输出最终答案/.test(flat)) { state.calls.followup++; return json({ choices: [{ message: { content: "答案：17" }, finish_reason: "stop" }], usage: { completion_tokens: 6 } }); }
      // AI 复核
      if (/只输出 JSON/.test(flat)) return json({ choices: [{ message: { content: '{"correct":true,"reason":"与标准答案等价"}' }, finish_reason: "stop" }], usage: { completion_tokens: 16 } });
      // SVG 生成
      if (/请用 SVG|精细的 SVG/.test(flat)) return json({ choices: [{ message: { content: "```svg\n" + SVG_OUT + "\n```" }, finish_reason: "stop" }], usage: { completion_tokens: 400 } });
      // 学科题：按题目给答案（mock 全部答对，便于断言 100%）
      state.calls.chat++;
      const texts = msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const mm = texts.match(/题目：([\s\S]*)$/);
      const q = mm ? mm[1].trim() : "";
      const ans = answers[q];
      const body2 = ans ? "推理过程略。\n答案：" + ans : "这道题我不会。";
      return json({ choices: [{ message: { content: body2 }, finish_reason: "stop" }], usage: { completion_tokens: 48 } });
    }

    // 静态文件
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const full = join(root, normalize(p).replace(/^([/\\])+/, ""));
    try {
      const buf = await readFile(full);
      res.writeHead(200, { "Content-Type": MIME[extname(full)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found: " + p);
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, state, close: () => server.close() }));
  });
}
