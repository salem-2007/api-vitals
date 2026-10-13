// test-engine.mjs — 引擎单元测试（不依赖浏览器，直接打真实 HTTP 到本地 mock）
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startMock } from "./mock-api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
import {
  QUESTIONS, SVG_TASKS, GROUPS, TYPES, ADAPTERS,
  norm, numbers, gradeAnswer, extractAnswerLine, answerCandidates,
  extractSvg, ensureSvgSize, sanitizeSvg, svgDataUrl,
  parseJudgeJson, buildJudgeParts, buildSvgPrompt, buildQuestionPrompt,
  modelStats, groupStats, runStats, flattenRun, buildReportCsv, buildShareText,
  listModels, opAskQuestion, opGenSvg, opJudgeSvg, opJudgeAnswer, runPool,
  starsText, starsFromScore,
  PROBE_LAYERS, PROBE_ITEMS, runProbe, opRunProbes, summarizeLayer, probeScore,
} from "../wwwroot/engine.js";

let pass = 0, fail = 0;
const t = (name, cond, info = "") => {
  if (cond) { pass++; }
  else { fail++; console.log("  ✗ " + name + (info ? "  → " + info : "")); }
};
const section = (s) => console.log("\n== " + s + " ==");

// ---------------- 题库完整性 ----------------
section("题库完整性");
t("22 道学科题", QUESTIONS.length === 22, "got " + QUESTIONS.length);
t("8 个 SVG 题", SVG_TASKS.length === 8, "got " + SVG_TASKS.length);
t("题号唯一", new Set(QUESTIONS.map((q) => q.id)).size === QUESTIONS.length);
t("每个题都有 prompt/answer/grade", QUESTIONS.every((q) => q.prompt && q.answer && q.grade));
t("分组都在 GROUPS 内", QUESTIONS.every((q) => GROUPS.some((g) => g.key === q.group)));
t("每个 SVG 题有评分维度", SVG_TASKS.every((s) => Array.isArray(s.criteria) && s.criteria.length >= 3));
t("糖果题答案 29", QUESTIONS.find((q) => q.id === "Q22")?.answer === "29");
t("精细复合题有完整提示词", !!SVG_TASKS.find((s) => s.id === "svg-masterpiece")?.prompt);

// ---------------- 归一化 / 判分 ----------------
section("归一化与判分");
t("NFKC 全角→半角", norm("Ｈ２Ｏ") === "h2o", norm("Ｈ２Ｏ"));
t("上下标归一", norm("b²") === "b2", norm("b²"));
t("各种减号归一", norm("−x1") === "-x1", norm("−x1"));
t("组合符剥离", norm("a·b·c") === "abc", norm("a·b·c"));
t("数字抽取", JSON.stringify(numbers("最大 88，最小 72")) === "[88,72]", JSON.stringify(numbers("最大 88，最小 72")));
t("抽取「答案：」行", extractAnswerLine("分析…\n答案：17") === "17");
t("抽取 FINAL 行", extractAnswerLine("reasoning\nFINAL: B") === "B");

