// e2e-ui.mjs — 端到端：真实浏览器 + CDP 驱动真实 UI，跑一轮完整检测并断言 DOM
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

// 题库答案表（mock 用它逐题答对）
const { QUESTIONS } = await import("../wwwroot/questions.js");
const answers = {};
for (const q of QUESTIONS) answers[q.prompt.replace(/"/g, "")] = q.answer;

const mock = await startMock({ root, answers });
console.log("mock 服务端口:", mock.port);
const ctx = await launch({ headless: true, width: 1440, height: 900 });
const page = await newPage(ctx);

try {
  const url = `http://127.0.0.1:${mock.port}/index.html?e2e=1&base=${encodeURIComponent(`http://127.0.0.1:${mock.port}/v1`)}&qs=Q1,Q5,Q12,Q14,Q17,Q20,Q22&tasks=svg-ecg,svg-clock&nmodels=1&conc=2`;
  await page.goto(url);
  console.log("已加载并触发 e2e 检测，等待完成…");
  await page.waitFor(`document.documentElement.dataset.e2e === "done"`, 120000);
  await page.eval("new Promise(r=>setTimeout(r,600))");

  // ---- 基础 DOM ----
  t("标题正确", (await page.eval("document.title")).includes("模型智商检测"));
  t("品牌在", await page.eval("!!document.querySelector('.brand-name')"));
  t("端点已渲染", (await page.eval("document.querySelectorAll('.prov').length")) >= 1);
  t("题库侧栏有 22 项", (await page.eval("document.querySelectorAll('#qList input').length")) === 22);

  // ---- 时间轴 ----
  const tl = await page.eval("document.querySelectorAll('#timeline .tl-item').length");
  t("时间轴有记录", tl > 8, "items=" + tl);
  t("时间轴含答对条目", await page.eval("[...document.querySelectorAll('#timeline .tl-kind')].some(e=>e.textContent.includes('答对'))"));
  t("时间轴含画图条目", await page.eval("[...document.querySelectorAll('#timeline .tl-kind')].some(e=>e.textContent.includes('画图'))"));
  t("时间轴含裁判条目", await page.eval("[...document.querySelectorAll('#timeline .tl-kind')].some(e=>e.textContent.includes('裁判'))"));

  // ---- 生成文件预览 ----
  t("预览区出现 SVG 图片", await page.eval("!!document.querySelector('#genbox img')"));

  // ---- 状态栏 ----
  const status = await page.eval("document.querySelector('#statusText').textContent");
  t("状态栏显示完成", /完成/.test(status), status);

  // ---- 切到成绩单 ----
  await page.eval(`document.querySelector('#tabs button[data-tab="results"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,300))");
  t("成绩单有卡片", (await page.eval("document.querySelectorAll('#view-results .card').length")) >= 1);
  const score = await page.eval("document.querySelector('#view-results .score')?.textContent");
  t("IQ 分为 100", score === "100", "score=" + score);
  t("成绩单有对比图", await page.eval("!!document.querySelector('#view-results svg[role=img]')"));
  const trs = await page.eval("document.querySelectorAll('#view-results tbody tr[data-key]').length");
  t("逐题表有 7 行", trs === 7, "rows=" + trs);
  await page.eval("document.querySelector('#view-results tbody tr[data-key]').click()");
  await page.eval("new Promise(r=>setTimeout(r,200))");
  t("展开行显示原始输出", await page.eval("!!document.querySelector('#view-results tr.detail-row pre')"));

  // ---- 切到画廊 ----
  await page.eval(`document.querySelector('#tabs button[data-tab="gallery"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,300))");
  const gcards = await page.eval("document.querySelectorAll('#view-gallery .gcard').length");
  t("画廊有 2 个作品", gcards === 2, "cards=" + gcards);
  t("画廊作品是图片", (await page.eval("document.querySelectorAll('#view-gallery .pane img').length")) >= 2);
  t("画廊显示评分", await page.eval("[...document.querySelectorAll('#view-gallery .pill')].some(e=>/\\d+ 分/.test(e.textContent))"));
  t("画廊显示星级", await page.eval("[...document.querySelectorAll('#view-gallery .stars')].some(e=>e.textContent.includes('★'))"));
  t("画廊有维度清单", (await page.eval("document.querySelectorAll('#view-gallery .crit').length")) >= 3);
  t("画廊有动画帧", (await page.eval("document.querySelectorAll('#view-gallery .frames img').length")) >= 3);

  // ---- 切到题库 ----
  await page.eval(`document.querySelector('#tabs button[data-tab="bank"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,300))");
  t("题库页列出 22 题", (await page.eval("document.querySelectorAll('#view-bank .qitem').length")) === 22 + 8);
  t("题库页显示标准答案", await page.eval("[...document.querySelectorAll('#view-bank .qitem-answer')].some(e=>e.textContent.includes('29'))"));


  // ---- 指纹鉴定 Tab ----
  await page.eval(`document.querySelector('#tabs button[data-tab="forensics"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,400))");
  t("指纹页有鉴定卡片", (await page.eval("document.querySelectorAll('#view-forensics .fp-card').length")) >= 1);
  t("7 层探针全部渲染", (await page.eval("document.querySelectorAll('#view-forensics .fp-layer').length")) === 7,
    await page.eval("document.querySelectorAll('#view-forensics .fp-layer').length"));
  t("每层有检测原理与目的", (await page.eval("document.querySelectorAll('#view-forensics .fp-why').length")) === 7);
  t("探针条目已渲染", (await page.eval("document.querySelectorAll('#view-forensics .fp-item').length")) >= 20,
    await page.eval("document.querySelectorAll('#view-forensics .fp-item').length"));
  t("显示真实性评分", await page.eval("[...document.querySelectorAll('#view-forensics .pill')].some(e=>/真实性\\s*\\d+/.test(e.textContent))"),
    await page.eval("(document.querySelector('#view-forensics .fp-card-head .pill')||{}).textContent"));
  t("数值指纹归因层在", await page.eval("[...document.querySelectorAll('#view-forensics .fp-layer-title b')].some(e=>e.textContent.includes('数值指纹'))"));
  await page.screenshot(join(shots, "e2e-forensics.png"));

  // ---- 答题历史浏览器 ----
  await page.eval(`document.querySelector('#tabs button[data-tab="monitor"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,200))");
  await page.eval(`document.querySelector('.subtab[data-sub="hist"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,300))");
  const histN = await page.eval("document.querySelectorAll('#histbox .hist-item').length");
  t("答题记录列表有内容", histN > 5, "items=" + histN);
  const c1 = await page.eval("(document.querySelector('#histbox .hist-count')||{}).textContent");
  await page.eval("document.querySelector('#histbox #histPrev')?.click()");
  await page.eval("new Promise(r=>setTimeout(r,200))");
  const c2 = await page.eval("(document.querySelector('#histbox .hist-count')||{}).textContent");
  t("上一条按钮可翻页", c1 !== c2, `${c1} → ${c2}`);
  await page.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}))");
  await page.eval("new Promise(r=>setTimeout(r,200))");
  const c3 = await page.eval("(document.querySelector('#histbox .hist-count')||{}).textContent");
  t("方向键可翻页", c3 !== c2, `${c2} → ${c3}`);
  t("详情区显示答案", await page.eval("!!document.querySelector('#histbox .hist-rows') && !!document.querySelector('#histbox pre')"));
  t("指纹条目也进历史", await page.eval("[...document.querySelectorAll('#histbox .hi-id')].some(e=>e.textContent==='FP')"),
    await page.eval("JSON.stringify([...document.querySelectorAll('#histbox .hi-id')].map(e=>e.textContent).slice(0,8))"));
  await page.screenshot(join(shots, "e2e-history.png"));

  // ---- 报告 ----
  const csv = await page.eval("window.AH && (()=>{const r=window.AH.state.runs[0];return r? (r.models[0].q.length+'|'+r.models[0].svg.length):'none';})()");
  t("runs 状态含 7 题 2 图", csv === "7|2", csv);
  t("runs 里带指纹结果", await page.eval("!!(window.AH.state.runs[0].models[0].probes)"));

  // ---- 交互：右键菜单 ----
  await page.eval(`document.querySelector('#tabs button[data-tab="results"]').click()`);
  await page.eval(`(()=>{const tr=document.querySelector('#view-results tbody tr[data-key]');const r=tr.getBoundingClientRect();tr.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+10,clientY:r.top+10}));})()`);
  await page.eval("new Promise(r=>setTimeout(r,200))");
  t("右键菜单打开", await page.eval("!!document.querySelector('.ctxmenu')"));
  await page.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");

  // ---- 截图 ----
  await page.eval(`document.querySelector('#tabs button[data-tab="monitor"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,400))");
  await page.screenshot(join(shots, "e2e-monitor.png"));
  await page.eval(`document.querySelector('#tabs button[data-tab="results"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,400))");
  await page.screenshot(join(shots, "e2e-results.png"));
  await page.eval(`document.querySelector('#tabs button[data-tab="gallery"]').click()`);
  await page.eval("new Promise(r=>setTimeout(r,400))");
  await page.screenshot(join(shots, "e2e-gallery.png"));
  console.log("截图已保存到 test/shots/");

  t("mock 收到视觉请求", mock.state.calls.vision >= 2, "vision=" + mock.state.calls.vision);
  t("mock 收到模型列表请求", mock.state.calls.models >= 1);

} catch (e) {
  fail++;
  console.log("  ✗ 端到端异常: " + (e && e.message));
  try { await page.screenshot(join(shots, "e2e-fail.png")); } catch { /* noop */ }
  try {
    const errs = await page.eval("JSON.stringify(window.__errs||[])");
    console.log("  页面错误:", errs);
  } catch { /* noop */ }
} finally {
  page.close();
  await close(ctx);
  mock.close();
}

console.log(`\n端到端结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
