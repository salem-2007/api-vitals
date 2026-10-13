# -*- coding: utf-8 -*-
"""test_miniapp.py — services.py 单元测试（自带 Python mock，无外部依赖）

用法：python3 tools/test_miniapp.py
覆盖：判分规格 / 答案抽取 / SVG 抽取 / 裁判 JSON 解析 / 429 退避 / 截断抬 tokens /
      补答链路 / 批量答题 / 统计与报告
"""
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import services as sv  # noqa: E402
from bank_data import QUESTIONS, SVG_TASKS  # noqa: E402

PASS, FAIL = 0, 0
FAILED = []


def t(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        FAILED.append(name)
        print("  ✗ %s%s" % (name, ("  → " + str(info)) if info else ""))


ANSWERS = {q["prompt"]: q["answer"] for q in QUESTIONS}
SVG_OUT = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" width="60" height="60">'
           '<circle cx="20" cy="30" r="10" fill="#22c55e">'
           '<animate attributeName="cx" from="20" to="40" dur="1s" repeatCount="indefinite"/>'
           '</circle></svg>')
STATE = {"models": 0, "chat": 0, "followup": 0, "rl": 0, "judge": 0}


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            STATE["models"] += 1
            return self._json({"data": [{"id": "mock-b"}, {"id": "mock-a"}]})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        model = body.get("model", "")
        msgs = body.get("messages") or []
        flat = "\n".join(str(m.get("content") or "") for m in msgs)

        if model == "mock-429" and STATE["rl"] == 0:
            STATE["rl"] += 1
            return self._json({"error": {"message": "rate limited"}}, 429)
        if model == "mock-truncate":
            return self._json({"choices": [{"message": {"content": ""}, "finish_reason": "length"}]})
        if "只输出最终答案" in flat:
            STATE["followup"] += 1
            return self._json({"choices": [{"message": {"content": "答案：17"}, "finish_reason": "stop"}],
                               "usage": {"completion_tokens": 5}})
        if "只输出一个 JSON" in flat or "只输出 JSON" in flat:
            STATE["judge"] += 1
            return self._json({"choices": [{"message": {"content": json.dumps({
                "score": 72, "stars": 4, "verdict": "结构基本完整",
                "criteria": [{"name": "整体", "pass": True, "comment": "可辨认"}],
                "problems": ["细节不足"], "suggestions": ["补充细节"]}, ensure_ascii=False)},
                "finish_reason": "stop"}], "usage": {"completion_tokens": 90}})
        if "请用 SVG" in flat or "精细的 SVG" in flat:
            return self._json({"choices": [{"message": {"content": "```svg\n" + SVG_OUT + "\n```"},
                                           "finish_reason": "stop"}], "usage": {"completion_tokens": 300}})
        STATE["chat"] += 1
        m = re.search(r"题目：([\s\S]*)$", flat)
        q = m.group(1).strip() if m else ""
        ans = ANSWERS.get(q)
        text = ("推理过程略。\n答案：" + ans) if ans else "这道题我不会。"
        return self._json({"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                           "usage": {"completion_tokens": 48}})


srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d/v1" % srv.server_address[1]
CFG = dict(sv.DEFAULT_CFG)
CFG.update({"timeout": 8, "retries": 1, "rl_base": 1, "rl_cap": 2, "rl_retries": 2,
            "max_tokens": 512, "max_tokens_ceiling": 1024, "threads": 3})

print("\n== 判分规格 ==")
correct = {"Q1": "答案：17", "Q5": "答案：(a−c)(ab−ac+b²+bc)",
           "Q6": "答案：F = NAND( NAND(A,B,C), NAND(¬A,¬B,¬C) )",
           "Q10": "答案：x²/9 + y²/8 = 1；定值 −5", "Q12": "答案：4053927",
           "Q14": "答案：92H", "Q15": "答案：gt²/4 + gm₀t/(2λ) − (gm₀²/(2λ²))ln(1+λt/m₀)",
           "Q19": "答案：最大 88，最小 72", "Q20": "答案：0xFC18", "Q22": "答案：29"}
for q in QUESTIONS:
    if q["id"] in correct:
        ok = sv.grade_answer(q, sv.answer_candidates(correct[q["id"]]))[0]
        t("%s 正确答案判对" % q["id"], ok, correct[q["id"]])
        bad = sv.grade_answer(q, sv.answer_candidates("答案：0"))[0]
        t("%s 错误答案判错" % q["id"], not bad)
t("归一化：全角/减号/组合符", sv.norm("Ｈ２Ｏ") == "h2o" and sv.norm("−x1") == "-x1" and sv.norm("a·b·c") == "abc")
t("数字抽取", sv.numbers("最大 88，最小 72") == [88, 72])

print("\n== 抽取与解析 ==")
t("答案行抽取", sv.extract_answer_line("推导…\n答案：17") == "17")
t("SVG 抽取", sv.extract_svg("好的：\n```svg\n%s\n```" % SVG_OUT) == SVG_OUT)
j = sv.parse_judge_json('```json\n{"score": 130, "stars": 9, "verdict": "x"}\n```')
t("裁判 JSON 夹紧", j and j["score"] == 100 and j["stars"] == 5, j)
t("非法 JSON 返回 None", sv.parse_judge_json("不是 JSON") is None)

print("\n== HTTP 全链路（本地 mock）==")
t("拉取模型", sv.fetch_models(BASE, "sk-t") == ["mock-a", "mock-b"])
r = sv.ask_question(BASE, "sk-t", "mock-a", QUESTIONS[0], CFG)
t("答题判对", r["ok"] and r["got"] == "17", r)
r2 = sv.ask_question(BASE, "sk-t", "mock-429", QUESTIONS[0], CFG)
t("429 退避后成功", r2["ok"], r2)
r3 = sv.ask_question(BASE, "sk-t", "mock-truncate", QUESTIONS[0], CFG)
t("截断样本按失败可见", not r3["ok"], r3["error"])
rows = sv.run_questions(BASE, "sk-t", "mock-a", QUESTIONS, CFG)
ok_n = sum(1 for x in rows if x["ok"])
t("批量答题全对", ok_n == len(QUESTIONS) and len(rows) == len(QUESTIONS), "%d/%d" % (ok_n, len(rows)))
g = sv.gen_svg(BASE, "sk-t", "mock-a", SVG_TASKS[0], CFG)
t("SVG 生成", g["ok"] and "<svg" in g["svg"], g["error"])
jr = sv.judge_svg_source(BASE, "sk-t", "mock-a", SVG_TASKS[0], g["svg"], CFG)
t("源码评审", jr["ok"] and jr["judge"]["score"] == 72 and jr["judge"]["stars"] == 4, jr["error"])

print("\n== 统计与报告 ==")
entry = {"model": "mock-a", "q": rows, "svg": [dict(g, judge=jr["judge"])]}
st = sv.model_stats(entry)
t("统计正确率 100%", st["q_rate"] == 100 and st["q_correct"] == len(QUESTIONS), st)
t("SVG 星级统计", st["svg_avg_stars"] == 4.0 and st["svg_judged"] == 1)
t("分组统计完整", len(sv.group_stats(rows)) == 6, [x["label"] for x in sv.group_stats(rows)])
share = sv.build_share_text([entry])
t("分享文本", "mock-a" in share and "100%" in share and "★" in share)
csv = sv.build_csv([entry])
t("CSV 含明细且无 Key", "逐题明细" in csv and "sk-t" not in csv)
t("mock 收到 429 与补答路径", STATE["rl"] == 1)

srv.shutdown()
print("\n结果：%d 通过 / %d 失败" % (PASS, FAIL))
if FAILED:
    print("失败项：", "、".join(FAILED))
sys.exit(1 if FAIL else 0)
