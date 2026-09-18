// audit.mjs — 用 CDP 读关键元素的计算样式（验证白底/字体/对比度），并截取顶部区域
import { spawn, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

const EDGE = "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const APP = "http://127.0.0.1:18099/index.html";
const CDP = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = "C:\\\\Users\\\\Legion\\\\AppData\\\\Local\\\\Temp\\\\edge-audit-" + Date.now();
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--window-size=1440,900", "--remote-debugging-port=" + CDP,
  "--user-data-dir=" + profile, APP,
], { stdio: "ignore" });

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
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && c.pend.has(m.id)) { c.pend.get(m.id)(m); c.pend.delete(m.id); } };
    return c;
  }
  send(m, p = {}) { const id = ++this.id; return new Promise((r) => { this.pend.set(id, r); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
  async ev(x) {
    const r = await this.send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.text || r.result.exceptionDetails));
    return r.result?.result?.value;
  }
  async shot(path, clip) {
    const p = { format: "png" };
    if (clip) p.clip = { ...clip, scale: 1 };
    const r = await this.send("Page.captureScreenshot", p);
    writeFileSync(path, Buffer.from(r.result.data, "base64"));
    console.log("  shot ->", path);
  }
}

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
  // 等字体加载完（font-display: swap）
  await cdp.ev(`document.fonts.ready.then(() => true)`);
  await sleep(1200);

  // 先种一个端点，才能测右键菜单；并强制深色主题
  await cdp.ev(`(() => {
    localStorage.setItem("ah_providers", JSON.stringify([
      { id:"a1", name:"主力中转", type:"openai", baseUrl:"https://api.example.com/v1", apiKey:"sk-xxxxxxxxxxxx", enabled:true, models:["m1","m2"], selModels:["m1"] }
    ]));
    localStorage.setItem("ah_settings", JSON.stringify({ timeoutMs:20000, timeoutMs2:0, connectTimeoutMs:8000, latencyN:3, concurN:2, gapMs:0, theme:"dark", recordLimit:300, tests:{connect:true,latency:true,stream:true,tps:true,concur:false} }));
    localStorage.removeItem("ah_history");
    return "seeded";
  })()`);
  await cdp.send("Page.reload");
  await cdp.ev(`document.fonts.ready.then(() => true)`);
  await sleep(2000);
  await cdp.ev(`AH && AH.setTheme && AH.setTheme('dark'); "dark"`);
  await sleep(800);

  const audit = await cdp.ev(`(() => {
    // 颜色统一成 rgb() 再算 WCAG 对比度
    const norm = (c) => { const d = document.createElement('div'); d.style.color = c; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; };
    const lum = (rgb) => { const m = String(rgb).match(/[\\d.]+/g); if (!m || m.length < 3) return null;
      const f = m.slice(0,3).map(Number).map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]; };
    const ratio = (a,b) => { const l1=lum(a), l2=lum(b); if (l1==null||l2==null) return null;
      return +(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)).toFixed(2)); };
    const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x:r.x|0, y:r.y|0, w:r.width|0, h:r.height|0 }; };
    const bgVar = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const textCol = getComputedStyle(document.querySelector('.vit .vrow b') || document.body).color;
    const mutedCol = getComputedStyle(document.querySelector('.vit .vrow span') || document.body).color;
    return {
      theme: document.documentElement.dataset.theme,
      fontFamilyBody: cs('body','fontFamily'),
      fontReady: document.fonts.status,
      faces: [...document.fonts].map(f => f.family + '/' + f.status),
      // 宽度差异法：内置字体是否真的参与了渲染
      widthTest: (() => { const mk = (ff) => { const d=document.createElement('span');
        d.style.cssText='position:absolute;visibility:hidden;font-size:40px;white-space:nowrap;font-family:'+ff;
        d.textContent='测试字体 ABC 123'; document.body.appendChild(d);
        const w=d.getBoundingClientRect().width; d.remove(); return +w.toFixed(1); };
        return { app: mk('"App Round"'), missing: mk('"NoSuchFontXYZ"'), sys: mk('system-ui') }; })(),
      ecgBg: cs('.ecg','backgroundColor'),
      ecgBorder: cs('.ecg','borderTopWidth') + ' ' + cs('.ecg','borderTopColor'),
      ecgBox: box('.ecg'),
      hudAfterContent: getComputedStyle(document.querySelector('.hud'),'::after').content,
      bodyText: getComputedStyle(document.body).color,
      textCol, mutedCol,
      contrast: { textVsBg: ratio(textCol, norm(bgVar)), mutedVsBg: ratio(mutedCol, norm(bgVar)) },
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  console.log(JSON.stringify(audit, null, 2));

  // 弹右键菜单，检查定位方式（必须是 fixed）
  const menu = await cdp.ev(`(() => {
    const el = document.querySelector('#providers .prov');
    if (!el) return { err: 'no prov' };
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 300 }));
    const m = document.querySelector('.ctxmenu');
    if (!m) return { err: 'no menu' };
    const r = m.getBoundingClientRect();
    return { position: getComputedStyle(m).position, x: r.x|0, y: r.y|0, w: r.width|0, h: r.height|0,
             left: getComputedStyle(m).left, top: getComputedStyle(m).top, items: m.querySelectorAll('.ctx-item').length };
  })()`);
  console.log("MENU " + JSON.stringify(menu));
  if (menu && !menu.err) {
    await cdp.shot("/tmp/audit-menu.png", { x: Math.max(0, menu.x - 40), y: Math.max(0, menu.y - 40), width: menu.w + 80, height: menu.h + 80 });
  }

  const eb = audit.ecgBox;
  if (eb) await cdp.shot("/tmp/audit-ecg.png", { x: Math.max(0, eb.x - 30), y: 0, width: Math.min(1400, eb.w + 380), height: 80 });
} catch (e) {
  console.log("FAIL " + e.message);
} finally {
  try { edge.kill("SIGKILL"); } catch {}
  try { cdp?.ws.close(); } catch {}
  await new Promise((res) => execFile("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile","-Command","$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-audit-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
    () => res()));
}
