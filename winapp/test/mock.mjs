// mock.mjs — OpenAI / Anthropic / Gemini / custom 四类协议的本地模拟服务器（仅用于自测）
import http from "node:http";

export function startMock(port = 18990) {
  let active = 0; // 并发守卫：超过 3 个同时请求 → 429（用于验证并发阶梯）
  let flakyCount = 0; // mock-flaky 专用：前 2 次 500，之后成功（验证重试）
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = url.pathname;
      const j = (obj, code = 200) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const isChat = /chat\/completions|messages|generateContent/.test(path);
      if (isChat) {
        active++;
        let done = false;
        const dec = () => { if (!done) { done = true; active--; } };
        res.on("finish", dec); res.on("close", dec);
        if (active > 3) return j({ error: { message: "rate limited (mock concurrency guard)" } }, 429);
      }

      // ---- OpenAI ----
      if (path === "/v1/models" && req.method === "GET") {
        return j({ data: [{ id: "mock-chat" }, { id: "mock-fast" }, { id: "mock-down" }] });
      }
      if (path === "/v1/chat/completions" && req.method === "POST") {
        let pl = {}; try { pl = JSON.parse(body); } catch {}
        if (pl.model === "mock-down") return setTimeout(() => j({ error: { message: "upstream boom" } }, 500), 45);
        // 复现真实报告里的三类失败样本
        if (pl.model === "mock-empty-reasoning") {
          // HTTP 200 但正文在 reasoning_content，content 为空（推理模型典型）
          return setTimeout(() => j({
            choices: [{ message: { role: "assistant", content: "", reasoning_content: "让我想想…水是 H2O" }, finish_reason: "stop" }],
            usage: { completion_tokens: 12 },
          }), 40);
        }
        if (pl.model === "mock-truncated") {
          // finish_reason=length，正文为空（被 max_tokens 截断）
          return setTimeout(() => j({
            choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
            usage: { completion_tokens: 200 },
          }), 40);
        }
        if (pl.model === "mock-flaky") {
          flakyCount++;
          if (flakyCount <= 2) return setTimeout(() => j({ error: { message: "temporary upstream 500" } }, 500), 30);
          return setTimeout(() => j({ choices: [{ message: { role: "assistant", content: "436" } }], usage: { completion_tokens: 5 } }), 30);
        }
        const reply = pl.model === "mock-fast" ? "436" : "这是模拟回复，用于验证协议解析。";
        if (pl.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const parts = pl.model === "mock-fast" ? ["4", "3", "6"] : ["这是", "一段", "模拟", "流式", "回复"];
          let i = 0;
          const tick = () => {
            if (i < parts.length) {
              res.write("data: " + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + "\n\n");
              setTimeout(tick, 20);
            } else {
              res.write("data: " + JSON.stringify({ choices: [], usage: { completion_tokens: 42 } }) + "\n\n");
              res.write("data: [DONE]\n\n");
              res.end();
            }
          };
          setTimeout(tick, 20);
          return;
        }
        // 延迟 45ms：保证并发阶梯测试时请求真正重叠，触发并发守卫
        return setTimeout(() => j({ choices: [{ message: { role: "assistant", content: reply } }], usage: { completion_tokens: 42, prompt_tokens: 10 }, model: pl.model }), 45);
      }

      // ---- Anthropic ----
      if (path === "/v1/messages" && req.method === "POST") {
        let pl = {}; try { pl = JSON.parse(body); } catch {}
        if (pl.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const ev = (o) => res.write("event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n");
          ev({ type: "message_start", message: { usage: { output_tokens: 0 } } });
          const parts = ["这是", "Anthropic", "流式", "回复"];
          let i = 0;
          const tick = () => {
            if (i < parts.length) {
              ev({ type: "content_block_delta", delta: { type: "text_delta", text: parts[i++] } });
              setTimeout(tick, 20);
            } else {
              ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
              ev({ type: "message_stop" });
              res.end();
            }
          };
          setTimeout(tick, 20);
          return;
        }
        return j({ content: [{ type: "text", text: "436" }], usage: { output_tokens: 7 }, model: pl.model });
      }

      // ---- Gemini ----
      if (path === "/v1beta/models" && req.method === "GET") {
        return j({ models: [{ name: "models/mock-gemini" }, { name: "models/mock-gemini-pro" }] });
      }
      if (path.includes(":generateContent")) {
        return j({ candidates: [{ content: { parts: [{ text: "436" }] }, finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 5 } });
      }
      if (path.includes(":streamGenerateContent")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const parts = ["这是", "Gemini", "流式", "回复"];
        let i = 0;
        const tick = () => {
          if (i < parts.length) {
            res.write("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: parts[i++] }] } }] }) + "\n\n");
            setTimeout(tick, 20);
          } else {
            res.write("data: " + JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 5 } }) + "\n\n");
            res.end();
          }
        };
        setTimeout(tick, 20);
        return;
      }

      // ---- custom ----
      if (path === "/health") return j({ ok: true, ts: Date.now() });

      j({ error: { message: "not found: " + path } }, 404);
    });
  });
  return new Promise((resolve) => srv.listen(port, () => resolve(srv)));
}

// 直接运行本文件时启动
const isMain = process.argv[1] && process.argv[1].endsWith("mock.mjs");
if (isMain) {
  const srv = await startMock(Number(process.argv[2] || 18990));
  console.log("mock server on http://127.0.0.1:" + srv.address().port);
}