// shot.mjs — 视觉验证：跑一次真实检测后，截取深/浅主题与端点编辑弹窗
// 自带静态服务与 mock，跨平台（WSL / Linux CI）
// 用法：node test/shot.mjs [输出目录]  默认 /tmp
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startMock } from "./mock.mjs";
import {
  startStatic, launchAndAttach, waitLoaded, killBrowser, closeServer, sleep, log,
} from "./harness.mjs";

const PORT = Number(process.env.APP_PORT || 18099);
const MOCK_PORT = Number(process.env.MOCK_PORT || 18990);
const OUT = process.argv[2] || process.env.SHOT_DIR || "/tmp";
const APP = `http://127.0.0.1:${PORT}/index.html`;
const CDP = 9800 + Math.floor(Math.random() * 150);
const PROFILE_PREFIX = "edge-shot";

mkdirSync(OUT, { recursive: true });

const mock = await startMock(MOCK_PORT);
const server = await startStatic(PORT);
const { cdp, proc } = await launchAndAttach({
  port: CDP, url: APP, profilePrefix: PROFILE_PREFIX, extraArgs: ["--window-size=1440,900"],
});

cdp.shot = async function (path) {
  const r = await this.send("Page.captureScreenshot", { format: "png" });
  if (!r.result?.data) throw new Error("截图失败");
  writeFileSync(path, Buffer.from(r.result.data, "base64"));
  log("  已保存 " + path);
};

try {
  const ok = await waitLoaded(cdp, `http://127.0.0.1:${PORT}`, { appUrl: APP });
  if (!ok) throw new Error("页面未导航到 app 源");

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
  await cdp.shot(join(OUT, "shot-dark.png"));

  // 浅色仪表盘
  await cdp.ev(`AH.setTheme('light'); "ok"`);
  await sleep(1400);
  await cdp.shot(join(OUT, "shot-light.png"));

  // 浅色配置页
  await cdp.ev(`document.querySelector('.tabs button[data-tab="config"]').click(); "ok"`);
  await sleep(1000);
  await cdp.shot(join(OUT, "shot-config-light.png"));

  // 回到深色 + 记录页（验证表格圆角容器）
  await cdp.ev(`AH.setTheme('dark'); document.querySelector('.tabs button[data-tab="records"]').click(); "ok"`);
  await sleep(1200);
  await cdp.shot(join(OUT, "shot-records-dark.png"));

  // 端点编辑弹窗（含「获取模型」按钮与模型列表）
  await cdp.ev(`(() => {
    const p = AH.state.providers[0];
    AH.editProv(p.id);
    return "opened";
  })()`);
  await sleep(1000);
  await cdp.shot(join(OUT, "shot-endpoint-editor.png"));
  await cdp.ev(`(document.querySelector('.modal-actions .btn')?.click(), "closed")`);

  // 纯客户端截图（不截浏览器视口外的空白）
  await cdp.ev(`AH.setTheme('dark'); document.querySelector('.tabs button[data-tab="dash"]').click(); "dash"`);
  await sleep(1000);
} catch (e) {
  log("FAIL " + e.message);
} finally {
  await killBrowser(proc, PROFILE_PREFIX);
  closeServer(server);
  try { mock.close(); } catch {}
  try { cdp.ws.close(); } catch {}
}