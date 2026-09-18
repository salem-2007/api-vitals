// test-engine.mjs — 引擎自动化自测：四类协议 × 五种检测维度，跑在本地 mock 上
import { startMock } from "./mock.mjs";
import {
  listModels, opConnectivity, opChat, opChatRetry, opLatency, opConcurrent, concurrencyVerdict,
  matchExpect, ADAPTERS,
} from "../wwwroot/engine.js";

let pass = 0, fail = 0;
const t = (name, cond, info = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + "  " + info); }
};

const srv = await startMock(18990);
const base = "http://127.0.0.1:18990";
const P = (over) => ({ apiKey: "sk-test", ...over });
const P_OPENAI = P({ name: "openai-mock", type: "openai", baseUrl: base + "/v1" });
const P_ANTH = P({ name: "anthropic-mock", type: "anthropic", baseUrl: base });
const P_GEM = P({ name: "gemini-mock", type: "gemini", baseUrl: base + "/v1beta" });
const P_CUSTOM = P({ name: "custom-mock", type: "custom", baseUrl: base + "/health", method: "GET" });

console.log("== 适配器注册 ==");
t("4 类适配器就位", Object.keys(ADAPTERS).length === 4, Object.keys(ADAPTERS).join(","));

console.log("== OpenAI 兼容 ==");
{
  const models = await listModels(P_OPENAI, {});
  t("models 列表", models.length === 3 && models.includes("mock-fast"), JSON.stringify(models));
  const c = await opConnectivity(P_OPENAI, {});
  t("连通测试", c.ok && c.latencyMs >= 0 && c.models.length === 3, JSON.stringify(c));
  const r1 = await opChat(P_OPENAI, "mock-fast", { label: "math", user: "计算 17 × 23 + 45", expect: "436" }, {});
  t("非流式 + 关键词", r1.ok && r1.tokens === 42 && r1.tps > 0, JSON.stringify({ ok: r1.ok, tokens: r1.tokens, tps: r1.tps, err: r1.error }));
  const r2 = await opChat(P_OPENAI, "mock-chat", { label: "stream", user: "讲个笑话", expect: null }, { stream: true });
  t("流式解析", r2.ok && r2.streamInfo && r2.streamInfo.chunks >= 3 && r2.streamInfo.done === true && r2.ttftMs != null,
    JSON.stringify({ ok: r2.ok, si: r2.streamInfo, ttft: r2.ttftMs, err: r2.error }));
  t("流式内容拼接", (r2.preview || "").includes("流式"), r2.preview);
  const r3 = await opChat(P_OPENAI, "mock-down", { label: "fail", user: "x", expect: null }, {});
  t("失败模型识别(500)", !r3.ok && r3.status === 500 && r3.error.includes("boom"), JSON.stringify({ status: r3.status, err: r3.error }));
  const r4 = await opChat(P_OPENAI, "mock-chat", { label: "kw", user: "只输出数字", expect: "99999" }, {});
  t("关键词不符 → 失败", !r4.ok && r4.error.includes("缺少关键词"), r4.error);
}

console.log("== Anthropic ==");
{
  const models = await listModels(P_ANTH, {});
  t("models 列表", models.includes("mock-chat"), JSON.stringify(models));
  const r1 = await opChat(P_ANTH, "claude-x", { label: "math", user: "17*23+45?", expect: "436" }, {});
  t("非流式解析 content[].text", r1.ok && r1.tokens === 7, JSON.stringify({ ok: r1.ok, tokens: r1.tokens, err: r1.error }));
  const r2 = await opChat(P_ANTH, "claude-x", { label: "stream", user: "嗨", expect: null }, { stream: true });
  t("SSE 事件流解析 + message_stop", r2.ok && r2.streamInfo.chunks >= 3 && r2.streamInfo.done === true && r2.tokens === 7,
    JSON.stringify({ ok: r2.ok, si: r2.streamInfo, tokens: r2.tokens, err: r2.error }));
}

console.log("== Gemini ==");
{
  const models = await listModels(P_GEM, {});
  t("models 列表(去 models/ 前缀)", models.includes("mock-gemini"), JSON.stringify(models));
  const r1 = await opChat(P_GEM, "mock-gemini", { label: "math", user: "17*23+45?", expect: "436" }, {});
  t("generateContent 解析", r1.ok && r1.tokens === 5, JSON.stringify({ ok: r1.ok, tokens: r1.tokens, err: r1.error }));
  const r2 = await opChat(P_GEM, "mock-gemini", { label: "stream", user: "嗨", expect: null }, { stream: true });
  t("streamGenerateContent(alt=sse)", r2.ok && r2.streamInfo.chunks >= 3 && r2.streamInfo.done === true,
    JSON.stringify({ ok: r2.ok, si: r2.streamInfo, err: r2.error }));
}

console.log("== 自定义 HTTP ==");
{
  const c = await opConnectivity(P_CUSTOM, {});
  t("ping /health", c.ok && c.status === 200 && c.latencyMs >= 0, JSON.stringify(c));
  const c2 = await opConnectivity({ ...P_CUSTOM, baseUrl: base + "/nope" }, {});
  t("404 → 失败", !c2.ok && c2.status === 404, JSON.stringify(c2));
}

