// cdp.mjs — 极简 CDP 客户端（零依赖）：启动本机 Chrome/Edge、发命令、截图、求值
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const CANDIDATES = [
  process.env.BROWSER_PATH,
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
  "google-chrome", "chromium", "chromium-browser", "microsoft-edge",
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) { try { if (p.includes("/") ? existsSync(p) : true) return p; } catch { /* next */ } }
  throw new Error("找不到浏览器，请设置 BROWSER_PATH");
}

const isWSL = !!process.env.WSL_DISTRO_NAME || existsSync("/mnt/c/Windows");
const winTmp = () => {
  // Windows 浏览器看不到 WSL 的 /tmp，必须落在它自己能访问的盘上
  if (!isWSL) return tmpdir();
  for (const d of ["/mnt/c/Users/Legion/AppData/Local/Temp", "/mnt/c/Windows/Temp"]) {
    if (existsSync(d)) return d;
  }
  return "/mnt/c/Temp";
};
const toNative = (p) => (isWSL && p.startsWith("/mnt/") ? p.replace(/^\/mnt\/([a-z])\//, (m, d) => d.toUpperCase() + ":\\").replace(/\//g, "\\") : p);

export const browserKind = (bin) => (/msedge|edge/i.test(bin) ? "edge" : "chrome");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

export async function launch({ headless = true, width = 1440, height = 900 } = {}) {
  const bin = findBrowser();
  const profile = mkdtempSync(join(winTmp(), "iqb-"));
  const port = 9200 + Math.floor(Math.random() * 700);
  const args = [
    headless ? "--headless=new" : "", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--disable-extensions", "--disable-background-networking", "--no-default-browser-check",
    `--remote-debugging-port=${port}`, `--user-data-dir=${toNative(profile)}`,
    `--window-size=${width},${height}`, "about:blank",
  ].filter(Boolean);
  // WSL 里直接 spawn Windows exe 不可靠，走 bash 后台启动（实测最稳）
  const sq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
  const line = [bin, ...args].map(sq).join(" ");
  let proc, ver = null;
  proc = spawn("/bin/bash", ["-c", `${line} >/dev/null 2>&1 &`], { stdio: "ignore", detached: true });
  try { proc.unref(); } catch { /* noop */ }
  for (let i = 0; i < 120; i++) {
    try { ver = await getJson(port, "/json/version"); break; } catch { await sleep(150); }
  }
  if (!ver) throw new Error("浏览器调试端口未就绪（port=" + port + "）");
  return { proc, port, profile, bin, wsUrl: ver.webSocketDebuggerUrl };
}

export async function newPage(ctx, url = "about:blank") {
  const list = await getJson(ctx.port, "/json/list");
  const target = list.find((t) => t.type === "page") || (await getJson(ctx.port, "/json/new?" + encodeURIComponent(url)));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const page = {
    ws, send,
    async goto(u) { await send("Page.enable"); await send("Page.navigate", { url: u }); await page.waitForLoad(); },
    async waitForLoad(timeout = 20000) {
      const t0 = Date.now();
      for (;;) {
        try { const r = await page.eval("document.readyState"); if (r === "complete") return; } catch { /* 还在导航 */ }
        if (Date.now() - t0 > timeout) throw new Error("页面加载超时");
        await sleep(150);
      }
    },
    async eval(expr, awaitPromise = true) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval 异常");
      return r.result ? r.result.value : undefined;
    },
    async waitFor(expr, timeout = 15000, step = 150) {
      const t0 = Date.now();
      for (;;) {
        let v = false;
        try { v = await page.eval(expr); } catch { /* 重试 */ }
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error("等待超时: " + expr);
        await sleep(step);
      }
    },
    async screenshot(path, { clip = null, full = false } = {}) {
      const opts = { format: "png" };
      if (clip) opts.clip = { ...clip, scale: 2 };
      if (full) opts.captureBeyondViewport = true;
      const { data } = await send("Page.captureScreenshot", opts);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    },
    close() { try { ws.close(); } catch { /* noop */ } },
  };
  return page;
}

export async function close(ctx) {
  // 先用 CDP 让浏览器自己退出（对 Windows 侧进程最可靠），再兜底 kill
  try {
    const ws = new WebSocket(ctx.wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(rej, 2000); });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await sleep(600);
  } catch { /* noop */ }
  try { ctx.proc.kill(); } catch { /* noop */ }
  await sleep(300);
  try { rmSync(ctx.profile, { recursive: true, force: true }); } catch { /* noop */ }
}
