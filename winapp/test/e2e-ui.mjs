// e2e-ui.mjs — 端到端：headless 浏览器(CDP) 驱动真实 UI 跑完整检测流程
// 自带静态服务与 mock，无需手工起 http.server
// 用法：node test/e2e-ui.mjs
import { startMock } from "./mock.mjs";
import {
  startStatic, launchAndAttach, waitLoaded, killBrowser, closeServer, makeAssert, sleep, log,
} from "./harness.mjs";

const PORT = Number(process.env.APP_PORT || 18099);
const MOCK_PORT = Number(process.env.MOCK_PORT || 18990);
const APP = `http://127.0.0.1:${PORT}/index.html`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}/v1`;
const CDP = 9400 + Math.floor(Math.random() * 400); // 随机端口：避免连上残留实例
const PROFILE_PREFIX = "edge-e2e";

// ---------- 起 mock + 静态服务 ----------
const mock = await startMock(MOCK_PORT);
const server = await startStatic(PORT);

// ---------- 起 headless 浏览器 ----------
const { cdp, proc } = await launchAndAttach({ port: CDP, url: APP, profilePrefix: PROFILE_PREFIX });

let pass = 0, fail = 0;
const t = (name, ok, info = "") => {
  if (ok) { pass++; log("  PASS  " + name); }
  else { fail++; log("  FAIL  " + name + "   " + info); }
};

try {
  // 等页面真正导航到 app 源（headless 新实例初始可能是 about:blank，读 localStorage 会 SecurityError）
  const originOk = await waitLoaded(cdp, `http://127.0.0.1:${PORT}`, { appUrl: APP });
  if (!originOk) throw new Error("页面未导航到 app 源");
  log("== 已连上页面 ==");

  // 0) 配置迁移：真实旧配置里 concurN=1 + 残留 ramp 字段 → 应被纠正
  await cdp.ev(`(() => {
    localStorage.setItem("ah_settings", JSON.stringify({
      timeoutMs:60000, connectTimeoutMs:15000, latencyN:3, concurN:1, gapMs:150,
      recordLimit:300, theme:"auto",
      tests:{connect:true,latency:true,stream:true,tps:true,concur:true,ramp:true},
      rampLevels:"1,2,3,6", rampPerLevel:2
    }));
    return "old-settings";
  })()`);
  await cdp.send("Page.reload");
  await sleep(2000);
  const migrated = await cdp.ev(`(() => {
    const s = AH.state.settings;
    return { concurN: s.concurN, hasRamp: ("rampLevels" in s) || ("rampPerLevel" in s), testRamp: ("ramp" in (s.tests||{})), retries: s.retries };
  })()`);
  log("  迁移结果：" + JSON.stringify(migrated));
  t("旧配置 concurN=1 被纠正为 >=2", migrated.concurN >= 2, "concurN=" + migrated.concurN);
  t("废弃的 ramp 字段被清理", !migrated.hasRamp && !migrated.testRamp, JSON.stringify(migrated));
  t("重试次数有默认值", migrated.retries === 1, "retries=" + migrated.retries);

  // 1) 注入端点 + 参数（浏览器模式走 localStorage 回退）
  await cdp.ev(`(() => {
    const providers = [{
      id: "e2e1", name: "mock-openai", type: "openai", baseUrl: "${MOCK}",
      apiKey: "sk-test", enabled: true, models: [],
      selModels: ["mock-fast", "mock-chat"]   // 避开 mock-down(500)，专测正常路径
    }];
    const settings = {
      timeoutMs: 30000, connectTimeoutMs: 10000, latencyN: 3,
      concurN: 2, gapMs: 0,
      tests: { connect: true, latency: true, stream: true, tps: true, concur: true }
    };
    // 提示词不带 expect：并发阶梯会轮换所有提示词，而 mock 的固定回复无法同时满足多个期望值
    // （关键词校验逻辑已由 test-engine.mjs 单元测试覆盖）
    const prompts = [
      { label: "连通性问句", user: "随便说点什么", expect: null },
      { label: "短问答", user: "1+1 等于几", expect: null }
    ];
    localStorage.setItem("ah_providers", JSON.stringify(providers));
    localStorage.setItem("ah_settings", JSON.stringify(settings));
    localStorage.setItem("ah_prompts", JSON.stringify(prompts));
    localStorage.removeItem("ah_history");
    return "seeded";
  })()`);
  await cdp.send("Page.reload");
  await sleep(2500);

  const title = await cdp.ev(`document.querySelector('.brand')?.textContent || ''`);
  t("页面加载 + 品牌渲染", title.includes("API VITALS"), title);

  const provCount = await cdp.ev(`document.querySelectorAll('#providers .prov').length`);
  t("端点卡片渲染", provCount === 1, "prov=" + provCount);

  // 2) 触发快速检测
  await cdp.ev(`document.querySelector('#btnRunQuick').click(); "clicked"`);
  log("  已点击「快速检测」，等待完成…");

  let status = "", waited = 0;
  for (;;) {
    await sleep(1000); waited++;
    status = await cdp.ev(`document.querySelector('#statusText').textContent`);
    if (/^(完成|已停止|异常)/.test(status)) break;
    if (waited > 150) break;
  }
  t("检测流程跑到完成", /^完成/.test(status), status);
  log("  状态栏：" + status);

  // 3) 结果断言
  const res = await cdp.ev(`(() => {
    const rows = [...document.querySelectorAll('#view-records tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
    return {
      rowCount: rows.length,
      kinds: [...new Set(rows.map(r => r[2].replace(/\\s*聚合$/, '')))],
      pass: rows.filter(r => r[4] === '通过').length,
      fail: rows.filter(r => r[4] === '失败').length,
      hud: document.querySelector('#hudStats')?.textContent || '',
      vitals: document.querySelectorAll('#vitals .vit').length,
      lamp: document.querySelector('#providers .lamp')?.className || '',
      chartCount: document.querySelectorAll('[_echarts_instance_]').length,
      historyRows: document.querySelectorAll('#view-history tbody tr').length,
      errors: rows.slice(0, 3).map(r => r[2] + ' → ' + r[8]),
    };
  })()`);
  log("  记录行数=" + res.rowCount + " 通过=" + res.pass + " 失败=" + res.fail + " 测试类型=" + JSON.stringify(res.kinds));
  log("  前 3 条详情：" + JSON.stringify(res.errors));

  t("产生了测试记录", res.rowCount > 0, JSON.stringify(res));
  t("全部通过（mock 正常路径）", res.fail === 0 && res.pass > 0, `pass=${res.pass} fail=${res.fail}`);
  t("覆盖 5 类检测", ["连通", "对话", "延迟", "流式", "速率", "并发"].every((k) => res.kinds.includes(k)), JSON.stringify(res.kinds));
  t("端点状态灯变绿", res.lamp.includes("ok"), res.lamp);
  t("仪表盘体征卡渲染", res.vitals === 1, "vitals=" + res.vitals);
  t("图表实例已创建", res.chartCount >= 4, "charts=" + res.chartCount);
  t("历史已存档", res.historyRows >= 1, "history=" + res.historyRows);

  // 4) 并发测试（开关打开、并发 2 < mock 守卫阈值 3 → 应全部通过）
  const concurRow = await cdp.ev(`(() => {
    const tr = [...document.querySelectorAll('#view-records tbody tr')]
      .find(t => t.children[2]?.textContent.includes('并发'));
    return tr ? { detail: tr.children[8]?.textContent.trim(), lat: tr.children[5]?.textContent.trim() } : null;
  })()`);
  log("  并发详情：" + JSON.stringify(concurRow));
  t("并发测试产生了结论", !!concurRow && /并发 2 · 通过 2\/2/.test(concurRow.detail || ""), JSON.stringify(concurRow));
  t("并发给出了延迟分布", !!concurRow && /p50 \d+ \/ p95 \d+/.test(concurRow.lat || ""), concurRow && concurRow.lat);

  // 4.1) 并发开关的开关语义：关掉开关后配置页写回 tests.concur=false
  const toggleOk = await cdp.ev(`(() => {
    AH.toggleConcur(false);
    return AH.state.settings.tests.concur === false;
  })()`);
  t("并发开关可关闭", toggleOk === true, "toggled=" + toggleOk);
  await cdp.ev(`AH.toggleConcur(true); "on"`);

  // 5) 右键菜单：端点卡片 / 记录行 / 图表
  const ctx = await cdp.ev(`(() => {
    const el = document.querySelector('#providers .prov');
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }));
    const menu = document.querySelector('.ctxmenu');
    const labels = menu ? [...menu.querySelectorAll('.ctx-item')].map(b => b.textContent.replace(/\\s+/g,'').trim()) : [];
    return { shown: !!menu, title: menu?.querySelector('.ctx-title')?.textContent || '', labels };
  })()`);
  log("  端点右键菜单：" + JSON.stringify(ctx.labels));
  t("端点右键菜单弹出", ctx.shown === true, JSON.stringify(ctx));
  t("菜单含编辑/检测/获取模型/复制/删除",
    ["编辑端点…", "检测此端点"].every((k) => ctx.labels.includes(k)) &&
    ctx.labels.some((l) => l.startsWith("获取模型列表")) &&
    ctx.labels.some((l) => l.startsWith("复制BaseURL")) &&
    ctx.labels.some((l) => l.startsWith("删除端点")),
    JSON.stringify(ctx.labels));

  // 点菜单里的「获取模型列表」→ 应真的拉到 mock 的 3 个模型
  const fetched = await cdp.ev(`(async () => {
    const btn = [...document.querySelectorAll('.ctxmenu .ctx-item')].find(b => b.textContent.includes('获取模型列表'));
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    return { models: (AH.state.providers[0].models || []), menuGone: !document.querySelector('.ctxmenu') };
  })()`);
  log("  右键获取模型：" + JSON.stringify(fetched.models));
  t("右键获取模型列表生效", fetched.models.length === 3 && fetched.models.includes("mock-fast"), JSON.stringify(fetched));
  t("点菜单后菜单自动关闭", fetched.menuGone === true);

  // 记录行右键
  const recCtx = await cdp.ev(`(() => {
    const tr = document.querySelector('#view-records tbody tr');
    tr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
    const menu = document.querySelector('.ctxmenu');
    return { shown: !!menu, n: menu ? menu.querySelectorAll('.ctx-item').length : 0 };
  })()`);
  t("记录行右键菜单弹出", recCtx.shown && recCtx.n >= 5, JSON.stringify(recCtx));
  await cdp.ev(`document.dispatchEvent(new MouseEvent('click', { bubbles: true })); "close"`);

  // 6) 剪贴板识别 → 填入表单（浏览器模式：桩掉 navigator.clipboard）
  //    用 mock 地址，这样紧接着的「获取模型」能真的连上
  const clip = await cdp.ev(`(async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => "中转A\\nhttp://127.0.0.1:18990/v1/chat/completions\\nsk-testkey1234567890abcdef", writeText: async () => {} }
    });
    document.querySelector('#btnAddProv').click();
    await new Promise(r => setTimeout(r, 700));
    const tip = document.querySelector('.conn-tip');
    const txt = tip ? tip.textContent : '';
    if (tip) tip.querySelector('#ct_fill').click();
    await new Promise(r => setTimeout(r, 120));
    return {
      tipShown: !!tip, txt,
      base: document.querySelector('#f_base')?.value || '',
      key: document.querySelector('#f_key')?.value || '',
      type: document.querySelector('#f_type')?.value || '',
    };
  })()`);
  log("  剪贴板识别：" + JSON.stringify({ shown: clip.tipShown, base: clip.base, key: clip.key, type: clip.type }));
  t("添加端点时识别到剪贴板连接信息", clip.tipShown === true, JSON.stringify(clip));
  t("剪贴板 URL 已归一化到 /v1", clip.base === MOCK.replace(/\/chat\/completions$/, ""), clip.base);
  t("剪贴板 Key 已填入", clip.key === "sk-testkey1234567890abcdef", clip.key);

  // 6.1) 编辑端点 → 获取模型 → 勾选为测试模型 → 保存
  const editFlow = await cdp.ev(`(async () => {
    const modalOpen = !!document.querySelector('#f_fetch');
    document.querySelector('#f_fetch').click();          // 弹窗里点「获取模型」
    await new Promise(r => setTimeout(r, 1200));
    const rows = [...document.querySelectorAll('#f_modellist .model-row')];
    const fast = rows.find(r => r.textContent.includes('mock-fast'));
    if (!fast) return { modalOpen, rows: rows.length, err: document.querySelector('.toast')?.textContent || '', listHtml: (document.querySelector('#f_modellist')?.textContent || '').slice(0, 80) };
    fast.querySelector('input').click();                  // 勾选 mock-fast
    const cnt = document.querySelector('#f_selcount').textContent;
    const search = document.querySelector('#f_search');
    search.value = 'mock-do'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const visible = [...document.querySelectorAll('#f_modellist .model-row')].filter(r => !r.classList.contains('hidden')).length;
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.modal-actions .btn.primary').click();  // 保存
    await new Promise(r => setTimeout(r, 400));
    const p = AH.state.providers[AH.state.providers.length - 1];
    return { modalOpen, rows: rows.length, cnt, visible, saved: p.selModels || [], base: p.baseUrl, name: p.name };
  })()`);
  log("  编辑端点获取模型：" + JSON.stringify(editFlow));
  t("弹窗里「获取模型」渲染出可选模型", editFlow.rows === 3, JSON.stringify(editFlow));
  t("勾选后计数更新", editFlow.cnt === "1", "cnt=" + editFlow.cnt);
  t("模型搜索过滤可用", editFlow.visible === 1, "visible=" + editFlow.visible);
  t("勾选的模型保存进 selModels", editFlow.saved.includes("mock-fast"), JSON.stringify(editFlow.saved));
  t("保存时 BaseURL 保持端点根地址", editFlow.base === MOCK, editFlow.base);

  // 7) 报告导出内容：端点 API/Key + 成功模型 / 失败模型 + 明细
  const report = await cdp.ev(`(() => {
    const r = AH.state.runs[0];
    const csv = AH.buildReport(r);
    return { len: csv.length, csv: csv.slice(0, 4000) };
  })()`);
  const hasAll = ["端点汇总", "模型结果", "用例明细", "BaseURL", "APIKey", "成功模型", "失败模型", "失败原因"]
    .every((k) => report.csv.includes(k));
  t("报告含端点/API/Key/成功模型/失败模型/明细",
    hasAll && report.csv.includes("mock-openai") && report.csv.includes("mock-fast"), 
    "len=" + report.len);

  // 8) 筛选与 CSV 导出路径可用
  const filtered = await cdp.ev(`(() => {
    document.querySelector('#view-records .chip[data-f="fail"]').click();
    return document.querySelectorAll('#view-records tbody tr').length;
  })()`);
  t("失败筛选可用", filtered === 0, "failRows=" + filtered);
  const chips = await cdp.ev(`[...document.querySelectorAll('#view-records .chip')].map(c => c.textContent.trim())`);
  t("记录页有导出报告入口", chips.some((c) => c.includes("导出报告")), JSON.stringify(chips));
} catch (e) {
  fail++;
  log("  FAIL  端到端异常: " + e.message);
} finally {
  await killBrowser(proc, PROFILE_PREFIX);
  closeServer(server);
  try { mock.close(); } catch {}
  try { cdp.ws.close(); } catch {}
}

log("");
log(fail === 0 ? `端到端全部通过：${pass} PASS` : `${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);