console.log("== 延迟采样 ==");
{
  const agg = await opLatency(P_OPENAI, "mock-fast", { label: "lat", user: "x", expect: null }, { n: 3 });
  t("采样 3 次聚合", agg.samples === 3 && agg.ok === 3 && agg.p50 > 0 && agg.p95 >= agg.p50,
    JSON.stringify({ samples: agg.samples, ok: agg.ok, p50: agg.p50, p95: agg.p95 }));
}

console.log("== 关键词归一化（真实报告里 H₂O 误判的根因） ==");
{
  const cases = [
    ["水的化学式是 H₂O。", "H2O", true, "下标 ₂ 应判命中"],
    ["Ｈ２Ｏ", "H2O", true, "全角应判命中"],
    ["H 2 O", "H2O", true, "空格应判命中"],
    ["h2o", "H2O", true, "大小写不敏感"],
    ["答案是 2,500 米", "2500", true, "千分位应判命中"],
    ["答案是 2500", "2500", true, "纯数字命中"],
    ["我不会回答", "H2O", false, "确实没有关键词应判失败"],
    ["436", "436", true, "数字命中"],
    ["结果是4 3 6", "436", true, "数字间空格归并后命中（与 H 2 O 一致）"],
    ["答案是4和36", "436", false, "真正拆开的数字不应命中"],
  ];
  for (const [content, expect, want, name] of cases) {
    const got = matchExpect(content, expect);
    t(name, got === want, `${JSON.stringify(content)} vs ${expect} → ${got}`);
  }
  t("expect 为空视为通过", matchExpect("随便什么", null) === true);
}

console.log("== 空响应归因 + 可重试标记 ==");
{
  const r = await opChat(P_OPENAI, "mock-empty-reasoning", { label: "x", user: "水", expect: "H2O" }, {});
  t("空正文但带 reasoning_content 能归因", !r.ok && /reasoning_content/.test(r.error), r.error);

  const rt1 = await opChat(P_OPENAI, "mock-truncated", { label: "x", user: "水", expect: "H2O" }, {});
  t("finish_reason=length 被识别为截断", /截断/.test(rt1.error || ""), rt1.error);
  t("截断标记为可重试", rt1.retryable === true, "retryable=" + rt1.retryable);

  const r5 = await opChat(P_OPENAI, "mock-down", { label: "x", user: "水", expect: null }, {});
  t("5xx 标记为可重试", r5.retryable === true, "status=" + r5.status + " retryable=" + r5.retryable);

  const r4 = await opChat(P_OPENAI, "mock-chat", { label: "x", user: "水", expect: "不存在XYZ" }, {});
  t("关键词不符不可重试（是真实回答）", r4.retryable !== true, "retryable=" + r4.retryable);
}

console.log("== 自动重试 ==");
{
  // mock-flaky: 前 2 次 500，第 3 次成功
  const ok = await opChatRetry(P_OPENAI, "mock-flaky", { label: "x", user: "水", expect: null }, { retries: 3 });
  t("可重试失败最终成功", ok.ok === true && ok.retried >= 1, JSON.stringify({ ok: ok.ok, retried: ok.retried, err: ok.error }));

  const dead = await opChatRetry(P_OPENAI, "mock-down", { label: "x", user: "水", expect: null }, { retries: 1 });
  t("一直 500 时重试后仍失败", dead.ok === false, "ok=" + dead.ok);

  const kw = await opChatRetry(P_OPENAI, "mock-chat", { label: "x", user: "水", expect: "不存在XYZ" }, { retries: 2 });
  t("关键词不符不触发重试", kw.retried == null, "retried=" + kw.retried);
}

console.log("== 并发（固定并发数，mock 守卫 >3 并发返回 429） ==");
{
  const ok4 = await opConcurrent(P_OPENAI, "mock-fast", [{ label: "c", user: "x", expect: null }], { n: 2 });
  t("并发 2 全通过", ok4.ok === 2 && ok4.fail === 0 && ok4.concurrency === 2, JSON.stringify(ok4));
  t("并发记录延迟与吞吐", ok4.p50 > 0 && ok4.p95 >= ok4.p50 && ok4.throughput > 0 && ok4.wallMs >= 0,
    JSON.stringify({ p50: ok4.p50, p95: ok4.p95, tps: ok4.throughput, wall: ok4.wallMs }));
  t("并发 2 判定可用", concurrencyVerdict(ok4).supported === true, JSON.stringify(concurrencyVerdict(ok4)));

  const bad = await opConcurrent(P_OPENAI, "mock-fast", [{ label: "c", user: "x", expect: null }], { n: 8 });
  t("并发 8 触发限流失败", bad.fail > 0 && bad.errors.length > 0, JSON.stringify({ ok: bad.ok, fail: bad.fail, errs: bad.errors }));
  t("并发 8 判定不可用", concurrencyVerdict(bad).supported === false, JSON.stringify(concurrencyVerdict(bad)));
}

console.log("== 取消 ==");
{
  const ctrl = new AbortController();
  let first = 0;
  const agg = await opLatency(P_OPENAI, "mock-fast", { label: "a", user: "x", expect: null }, {
    n: 8,
    signal: ctrl.signal,
    onRow: () => { if (++first === 1) ctrl.abort(); }, // 第一行返回后立即中止
  });
  t("中止后提前收尾", agg.samples < 8, "samples=" + agg.samples);
}

srv.close();
console.log("");
console.log(fail === 0 ? `全部通过：${pass} PASS` : `${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);