const correctSamples = {
  Q1: "答案：17", Q2: "答案：2", Q3: "答案：498", Q4: "答案：5",
  Q5: "答案：(a−c)(ab−ac+b²+bc)",
  Q6: "答案：F = NAND( NAND(A,B,C), NAND(¬A,¬B,¬C) )",
  Q7: "答案：27 厘米", Q8: "答案：−√3/3", Q9: "答案：248",
  Q10: "答案：(1) x²/9 + y²/8 = 1；(2) 定值 −5",
  Q11: "答案：λ = n−1", Q12: "答案：4053927",
  Q13: "答案：−x1+2x2−2=0，支持向量 (1,2)、(3,3)、(3,2)",
  Q14: "答案：92H",
  Q15: "答案：s(t)=gt²/4 + gm₀t/(2λ) − (gm₀²/(2λ²))·ln(1+λt/m₀)",
  Q16: "答案：0<k<2/9", Q17: "答案：6π", Q18: "答案：6528",
  Q19: "答案：最大值 88，最小值 72", Q20: "答案：0xFC18", Q21: "答案：12", Q22: "答案：29",
};
const wrongSamples = {
  Q1: "答案：16", Q2: "答案：3", Q3: "答案：497", Q4: "答案：4",
  Q5: "答案：(a−b)(b−c)(c−a)",
  Q6: "答案：把 ABC + ¬A¬B¬C 写成与非形式即可",
  Q7: "答案：26 厘米", Q8: "答案：−√3/2", Q9: "答案：247",
  Q10: "答案：x²/9 + y²/8 = 1；定值 −4",
  Q11: "答案：λ = n", Q12: "答案：1234567",
  Q13: "答案：−x1+2x2−2=0，支持向量 (1,2)、(3,3)",
  Q14: "答案：94H", Q15: "答案：s(t)=gt²/4", Q16: "答案：0<k<1/9",
  Q17: "答案：4π", Q18: "答案：6527", Q19: "答案：最大 87，最小 71",
  Q20: "答案：0xFC17", Q21: "答案：11", Q22: "答案：28",
};
for (const q of QUESTIONS) {
  const good = gradeAnswer(q, answerCandidates(correctSamples[q.id]));
  const bad = gradeAnswer(q, answerCandidates(wrongSamples[q.id]));
  t(`${q.id} 正确样本判对`, good.ok, correctSamples[q.id]);
  t(`${q.id} 错误样本判错`, !bad.ok, wrongSamples[q.id]);
}
t("多行回答取最后答案行", gradeAnswer(QUESTIONS[0], answerCandidates("先算得 3+14\n所以\n答案：17")).ok);

// ---------------- SVG 抽取 / 规整 ----------------
section("SVG 抽取与规整");
const raw = "好的，这是代码：\n```svg\n<svg viewBox=\"0 0 100 100\"><circle r=\"10\"/></svg>\n```\n希望满意";
t("从围栏抽取 SVG", extractSvg(raw) === '<svg viewBox="0 0 100 100"><circle r="10"/></svg>', extractSvg(raw));
t("无围栏也能抽", extractSvg("前缀 <svg width=\"5\"></svg> 后缀") === '<svg width="5"></svg>');
t("抽不到返回空", extractSvg("没有图形") === "");
const fixed = ensureSvgSize('<svg viewBox="0 0 200 100"><rect/></svg>');
t("补 width", /width="200"/.test(fixed), fixed);
t("补 height", /height="100"/.test(fixed), fixed);
t("补 xmlns", /xmlns=/.test(fixed), fixed);
t("默认尺寸兜底", /width="400"/.test(ensureSvgSize("<svg><rect/></svg>")));
t("净化去脚本", !/<script/i.test(sanitizeSvg('<svg><script>alert(1)</script><rect/></svg>')));
t("净化去事件", !/onload/i.test(sanitizeSvg('<svg onload="evil()"><rect/></svg>')));
t("净化去外链", !/http:\/\/evil/.test(sanitizeSvg('<svg><image href="http://evil/x.png"/></svg>')));
t("keepScript 保留脚本", /<script/i.test(sanitizeSvg('<svg><script>x</script></svg>', { keepScript: true })));
t("dataURL 可解码", decodeURIComponent(svgDataUrl("<svg/>").split(",")[1]) === "<svg/>");

// ---------------- 裁判 JSON 解析 ----------------
section("裁判输出解析");
const j1 = parseJudgeJson('```json\n{"score":87,"stars":4,"verdict":"不错","criteria":[{"name":"x","pass":true,"comment":"c"}],"problems":[],"suggestions":["a"]}\n```');
t("围栏 JSON", j1 && j1.score === 87 && j1.stars === 4 && j1.criteria[0].pass === true);
const j2 = parseJudgeJson('评价如下：{"score": 130, "verdict":"好"} 完毕');
t("裸 JSON + 分数夹紧", j2 && j2.score === 100 && j2.stars === 5, JSON.stringify(j2));
t("非法输出返回 null", parseJudgeJson("完全不是 JSON") === null);
t("缺 stars 时按分推算", parseJudgeJson('{"score":45}').stars === 2);
t("星级文本", starsText(4) === "★★★★☆" && starsFromScore(85) === 4);

