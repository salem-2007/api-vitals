// audit.mjs — 读关键元素的计算样式（字体是否生效 / 对比度 / 浮层定位），并裁局部截图
// 自带静态服务，跨平台（WSL / Linux CI）
// 用法：node test/audit.mjs
import { writeFileSync } from "node:fs";
import {
  startStatic, launchAndAttach, waitLoaded, killBrowser, closeServer, sleep, log,
} from "./harness.mjs";

const PORT = Number(process.env.APP_PORT || 18099);
const APP = `http://127.0.0.1:${PORT}/index.html`;
const CDP = 9700 + Math.floor(Math.random() * 200);
const PROFILE_PREFIX = "edge-audit";

const server = await startStatic(PORT);
const { cdp, proc } = await launchAndAttach({
  port: CDP, url: APP, profilePrefix: PROFILE_PREFIX, extraArgs: ["--window-size=1440,900"],
});

cdp.shot = async function (path, clip) {
  const p = { format: "png" };
  if (clip) p.clip = { ...clip, scale: 1 };
  const r = await this.send("Page.captureScreenshot", p);
  writeFileSync(path, Buffer.from(r.result.data, "base64"));
  log("  shot ->", path);
};

try {
  const ok = await waitLoaded(cdp, `http://127.0.0.1:${PORT}`, { appUrl: APP });
  if (!ok) throw new Error("页面未导航到 app 源");
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
  await killBrowser(proc, PROFILE_PREFIX);
  closeServer(server);
  try { cdp?.ws.close(); } catch {}
}
