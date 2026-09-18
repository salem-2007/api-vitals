// harness.mjs — 跨平台测试底座（WSL / Linux CI 通用）
// 提供：浏览器探测、静态服务、CDP 客户端、进程清理
// 目标：测试脚本不再硬编码平台路径，也不再依赖外部手工起服务
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import os from "node:os";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(...a);

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = normalize(join(__dirname, ".."));
export const WWWROOT = join(ROOT, "wwwroot");

export const IS_WSL = process.platform === "linux" && /microsoft/i.test(os.release());

// ---------------- 浏览器探测 ----------------
// 优先环境变量，其次按平台常见路径；找不到就抛清晰错误
export function findBrowser() {
  const candidates = [];
  if (process.env.BROWSER_PATH) candidates.push(process.env.BROWSER_PATH);

  if (IS_WSL) {
    candidates.push(
      "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
    );
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    "未找到 Chromium 系浏览器。请设置 BROWSER_PATH 环境变量，或安装 Chrome/Edge/Chromium。\n" +
    "已尝试：\n  " + candidates.join("\n  ")
  );
}

// ---------------- 用户数据目录 ----------------
export function tmpProfile(prefix) {
  if (IS_WSL) {
    // Windows 侧浏览器要的是 Windows 路径
    const winUser = process.env.WIN_USER || "Legion";
    return `C:\\Users\\${winUser}\\AppData\\Local\\Temp\\${prefix}-${Date.now()}`;
  }
  return join(os.tmpdir(), `${prefix}-${Date.now()}`);
}

// ---------------- 静态服务（替代手工 python -m http.server）----------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

export function startStatic(port = 18099, root = WWWROOT) {
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p === "/") p = "/index.html";
      // 防目录穿越
      const full = normalize(join(root, p));
      if (!full.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
      const st = await stat(full);
      if (!st.isFile()) { res.writeHead(404); res.end("not found"); return; }
      const body = await readFile(full);
      res.writeHead(200, {
        "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

// ---------------- CDP ----------------
export async function waitJson(url, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("CDP 未就绪: " + url);
    await sleep(400);
  }
}

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }

  // CDP 走 WebSocket。Node 22+ 内置全局 WebSocket；老版本回退到 ws 包（若装了）
  static async resolveWebSocket() {
    if (typeof WebSocket !== "undefined") return WebSocket;
    try {
      const m = await import("ws");
      if (m?.default || m?.WebSocket) return m.default || m.WebSocket;
    } catch {}
    throw new Error(
      "当前 Node 没有 WebSocket（Node 22+ 才内置）。请升级 Node，或在 winapp 下执行 npm i ws。\n" +
      "当前版本：" + process.version
    );
  }

  static async attach(wsUrl) {
    const WS = await Cdp.resolveWebSocket();
    const ws = new WS(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pend.has(m.id)) { c.pend.get(m.id)(m); c.pend.delete(m.id); }
    };
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pend.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }

  async ev(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error("JS 异常: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    }
    return r.result?.result?.value;
  }
}

// ---------------- 启动浏览器并连上页面 ----------------
export async function launchAndAttach({ port, url, profilePrefix, extraArgs = [] }) {
  const browser = findBrowser();
  const profile = tmpProfile(profilePrefix);
  const proc = spawn(browser, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-dev-shm-usage",              // CI 容器 /dev/shm 小，必须加
    "--no-sandbox",                         // CI 容器（root）下必需
    "--disable-web-security", "--allow-running-insecure-content",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    ...extraArgs,
    url,
  ], { stdio: "ignore" });

  let exited = null;
  proc.on("exit", (code) => { exited = code; });

  try {
    await waitJson(`http://127.0.0.1:${port}/json/version`, 30000);
  } catch (e) {
    throw new Error(
      `浏览器未能启动 CDP（${browser}）。退出码=${exited}。\n` +
      `原始错误：${e.message}\n` +
      `提示：容器环境通常需要 --no-sandbox；也确认浏览器可执行且未被策略阻止。`
    );
  }

  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    const list = await waitJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    page = list.find((x) => x.type === "page" && x.url.includes("index.html"));
    if (!page) await sleep(400);
  }
  if (!page) throw new Error("未找到页面目标（浏览器已起但没打开目标页）");

  const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return { cdp, proc, browser, profile };
}

// 等页面真正导航到目标源并加载完成
export async function waitLoaded(cdp, origin, { appUrl, tries = 30 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = await cdp.ev(`location.origin + "|" + document.readyState`).catch(() => "|loading");
    if (String(st).startsWith(origin) && String(st).endsWith("complete")) return true;
    if (i === 3 && appUrl) await cdp.send("Page.navigate", { url: appUrl }).catch(() => {});
    await sleep(500);
  }
  return false;
}

// ---------------- 清理 ----------------
// WSL：浏览器是 Windows 进程，node 杀不掉，按 profile 前缀用 PowerShell 清
// Linux/macOS：直接 kill 自己启动的进程
export async function killBrowser(proc, profilePrefix) {
  try { proc?.kill("SIGKILL"); } catch {}
  if (!IS_WSL) return;
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" |",
    `Where-Object { $_.CommandLine -like '*${profilePrefix}-*' } |`,
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  ].join(" ");
  await new Promise((res) => {
    execFile("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      ["-NoProfile", "-Command", ps], () => res());
  });
}

export function closeServer(srv) {
  try { srv?.close(); } catch {}
}

// ---------------- 极简断言 ----------------
export function makeAssert() {
  const state = { pass: 0, fail: 0 };
  const t = (name, ok, info = "") => {
    if (ok) { state.pass++; log("  PASS  " + name); }
    else { state.fail++; log("  FAIL  " + name + "   " + info); }
  };
  const done = (label) => {
    log("");
    log(state.fail === 0
      ? `${label}全部通过：${state.pass} PASS`
      : `${label}${state.pass} PASS / ${state.fail} FAIL`);
    process.exit(state.fail ? 1 : 0);
  };
  return { t, done, state };
}