const parts = buildJudgeParts(SVG_TASKS[0], { candidateFrames: ["data:image/png;base64,AAA"], svg: "<svg/>", motion: true });
t("裁判请求含文本块", parts.filter((p) => p.type === "text").length >= 3);
t("裁判请求含图像块", parts.filter((p) => p.type === "image").length === 1);
t("裁判提示词含全部维度", SVG_TASKS[0].criteria.every((c) => parts[0].text.includes(c)));
t("裁判提示词报告动画检测", /帧间差异检测：有动画/.test(parts[0].text));
t("不含参考作品字样", !/参考作品/.test(parts.map((p) => p.text || "").join("")));

// ---------------- 统计 / 报告 ----------------
section("统计与报告");
const fakeRun = {
  ts: Date.now(), providerCount: 1, durationMs: 12345,
  models: [{
    provider: "中转A", model: "mock-a", type: "openai",
    q: [
      { qid: "Q1", no: 1, group: "comb", type: "组合几何", ok: true, expected: "17", got: "17", latencyMs: 900, tokens: 120, t: Date.now() },
      { qid: "Q2", no: 2, group: "comb", type: "组合几何", ok: false, expected: "2", got: "3", latencyMs: 1100, tokens: 130, t: Date.now(), error: "答案不符" },
      { qid: "Q5", no: 5, group: "alg", type: "多项式因式分解", ok: true, expected: "(a−c)(ab−ac+b²+bc)", got: "(a-c)(ab-ac+b2+bc)", latencyMs: 800, tokens: 100, t: Date.now() },
    ],
    svg: [{ taskId: "svg-ecg", title: "心电图波形", ok: true, svg: "<svg/>", latencyMs: 5000, tokens: 2000, judge: { score: 80, stars: 4, verdict: "波形正确", criteria: [] }, t: Date.now() }],
  }],
};
const mst = modelStats(fakeRun.models[0]);
t("模型统计 正确率", mst.qRate === 67 && mst.qCorrect === 2 && mst.qTotal === 3, JSON.stringify(mst));
t("模型统计 SVG 星级", mst.svgAvgStars === 4 && mst.svgJudged === 1);
const gst = groupStats(fakeRun.models[0].q);
t("分组统计", gst.length === 2 && gst.find((g) => g.key === "comb").ok === 1);
const rst = runStats(fakeRun);
t("整轮统计", rst.qTotal === 3 && rst.qCorrect === 2 && rst.svgTotal === 1 && rst.svgAvgStars === 4);
const flat = flattenRun(fakeRun);
t("扁平化含题与图", flat.length === 4 && flat.filter((r) => r.kind === "svg").length === 1);
const csv = buildReportCsv(fakeRun);
t("CSV 有表头与明细", /模型智商检测报告/.test(csv) && /逐题明细/.test(csv) && csv.includes("mock-a"));
t("CSV 不含 API Key 列", !/apiKey|APIKey/.test(csv));
const share = buildShareText(fakeRun);
t("分享文本含模型与分数", share.includes("mock-a") && share.includes("67%"), share.split("\n").slice(0, 3).join(" | "));
t("分享文本含 SVG 星级", share.includes("★"));

// ---------------- 并发池 ----------------
section("并发池");
{
  let live = 0, peak = 0;
  const items = Array.from({ length: 9 }, (_, i) => i);
  const out = await runPool(items, 3, async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 12));
    live--;
    return x * 2;
  });
  t("结果按序返回", JSON.stringify(out) === JSON.stringify(items.map((x) => x * 2)), JSON.stringify(out));
  t("并发不超上限", peak <= 3, "peak=" + peak);
  const stopped = await runPool(items, 2, async (x) => x, () => true);
  t("shouldStop 立即停止", stopped.every((v) => v === undefined));
}

