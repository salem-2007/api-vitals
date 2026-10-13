// audit.mjs — UI 审计：对比度 / 焦点可见 / 减弱动效 / 横向滚动 / 触达尺寸 / 图表可访问性
// 依据 ui-ux-pro-max 预交付清单（contrast-text-4.5、visible-focus、reduced-motion、web-target-size）
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { startMock } from "./mock-api.mjs";
import { launch, newPage, close } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "wwwroot");
const shots = join(here, "shots");
mkdirSync(shots, { recursive: true });

let pass = 0, fail = 0;
const t = (n, c, info = "") => { if (c) pass++; else { fail++; console.log("  ✗ " + n + (info ? "  → " + info : "")); } };

const { QUESTIONS } = await import("../wwwroot/questions.js");
const answers = {};
for (const q of QUESTIONS) answers[q.prompt] = q.answer;

const mock = await startMock({ root, answers });
const ctx = await launch({ headless: true, width: 1440, height: 900 });
const page = await newPage(ctx);

// 在页面里注入对比度计算工具
const AUDIT_JS = `
window.__contrast = () => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.6) return c.rgb;
      node = node.parentElement;
    }
    return [15, 23, 42];
  };
  const ratio = (fg, bg) => {
    const l1 = lum(fg), l2 = lum(bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const probe = (sel, label) => {
    const el = document.querySelector(sel);
    if (!el) return { label, missing: true };
    const fg = parse(getComputedStyle(el).color);
    const bg = bgOf(el);
    return { label, sel, size: parseFloat(getComputedStyle(el).fontSize), ratio: fg ? ratio(fg.rgb, bg) : null };
  };
  return [
    probe(".statusbar .run", "状态栏文字"),
    probe("#view-results .card-row span", "卡片标签"),
    probe("#view-results .sub", "次要文字"),
    probe("#view-monitor .tl-text", "时间轴正文"),
    probe("#view-monitor .tl-sub", "时间轴次要"),
    probe("th", "表头"),
    probe("#qList label span:last-child", "题库条目"),
    probe(".btn.tiny", "小按钮"),
    probe(".badge", "徽标"),
  ];
};
window.__hscroll = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;
window.__smallTargets = () => [...document.querySelectorAll("button")]
  .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 24 || r.width < 24); })
  .map((b) => (b.textContent || "").trim().slice(0, 12) + " " + Math.round(b.getBoundingClientRect().width) + "x" + Math.round(b.getBoundingClientRect().height));
`;

try {
  const url = `http://127.0.0.1:${mock.port}/index.html?e2e=1&base=${encodeURIComponent(`http://127.0.0.1:${mock.port}/v1`)}&qs=Q1,Q12,Q22&tasks=svg-ecg&nmodels=1&conc=1`;
  await page.goto(url);
  await page.waitFor(`document.documentElement.dataset.e2e === "done"`, 90000);
  await page.eval(AUDIT_JS);
  // 打开成绩单，保证被审计的元素都在
  await page.eval(`document.querySelector('#tabs button[data-tab="results"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,300))");

  for (const theme of ["dark", "light"]) {
    await page.eval(`document.documentElement.dataset.theme = "${theme}"; window.AH.state.settings.theme="${theme}";`);
    await page.eval("new Promise(r=>setTimeout(r,200))");
    const rows = await page.eval("window.__contrast()");
    for (const r of rows) {
      if (r.missing) { t(`${theme} · ${r.label} 存在`, false, "元素缺失 " + r.sel); continue; }
      const min = r.size >= 24 || (r.size >= 18.66 && false) ? 3 : 4.5;
      t(`${theme} · ${r.label} 对比度 ≥ ${min}`, r.ratio >= min, `ratio=${r.ratio} size=${r.size}px`);
    }
  }

  // 焦点可见（用真实 Tab 键，才能触发 :focus-visible）
  await page.send("Runtime.evaluate", { expression: "document.body.focus()" });
  for (let i = 0; i < 3; i++) {
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 9, key: "Tab" });
  }
  const focus = await page.eval(`(()=>{const el=document.activeElement;const s=getComputedStyle(el);return {tag:el.tagName,text:(el.textContent||'').trim().slice(0,10),w:s.outlineWidth,style:s.outlineStyle};})()`);
  t("键盘焦点有可见外框", focus.style !== "none" && parseFloat(focus.w) >= 2, JSON.stringify(focus));

  // 减弱动效
  await ctx.proc && null;
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const rm = await page.eval(`(()=>{const el=document.querySelector('.lamp.busy')||document.querySelector('.btn');const s=getComputedStyle(el);return s.animationDuration+"|"+s.transitionDuration;})()`);
  const rmOk = rm.split("|").every((d) => parseFloat(d) <= 0.001);
  t("减弱动效生效", rmOk, rm);
  await page.send("Emulation.setEmulatedMedia", { features: [] });

  // 横向滚动（两种宽度）
  for (const w of [1440, 1024, 768]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.eval("new Promise(r=>setTimeout(r,250))");
    const hs = await page.eval("window.__hscroll()");
    t(`无横向滚动 @${w}px`, hs <= 1, "overflow=" + hs);
  }
  await page.send("Emulation.clearDeviceMetricsOverride");

  // 触达尺寸
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const small = await page.eval("window.__smallTargets()");
  t("按钮触达尺寸 ≥24px", small.length === 0, small.slice(0, 5).join(" | "));
  await page.send("Emulation.clearDeviceMetricsOverride");

  // 图表可访问性
  const chart = await page.eval(`(()=>{const s=document.querySelector('#view-results svg[role=img]');return s?{label:s.getAttribute('aria-label'),w:s.getBoundingClientRect().width}:null;})()`);
  t("图表有 aria-label", chart && chart.label && chart.w > 100, JSON.stringify(chart));

  // 键盘可达：Tab 能到主按钮
  const tabbable = await page.eval(`[...document.querySelectorAll('button, input, select, textarea, [tabindex]')].filter(e=>!e.disabled && e.offsetParent!==null).length`);
  t("可键盘聚焦控件充足", tabbable > 20, "count=" + tabbable);

  // 截图留档
  await page.screenshot(join(shots, "audit-dark.png"));
  await page.eval(`document.documentElement.dataset.theme = "light"`);
  await page.eval("new Promise(r=>setTimeout(r,300))");
  await page.screenshot(join(shots, "audit-light.png"));
} catch (e) {
  fail++;
  console.log("  ✗ 审计异常: " + (e && e.message));
  try { await page.screenshot(join(shots, "audit-fail.png")); } catch { /* noop */ }
} finally {
  page.close();
  await close(ctx);
  mock.close();
}

console.log(`\n审计结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
