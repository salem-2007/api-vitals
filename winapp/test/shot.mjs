// shot.mjs — 视觉验证：跑一次真实检测后，分别截取深色/浅色主题
// 用法：node test/shot.mjs  →  输出 /tmp/shot-dark.png, /tmp/shot-light.png, /tmp/shot-config-light.png
import { spawn, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startMock } from "./mock.mjs";

const EDGE = "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const APP = "http://127.0.0.1:18099/index.html";
const CDP = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function killOurEdge() {
  const ps = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-shot-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  await new Promise((res) => {
    execFile("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-Command", ps], () => res());
  });
}

async function waitJson(url, t = 25000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    if (Date.now() - t0 > t) throw new Error("CDP 未就绪");
    await sleep(400);
  }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }
  static async attach(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pend.has(m.id)) { c.pend.get(m.id)(m); c.pend.delete(m.id); }
    };
    return c;
  }
  send(m, p = {}) { const id = ++this.id; return new Promise((r) => { this.pend.set(id, r); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
  async ev(x) {
    const r = await this.send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.text || r.result.exceptionDetails));
    return r.result?.result?.value;
  }
  async shot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (!r.result?.data) throw new Error("截图失败");
    writeFileSync(path, Buffer.from(r.result.data, "base64"));
    log("  已保存 " + path);
  }
}

await killOurEdge();
const mock = await startMock(18990);

const profile = "C:\\Users\\Legion\\AppData\\Local\\Temp\\edge-shot-" + Date.now();
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-web-security", "--allow-running-insecure-content",
  "--window-size=1440,900",
  "--remote-debugging-port=" + CDP,
  "--user-data-dir=" + profile,
  APP,
], { stdio: "ignore" });

let cdp = null;
try {
  await waitJson(`http://127.0.0.1:${CDP}/json/version`);
  const tgt = (await waitJson(`http://127.0.0.1:${CDP}/json/list`)).find((x) => x.url.includes("index.html"));
  cdp = await Cdp.attach(tgt.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  for (let i = 0; i < 30; i++) {
    const st = await cdp.ev(`location.origin + "|" + document.readyState`).catch(() => "|loading");
    if (String(st).startsWith("http://127.0.0.1:18099") && String(st).endsWith("complete")) break;
    if (i === 3) await cdp.send("Page.navigate", { url: APP }).catch(() => {});
    await sleep(500);
  }

  // 造点真实数据：两个端点 + 一次完整检测
  const MOCK = "http://127.0.0.1:18990/v1";
  await cdp.ev(`(() => {
    localStorage.setItem("ah_providers", JSON.stringify([
      { id:"v1", name:"主力中转 · A", type:"openai", baseUrl:"${MOCK}", apiKey:"sk-abc123", enabled:true, models:["mock-fast","mock-chat"], selModels:["mock-fast","mock-chat"] },
      { id:"v2", name:"备用线路 · B", type:"anthropic", baseUrl:"http://127.0.0.1:18990", apiKey:"sk-ant-xyz", enabled:true, models:["mock-fast"], selModels:["mock-fast"] }
    ]));
    localStorage.setItem("ah_settings", JSON.stringify({
      timeoutMs:20000, connectTimeoutMs:8000, latencyN:3,
      concurN: 4, gapMs:20, theme:"dark",
      tests:{ connect:true, latency:true, stream:true, tps:true, concur:true }
    }));
    localStorage.setItem("ah_prompts", JSON.stringify([
      { label:"数学计算", user:"计算 17 × 23 + 45，只输出数字。", expect:"436" },
      { label:"短问答", user:"说点什么", expect:null }
    ]));
    localStorage.removeItem("ah_history");
    return "seeded";
  })()`);
  await cdp.send("Page.reload");
  await sleep(2500);

  log("跑一次完整检测…");
  await cdp.ev(`document.querySelector('#btnRunFull').click(); "go"`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = await cdp.ev(`document.querySelector('#statusText').textContent`);
    if (/^(完成|已停止|异常)/.test(st)) { log("  状态：" + st); break; }
  }
  await sleep(1200);
  const rows = await cdp.ev(`document.querySelectorAll('#view-records tbody tr').length`);
  const hist = await cdp.ev(`document.querySelectorAll('#view-history tbody tr').length`);
  log(`  记录 ${rows} 行 / 历史 ${hist} 条`);

  // 深色仪表盘
  await cdp.ev(`AH.setTheme('dark'); "ok"`);
  await sleep(1200);
  await cdp.shot("/tmp/shot-dark.png");

  // 浅色仪表盘
  await cdp.ev(`AH.setTheme('light'); "ok"`);
  await sleep(1400);
  await cdp.shot("/tmp/shot-light.png");

  // 浅色配置页
  await cdp.ev(`document.querySelector('.tabs button[data-tab="config"]').click(); "ok"`);
  await sleep(1000);
  await cdp.shot("/tmp/shot-config-light.png");

  // 回到深色 + 记录页（验证表格圆角容器）
  await cdp.ev(`AH.setTheme('dark'); document.querySelector('.tabs button[data-tab="records"]').click(); "ok"`);
  await sleep(1200);
  await cdp.shot("/tmp/shot-records-dark.png");

  // 端点编辑弹窗（含「获取模型」按钮与模型列表）
  await cdp.ev(`(() => {
    const p = AH.state.providers[0];
    AH.editProv(p.id);
    return "opened";
  })()`);
  await sleep(1000);
  await cdp.shot("/tmp/shot-endpoint-editor.png");
  await cdp.ev(`(document.querySelector('.modal-actions .btn')?.click(), "closed")`);

  // 纯客户端截图（不截浏览器视口外的空白）
  await cdp.ev(`AH.setTheme('dark'); document.querySelector('.tabs button[data-tab="dash"]').click(); "dash"`);
  await sleep(1000);
} catch (e) {
  log("FAIL " + e.message);
} finally {
  try { edge.kill("SIGKILL"); } catch {}
  await killOurEdge();
  try { mock.close(); } catch {}
  if (cdp) { try { cdp.ws.close(); } catch {} }
}