// ---------------- HTTP 端到端（本地 mock） ----------------
section("HTTP 端到端");
let req429 = 0, sawVision = 0, sawFollowup = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith("/models")) return json({ data: [{ id: "mock-b" }, { id: "mock-a" }] });
    const model = body.model || "";
    if (model === "mock-429" && req429++ === 0) return json({ error: { message: "rate limited" } }, 429);
    const msgs = body.messages || [];
    const isVision = Array.isArray(msgs[1]?.content) && msgs[1].content.some((c) => c.type === "image_url");
    if (isVision) {
      sawVision++;
      return json({ choices: [{ message: { content: '{"score":72,"stars":4,"verdict":"基本达标","criteria":[{"name":"a","pass":true,"comment":"ok"}],"problems":["细节不足"],"suggestions":["加细节"]}' }, finish_reason: "stop" }], usage: { completion_tokens: 88 } });
    }
    const last = String(msgs[msgs.length - 1].content || "");
    if (/只输出最终答案/.test(last)) { sawFollowup++; return json({ choices: [{ message: { content: "答案：17" }, finish_reason: "stop" }], usage: { completion_tokens: 5 } }); }
    if (/请用 SVG/.test(last)) return json({ choices: [{ message: { content: "```svg\n<svg viewBox=\"0 0 40 40\"><circle cx=\"20\" cy=\"20\" r=\"10\"/></svg>\n```" }, finish_reason: "stop" }], usage: { completion_tokens: 60 } });
    if (model === "mock-truncate") return json({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: {} });
    if (model === "mock-nofinal") return json({ choices: [{ message: { content: "我算了一下，应该是 3+14，所以结果如上。" }, finish_reason: "stop" }], usage: { completion_tokens: 20 } });
    if (/只输出 JSON/.test(last)) return json({ choices: [{ message: { content: '{"correct":true,"reason":"等价变形"}' }, finish_reason: "stop" }], usage: { completion_tokens: 12 } });
    return json({ choices: [{ message: { content: "推导过程……\n答案：17" }, finish_reason: "stop" }], usage: { completion_tokens: 42 } });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port + "/v1";
const prov = { name: "本地mock", type: "openai", baseUrl: base, apiKey: "sk-test" };
const cfg = { maxTokens: 512, temperature: 0, retries: 1, rlRetries: 2, rlBaseSec: 1, rlCapSec: 2, maxTokensCeiling: 2048, timeoutMs: 8000 };

t("listModels 去重排序", JSON.stringify(await listModels(prov, { timeoutMs: 5000 })) === '["mock-a","mock-b"]');
const a1 = await opAskQuestion(prov, "mock-a", QUESTIONS[0], cfg, {});
t("答题链路判对", a1.ok && a1.got === "17" && a1.tokens === 42, JSON.stringify({ ok: a1.ok, got: a1.got, tokens: a1.tokens }));
const a2 = await opAskQuestion(prov, "mock-nofinal", QUESTIONS[0], cfg, {});
t("无最终答案时触发补答", a2.ok && a2.followup === true && sawFollowup > 0, JSON.stringify({ ok: a2.ok, followup: a2.followup }));
const a3 = await opAskQuestion(prov, "mock-429", QUESTIONS[0], cfg, {});
t("429 退避后成功", a3.ok && a3.rlRetries >= 1, JSON.stringify({ ok: a3.ok, rl: a3.rlRetries }));
const a4 = await opAskQuestion(prov, "mock-truncate", QUESTIONS[0], cfg, {});
t("截断自动抬 tokens 后失败可见", a4.ok === false, JSON.stringify({ ok: a4.ok, err: a4.error }));
const g1 = await opGenSvg(prov, "mock-a", SVG_TASKS[0], cfg, {});
t("SVG 生成链路", g1.ok && /<svg/.test(g1.svg) && /width=/.test(g1.svg), JSON.stringify({ ok: g1.ok, err: g1.error }));
const jr = await opJudgeSvg(prov, "mock-a", SVG_TASKS[0], { candidateFrames: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"], svg: g1.svg, motion: true }, cfg, {});
t("视觉裁判链路", jr.ok && jr.judge.score === 72 && jr.judge.stars === 4, JSON.stringify({ ok: jr.ok, err: jr.error }));
t("裁判确实收到图像", sawVision > 0, "sawVision=" + sawVision);
const ar = await opJudgeAnswer(prov, "mock-a", QUESTIONS[0], "十七", cfg, {});
t("AI 复核链路", ar.ok && ar.correct === true && /等价/.test(ar.reason), JSON.stringify(ar));
server.close();

// ---------------- 提示词 ----------------
section("提示词");
t("题目提示词含答案格式要求", /答案：/.test(buildQuestionPrompt(QUESTIONS[0])));
t("SVG 提示词禁止脚本", /禁止使用 <script>/.test(buildSvgPrompt(SVG_TASKS[0])));
t("精细题用自带完整提示词", buildSvgPrompt(SVG_TASKS.find((s) => s.id === "svg-masterpiece")).includes("鹈鹕"));
t("协议类型三种", TYPES.length === 3 && !!ADAPTERS.anthropic && !!ADAPTERS.gemini);


// ---------------- 指纹探针 ----------------
section("指纹探针：结构与调度");
t("7 层 / 20 探针", PROBE_LAYERS.length === 7 && PROBE_ITEMS.length === 20,
  `${PROBE_LAYERS.length}层 ${PROBE_ITEMS.length}探针`);
t("每层 ≥1 个探针，且 ≥6 层有 ≥3 个", PROBE_LAYERS.every((l) => PROBE_ITEMS.filter((p) => p.layer === l.key).length >= 1)
  && PROBE_LAYERS.filter((l) => PROBE_ITEMS.filter((p) => p.layer === l.key).length >= 3).length >= 6);
t("层顺序与编号一致", PROBE_LAYERS.every((l, i) => l.no === i + 1), PROBE_LAYERS.map((l) => l.no + ":" + l.key).join(" "));
t("探针 id 唯一", new Set(PROBE_ITEMS.map((p) => p.id)).size === PROBE_ITEMS.length);
t("每层都有检测原理与目的", PROBE_LAYERS.every((l) => l.principle.length >= 2 && l.purpose));
t("层级汇总：bad → 异常", summarizeLayer("infra", [
  { layer: "infra", level: "ok" }, { layer: "infra", level: "bad" }]).verdict === "异常");
t("层级汇总：warn → 可疑", summarizeLayer("infra", [
  { layer: "infra", level: "ok" }, { layer: "infra", level: "warn" }]).verdict === "可疑");
t("层级汇总：全 ok/info → 通过", summarizeLayer("infra", [
  { layer: "infra", level: "ok" }, { layer: "infra", level: "info" }]).verdict === "通过");
t("评分：满分 100", probeScore([{ bad: 0, warn: 0 }]).score === 100);
t("评分：1 bad + 2 warn = 66", probeScore([{ bad: 1, warn: 2 }]).score === 66, probeScore([{ bad: 1, warn: 2 }]).score);
t("评分：5 bad 触底 0", probeScore([{ bad: 5, warn: 0 }]).score === 0);

const probeAnswers = Object.fromEntries(QUESTIONS.map((q) => [q.prompt, q.answer]));
const probeMock = await startMock({ root: join(here, "..", "wwwroot"), answers: probeAnswers });
const pbase = "http://127.0.0.1:" + probeMock.port + "/v1";
const probeCfg = { timeoutMs: 8000, connectTimeoutMs: 5000, retries: 0, rlRetries: 0, rlBaseSec: 1, rlCapSec: 1 };

section("指纹探针：干净官方模型（claude-opus-4-6）");
{
  const prov = { name: "官方直连", type: "openai", baseUrl: pbase, apiKey: "sk-t" };
  const res = await opRunProbes(prov, "claude-opus-4-6", probeCfg, {});
  t("跑满 20 项", res.items.length === 20, res.items.length);
  t("无 bad", res.items.filter((r) => r.level === "bad").length === 0,
    res.items.filter((r) => r.level === "bad").map((r) => r.id).join(","));
  t("无 warn", res.items.filter((r) => r.level === "warn").length === 0,
    res.items.filter((r) => r.level === "warn").map((r) => r.id + ":" + r.evidence.slice(0, 40)).join(" | "));
  t("总评通过 / 满分", res.verdict === "通过" && res.score === 100, `${res.verdict} ${res.score}`);
  t("6 层全部通过", res.layers.every((l) => l.verdict === "通过"));
  const byId = Object.fromEntries(res.items.map((r) => [r.id, r]));
  t("控制符注入未崩溃 → ok", byId["infra-control-token"].level === "ok");
  t("tokenizer 确定性 → ok", byId["infra-tokenizer"].level === "ok", byId["infra-tokenizer"].evidence);
  t("身份自述一致 → ok", byId["style-selfid"].level === "ok", byId["style-selfid"].evidence);
  t("浮点陷阱答对", byId["logic-float"].level === "ok");
  t("strawberry 计数答对", byId["logic-count"].level === "ok");
  t("幻觉探针：承认不存在", byId["logic-hallucination"].level === "ok");
  t("知识截断：自述与事实一致", byId["logic-cutoff"].level === "ok", byId["logic-cutoff"].evidence);
  t("JSON 纯净", byId["agent-json"].level === "ok");
  t("结构约束满足", byId["agent-schema"].level === "ok");
  t("工具调用可用", byId["agent-tool"].level === "ok", byId["agent-tool"].evidence);
  t("签名字段一致", byId["sign-response"].level === "ok", byId["sign-response"].evidence);
  t("思维链痕迹存在", byId["sign-thinking"].level === "ok", byId["sign-thinking"].evidence);
  t("协议一致", byId["sign-protocol"].level === "ok", byId["sign-protocol"].evidence);
  t("数值指纹归因与请求模型一致", byId["numberfp-attribute"].level === "ok", byId["numberfp-attribute"].evidence);
  t("归因给出模型与家族概率", /归因 Top3/.test(byId["numberfp-attribute"].evidence) && /家族：/.test(byId["numberfp-attribute"].evidence));
}

section("指纹探针：套壳降智模型（deepseek-r1）");
{
  const prov = { name: "可疑中转", type: "openai", baseUrl: pbase, apiKey: "sk-t" };
  const res = await opRunProbes(prov, "deepseek-r1", probeCfg, {});
  const byId = Object.fromEntries(res.items.map((r) => [r.id, r]));
  const bads = res.items.filter((r) => r.level === "bad").map((r) => r.id);
  t("总评异常", res.verdict === "异常", `${res.verdict} ${res.score}`);
  t("基础设施指纹命中（x-ollama/uvicorn）", byId["infra-headers"].level === "bad", byId["infra-headers"].evidence);
  t("控制符注入 400 → 高危套壳", byId["infra-control-token"].level === "bad", byId["infra-control-token"].evidence);
  t("无 usage → 计费不可核验", byId["infra-tokenizer"].level === "warn", byId["infra-tokenizer"].evidence);
  t("语言倒影泄露其它厂商", byId["style-reflection"].level === "warn", byId["style-reflection"].evidence);
  t("身份自述与模型名不一致", byId["style-selfid"].level === "warn", byId["style-selfid"].evidence);
  t("浮点陷阱答错", byId["logic-float"].level === "bad", byId["logic-float"].evidence);
  t("strawberry 计数答错", byId["logic-count"].level === "bad");
  t("幻觉：编造 DOI", byId["logic-hallucination"].level === "bad", byId["logic-hallucination"].evidence);
  t("知识截断：自述与实际不符", byId["logic-cutoff"].level === "warn", byId["logic-cutoff"].evidence);
  t("JSON 被 markdown 污染", byId["agent-json"].level === "bad", byId["agent-json"].evidence);
  t("结构约束不符", byId["agent-schema"].level === "warn");
  t("工具调用缺失", byId["agent-tool"].level === "warn");
  t("响应 model 字段被改写", byId["sign-response"].level === "bad", byId["sign-response"].evidence);
  t("usage 算术不符被抓", /算术不符/.test(byId["sign-response"].evidence), byId["sign-response"].evidence);
  t("推理模型无思维链 → bad", byId["sign-thinking"].level === "bad", byId["sign-thinking"].evidence);
  t("协议结构异常", ["bad", "warn"].includes(byId["sign-protocol"].level), byId["sign-protocol"].evidence);
  t("至少 6 项 bad", bads.length >= 6, bads.join(","));
  t("异常层数 ≥ 3", res.layers.filter((l) => l.verdict !== "通过").length >= 3,
    res.layers.map((l) => l.key + ":" + l.verdict).join(" "));
}

section("指纹探针：单项直跑与边界");
{
  const prov = { name: "官方直连", type: "openai", baseUrl: pbase, apiKey: "sk-t" };
  const item = PROBE_ITEMS.find((x) => x.id === "logic-float");
  const r = await runProbe(prov, "claude-opus-4-6", item, probeCfg, {});
  t("runProbe 单项可用", r.id === "logic-float" && r.level === "ok");
  const na = await runProbe({ name: "g", type: "gemini", baseUrl: pbase, apiKey: "k" },
    "gemini-2.0", PROBE_ITEMS.find((x) => x.id === "agent-tool"), probeCfg, {});
  t("Gemini 工具探针标记不适用", na.level === "info" && /跳过/.test(na.evidence), na.evidence);
  const stopped = await opRunProbes(prov, "claude-opus-4-5", probeCfg, { signal: { aborted: true } });
  t("中断后不继续跑", stopped.items.length === 0);
}

section("指纹探针：换底模型（claude-sonnet-4-6 外壳 + GPT 数值指纹）");
{
  const prov = { name: "换底中转", type: "openai", baseUrl: pbase, apiKey: "sk-t" };
  const res = await opRunProbes(prov, "claude-sonnet-4-6", probeCfg, {});
  const fp = res.items.find((r) => r.id === "numberfp-attribute");
  t("数值指纹判为异常", fp.level === "bad", fp.evidence);
  t("归因家族为 GPT", /GPT/.test(fp.evidence) && /家族/.test(fp.evidence), fp.evidence);
  t("证据含归因概率与校准信息", /β=/.test(fp.evidence) && /自评准确率/.test(fp.evidence), fp.evidence);
  t("attribution 明细完整", fp.detail && fp.detail.attribution && fp.detail.attribution.top.length === 5,
    JSON.stringify(fp.detail && fp.detail.attribution && fp.detail.attribution.top.slice(0, 2)));
  t("3 次挑战均成功", fp.detail.calls.filter((c) => c.status === 200).length === 3, JSON.stringify(fp.detail.calls));
}

section("数值指纹：库匹配与边界");
{
  const { matchBankModel, summarizeNumberFp } = await import("../wwwroot/engine.js");
  t("精确匹配", matchBankModel("gpt-5.5")?.id === "gpt-5.5");
  t("带日期后缀匹配", matchBankModel("claude-sonnet-4-6-20250101")?.id === "claude-sonnet-4-6");
  t("最长优先（不误配短 id）", matchBankModel("claude-opus-5-5")?.id === "claude-opus-5-5");
  t("库外模型返回 null", matchBankModel("deepseek-r1") === null);
  const fake = { results: [{ model: "gpt-5.4", display_name: "gpt-5.4", probability: 0.9 }],
    family_probabilities: [{ family: "gpt", display_name: "GPT", probability: 0.95 }, { family: "claude", display_name: "Claude", probability: 0.05 }],
    family_prediction: "gpt", family_prediction_name: "GPT", family_probability: 0.95,
    prediction: "gpt-5.4", prediction_name: "gpt-5.4", probability: 0.9, used_outputs: 3,
    calibration: { beta: 12, cv_accuracy: 1 } };
  t("库外模型 → info", summarizeNumberFp(fake, "deepseek-r1").level === "info");
  t("家族不符 → bad", summarizeNumberFp(fake, "claude-sonnet-4-6").level === "bad");
  t("同家族版本不符 → warn", summarizeNumberFp(fake, "gpt-5.5").level === "warn");
  t("命中 → ok", summarizeNumberFp(fake, "gpt-5.4").level === "ok");
}

probeMock.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
