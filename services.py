# -*- coding: utf-8 -*-
"""services.py — 模型智商检测：MiniApp 版业务逻辑（纯逻辑，可脱离 AppUI 单测）

与桌面版 winapp/wwwroot/engine.js 语义一致：
  · 22 道学科推理题：本地判分（数值 / 关键词 / 与或组 / 等价式 / 出现次数）
  · 8 道 SVG 动画题：生成 SVG（MiniApp 无浏览器渲染，评审走「源码评审」）
  · 429 指数退避重试 / finish_reason=length 自动抬 max_tokens / 无最终答案自动补答
题库来自 bank_data.py（由 questions.js 生成，两端一致）。
"""

import json
import re
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from bank_data import GROUPS, QUESTIONS, SVG_TASKS

QUESTION_SYSTEM = "你是标准化推理测试的受试者。请独立、准确地作答，最后一行必须用「答案：X」的格式给出最终答案。"
SVG_SYSTEM = "你是资深 SVG 动画工程师，只输出可直接运行的 SVG 代码。"

DEFAULT_CFG = {
    "timeout": 120,          # 单请求超时（秒）
    "max_tokens": 4096,      # 学科题输出上限
    "max_tokens_ceiling": 16384,
    "svg_max_tokens": 8192,
    "svg_temperature": 0.4,
    "retries": 2,            # 5xx/网络抖动重试次数
    "rl_retries": 6,         # 429 重试次数
    "rl_base": 5,            # 429 首次等待（秒）
    "rl_cap": 120,           # 429 单次等待上限（秒）
    "threads": 2,            # 同一模型内并发答题数
    "thinking": "off",       # 思考等级：off / low / medium / high（OpenAI 兼容 = reasoning_effort）
}

# ==================== 归一化与判分（对齐 engine.js）====================
_DASHES = re.compile("[\u2010-\u2015\u2212\u2043\ufe63\uff0d]")
_COMBINING = re.compile("[\u0300-\u036f]")
_DROP = re.compile("[\u0009-\u000d\u0020\u00a0\u200b\u3000]|[\u2026\u00b7\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u300a\u300b\u3008\u3009\u3010\u3011\u3016\u3017`\"']")
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def norm(s):
    """NFKC + 各类减号归一 + 去组合符 + 小写 + 去空白与常见标点（保留 +-*/^=√ 等数学符号）"""
    t = unicodedata.normalize("NFKC", str(s if s is not None else ""))
    t = _DASHES.sub("-", t)
    t = _COMBINING.sub("", t)
    t = t.lower()
    return _DROP.sub("", t)


def numbers(s):
    return [float(x) for x in _NUM_RE.findall(norm(s))]


def _hit_group(n, group):
    """组判定：list = OR 子串；dict{any,min} = 这些子串总出现次数 >= min"""
    if isinstance(group, list):
        return any(norm(x) in n for x in group)
    if isinstance(group, dict) and isinstance(group.get("any"), list):
        total = 0
        for t in group["any"]:
            tt = norm(t)
            if tt:
                total += n.count(tt)
        return total >= int(group.get("min", 1))
    return False


def grade_answer(q, candidates):
    """按题目的 grade 规格判分；候选串按顺序尝试，任一命中即算对。返回 (ok, how, hit)"""
    g = q.get("grade") or {}
    for cand in (candidates or []):
        if cand is None or not str(cand).strip():
            continue
        n = norm(cand)
        if not n:
            continue
        if g.get("exact") and any(n == norm(x) for x in g["exact"]):
            return True, "exact", cand
        if g.get("digits") and str(g["digits"]) in re.sub(r"\D", "", n):
            return True, "digits", cand
        if g.get("num") and any(abs(v - t) < 1e-9 for v in numbers(n) for t in g["num"]):
            return True, "num", cand
        if g.get("nums") and all(any(abs(v - t) < 1e-9 for v in numbers(n)) for t in g["nums"]):
            return True, "nums", cand
        if g.get("any") and any(norm(x) in n for x in g["any"]):
            return True, "any", cand
        if g.get("all") and all(_hit_group(n, grp) for grp in g["all"]):
            return True, "all", cand
        if g.get("alts") and any(all(_hit_group(n, grp) for grp in (s.get("all") or [])) for s in g["alts"]):
            return True, "alts", cand
    return False, "", ""


_ANSWER_RE = re.compile(r"^(?:最终答案|答案|answer|final(?:\s*answer)?)\s*[:：]\s*(.+)$", re.I)
_ANSWER_ANY_RE = re.compile(r"(?:最终答案|答案|answer|final(?:\s*answer)?)\s*[:：]\s*([^\n]+)", re.I)


def extract_answer_line(raw):
    lines = [x.strip() for x in str(raw or "").splitlines() if x.strip()]
    for line in reversed(lines):
        m = _ANSWER_RE.match(line)
        if m:
            return m.group(1).strip()
    return ""


def answer_candidates(raw):
    text = str(raw or "")
    out = []
    line = extract_answer_line(text)
    if line:
        out.append(line)
    for m in _ANSWER_ANY_RE.finditer(text):
        v = m.group(1).strip()
        if v:
            out.append(v)
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    if lines:
        out.append(lines[-1])
    out.append(text)
    seen, uniq = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


# ==================== 提示词 ====================
def build_question_prompt(q):
    return "\n".join([
        "完成下面的题目。你可以先在内部充分思考。",
        "最后一行必须严格写成：答案：<你的最终答案>",
        "（若题目有多个小问，把各问答案用分号隔开写在同一行。）",
        "",
        "题目：" + q["prompt"],
    ])


def build_svg_prompt(task):
    if task.get("prompt"):
        return task["prompt"]
    return "\n".join([
        "请用 SVG 画一段动画：%s。" % task["brief"],
        "",
        "要求：",
        "1. 输出一个完整、可独立运行的 <svg> 代码（含 xmlns），尺寸不超过 480×480；",
        "2. 动画使用 SMIL（<animate>/<animateTransform>）或内联 CSS，必须 repeatCount=\"indefinite\" 循环播放；",
        "3. 禁止使用 <script>、外部图片、外部字体、外部网络资源；",
        "4. 画面元素比例协调、结构完整，能一眼看出主题；",
        "5. 只输出一个 ```svg 代码块，不要输出解释文字。",
    ])


_SVG_RE = re.compile(r"```(?:svg|xml|html)?\s*(.*?)```", re.S | re.I)


def extract_svg(text):
    t = str(text or "")
    m = _SVG_RE.search(t)
    if m and "<svg" in m.group(1).lower():
        return m.group(1).strip()
    low = t.lower()
    start = low.find("<svg")
    if start >= 0:
        end = low.find("</svg>", start)
        if end >= 0:
            return t[start:end + 6].strip()
    return ""


# ==================== HTTP ====================
def _err_msg(raw, status):
    try:
        j = json.loads(raw)
        m = j.get("error")
        if isinstance(m, dict):
            m = m.get("message") or m
        if not m:
            m = j.get("message")
        if m:
            return str(m)
    except Exception:
        pass
    return "HTTP %s%s" % (status, (" · " + str(raw)[:160]) if raw else "")


def _post(url, api_key, payload, timeout):
    """POST JSON。抛出的异常带 .status / .retry_after"""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": "Bearer " + (api_key or ""),
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = ""
        try:
            raw = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        exc = RuntimeError(_err_msg(raw, e.code))
        exc.status = e.code
        exc.retry_after = (e.headers or {}).get("Retry-After")
        raise exc
    except Exception as e:
        exc = RuntimeError(str(e))
        exc.status = 0
        raise exc


def fetch_models(base_url, api_key, timeout=15):
    url = base_url.rstrip("/") + "/models"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + (api_key or "")})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    ids = []
    for item in (data.get("data") or []):
        mid = item.get("id") if isinstance(item, dict) else item
        if mid:
            ids.append(str(mid))
    return sorted(set(ids))


def _parse_chat(resp):
    ch = (resp.get("choices") or [{}])[0]
    content = ((ch.get("message") or {}).get("content") or "").strip()
    usage = resp.get("usage") or {}
    return content, usage.get("completion_tokens"), str(ch.get("finish_reason") or "")


def chat(base_url, api_key, model, system, user, cfg, max_tokens=None, temperature=0.0, max_field="max_tokens"):
    """单次对话（不含重试）。返回 dict：ok/content/tokens/latency/error/status"""
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}],
        max_field: int(max_tokens or cfg["max_tokens"]),
    }
    # 思考等级：reasoning_effort（开启时省略 temperature，多数推理端点 temperature 只接受 1）
    thinking = str(cfg.get("thinking") or "off")
    if thinking != "off":
        payload["reasoning_effort"] = thinking
    else:
        payload["temperature"] = float(temperature)
    t0 = time.time()
    try:
        resp = _post(url, api_key, payload, cfg["timeout"])
    except Exception as e:
        return {"ok": False, "content": "", "tokens": None,
                "latency": int((time.time() - t0) * 1000),
                "error": str(e), "status": getattr(e, "status", 0),
                "retry_after": getattr(e, "retry_after", None)}
    content, tokens, finish = _parse_chat(resp)
    return {"ok": True, "content": content, "tokens": tokens, "finish": finish,
            "latency": int((time.time() - t0) * 1000), "error": "", "status": 200}


def chat_retry(base_url, api_key, model, system, user, cfg, max_tokens=None,
               temperature=0.0, on_note=None):
    """带重试：429 指数退避持续重试；5xx/网络按 retries 重试；length 截断自动抬 max_tokens"""
    note = on_note or (lambda m: None)
    ceiling = max(int(max_tokens or cfg["max_tokens"]), int(cfg["max_tokens_ceiling"]))
    limit = int(max_tokens or cfg["max_tokens"])
    rl, normal = 0, 0
    max_field = "max_tokens"
    while True:
        r = chat(base_url, api_key, model, system, user, cfg, max_tokens=limit, temperature=temperature, max_field=max_field)
        if r["ok"]:
            if str(r.get("finish", "")).lower() == "length" and limit < ceiling:
                prev = limit
                limit = min(limit * 2, ceiling)
                note("输出在 %d token 处截断，提高到 %d 后重试" % (prev, limit))
                continue
            r["rl_retries"] = rl
            return r
        st = r.get("status") or 0
        if st == 400 and max_field == "max_tokens" and ("max_tokens" in r["error"] or "max_completion_tokens" in r["error"]):
            max_field = "max_completion_tokens"
            note("端点拒收 max_tokens（400），已自动改用 max_completion_tokens 重发")
            continue
        if "超时" in r["error"] or "timed out" in r["error"].lower() or "timeout" in r["error"].lower():
            note("请求超时（%s）" % r["error"][:80])
            r["timed_out"] = True
            return r
        if st == 429 and rl < int(cfg["rl_retries"]):
            rl += 1
            wait = cfg["rl_base"] * (2 ** min(rl - 1, 6))
            try:
                ra = float(r.get("retry_after") or 0)
                if ra > 0:
                    wait = ra
            except Exception:
                pass
            wait = max(1.0, min(float(wait), float(cfg["rl_cap"])))
            note("遇到 429 限流，等待 %ds 后重试（第 %d 次）" % (round(wait), rl))
            time.sleep(wait)
            continue
        if st in (0, 429) or st >= 500:
            if normal < int(cfg["retries"]):
                normal += 1
                time.sleep(min(2 ** normal, 8))
                continue
        r["rl_retries"] = rl
        return r


# ==================== 业务动作 ====================
def ask_question(base_url, api_key, model, q, cfg, on_note=None):
    """答一道学科题并判分。返回 row dict（含 ok/got/raw/grade_how/latency/tokens/error）"""
    t0 = time.time()
    row = {"qid": q["id"], "no": q["no"], "group": q["group"], "type": q["type"],
           "level": q["level"], "model": model, "expected": q["answer"],
           "ok": False, "got": "", "raw": "", "grade_how": "", "followup": False,
           "latency": 0, "tokens": None, "error": "", "t": time.time()}
    r = chat_retry(base_url, api_key, model, QUESTION_SYSTEM, build_question_prompt(q),
                   cfg, max_tokens=cfg["max_tokens"], temperature=0.0, on_note=on_note)
    row["latency"] = int((time.time() - t0) * 1000)
    if not r["ok"]:
        row["error"] = r["error"] or "请求失败"
        return row
    row["tokens"] = r["tokens"]
    row["raw"] = r["content"]
    ok, how, hit = grade_answer(q, answer_candidates(r["content"]))
    # 有推理但没给出可判定的最终答案 → 追加一次短请求只让它补答案
    if not ok and r["content"].strip():
        fu = chat_retry(base_url, api_key, model, QUESTION_SYSTEM,
                        "你刚才的分析如下：\n\n%s\n\n请只输出最终答案，格式必须为：答案：<答案>"
                        % r["content"][:4000],
                        cfg, max_tokens=64, temperature=0.0, on_note=on_note)
        if fu["ok"] and fu["content"].strip():
            row["raw"] = r["content"] + "\n\n[补答]\n" + fu["content"]
            row["tokens"] = (r["tokens"] or 0) + (fu["tokens"] or 0)
            row["latency"] = int((time.time() - t0) * 1000)
            row["followup"] = True
            ok, how, hit = grade_answer(
                q, answer_candidates(fu["content"]) + answer_candidates(r["content"]))
    row["ok"] = ok
    row["got"] = hit or extract_answer_line(r["content"])
    row["grade_how"] = how
    if not ok and not row["error"]:
        row["error"] = "答案不符" if r["content"] else "空响应"
    return row


def gen_svg(base_url, api_key, model, task, cfg, on_note=None):
    """生成 SVG 动画。返回 row dict（含 svg/raw/error）"""
    t0 = time.time()
    row = {"task_id": task["id"], "title": task["title"], "model": model,
           "ok": False, "svg": "", "raw": "", "latency": 0, "tokens": None,
           "error": "", "t": time.time()}
    r = chat_retry(base_url, api_key, model, SVG_SYSTEM, build_svg_prompt(task), cfg,
                   max_tokens=cfg["svg_max_tokens"], temperature=cfg["svg_temperature"],
                   on_note=on_note)
    row["latency"] = int((time.time() - t0) * 1000)
    if not r["ok"]:
        row["error"] = r["error"] or "请求失败"
        return row
    row["tokens"] = r["tokens"]
    row["raw"] = r["content"]
    svg = extract_svg(r["content"])
    if not svg:
        row["error"] = "未从回复中解析出 <svg>"
        return row
    row["svg"] = svg
    row["ok"] = True
    return row


def judge_svg_source(base_url, api_key, model, task, svg, cfg):
    """源码评审（MiniApp 无浏览器渲染，无法截帧，仅按源码 + 评分维度评）"""
    crit = "\n".join("%d. %s" % (i + 1, c) for i, c in enumerate(task["criteria"]))
    user = "\n".join([
        "你是严格的 SVG 动画评审专家（视觉裁判）。",
        "作品主题：%s（%s）" % (task["title"], task["brief"]),
        "",
        "评分维度：",
        crit,
        "",
        "注意：本次评审只能看到 SVG 源码（无法渲染截图），请仅依据源码判断结构完整性与动画正确性，",
        "并明确指出「仅源码评审」这一局限。",
        "",
        "【源码】",
        "```svg",
        str(svg or "")[:6000],
        "```",
        "",
        "请只输出一个 JSON 对象，不要任何额外文字：",
        '{"score": 0-100 的整数, "stars": 0-5 的整数, "verdict": "一句话总评",',
        ' "criteria": [{"name":"评分维度名","pass":true,"comment":"简短理由"}],',
        ' "problems": ["主要问题"], "suggestions": ["改进建议"]}',
    ])
    r = chat_retry(base_url, api_key, model, "你是严格的 SVG 动画评审专家，只输出 JSON。",
                   user, cfg, max_tokens=2048, temperature=0.0)
    out = {"ok": False, "judge": None, "raw": "", "error": "", "latency": r["latency"], "tokens": r.get("tokens")}
    if not r["ok"]:
        out["error"] = r["error"] or "裁判请求失败"
        return out
    out["raw"] = r["content"]
    out["judge"] = parse_judge_json(r["content"])
    if not out["judge"]:
        out["error"] = "裁判输出无法解析为 JSON"
        return out
    out["ok"] = True
    return out


def parse_judge_json(text):
    t = str(text or "")
    tries = []
    m = _SVG_RE.search(t)  # ```json ... ``` 与 SVG 围栏同形
    if m:
        tries.append(m.group(1))
    s = t.find("{")
    if s >= 0:
        depth, end = 0, -1
        for i in range(s, len(t)):
            if t[i] == "{":
                depth += 1
            elif t[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end > s:
            tries.append(t[s:end + 1])
    tries.append(t)
    for cand in tries:
        try:
            j = json.loads(cand)
        except Exception:
            continue
        if isinstance(j, dict):
            score = max(0, min(100, int(round(float(j.get("score") or 0)))))
            stars = j.get("stars")
            try:
                stars = max(0, min(5, int(round(float(stars)))))
            except Exception:
                stars = max(0, min(5, int(round(score / 20.0))))
            crit = []
            for c in (j.get("criteria") or []):
                if isinstance(c, dict):
                    crit.append({"name": str(c.get("name") or ""), "pass": bool(c.get("pass")),
                                 "comment": str(c.get("comment") or "")})
            return {
                "score": score, "stars": stars, "verdict": str(j.get("verdict") or ""),
                "criteria": crit,
                "problems": [str(x) for x in (j.get("problems") or [])],
                "suggestions": [str(x) for x in (j.get("suggestions") or [])],
            }
    return None


# ==================== 批量执行 ====================
def run_questions(base_url, api_key, model, questions, cfg, on_row=None, on_progress=None,
                  should_stop=None):
    """同一模型内并发答题；返回按题号排序的 row 列表"""
    rows, lock = [], __import__("threading").Lock()
    total = len(questions)

    def task(i, q):
        if should_stop and should_stop():
            return
        if on_progress:
            on_progress(model, q, i + 1, total)
        row = ask_question(base_url, api_key, model, q, cfg,
                           on_note=lambda m: on_progress and on_progress(model, q, i + 1, total, m))
        with lock:
            rows.append(row)
        if on_row:
            on_row(row)

    with ThreadPoolExecutor(max_workers=max(1, int(cfg.get("threads", 2)))) as pool:
        futs = [pool.submit(task, i, q) for i, q in enumerate(questions)]
        for f in futs:
            try:
                f.result()
            except Exception:
                pass
    rows.sort(key=lambda r: r["no"])
    return rows


def model_stats(entry):
    q = entry.get("q") or []
    svg = entry.get("svg") or []
    judged = [r for r in svg if r.get("judge")]
    correct = sum(1 for r in q if r["ok"])
    lat = [r["latency"] for r in q if r.get("latency")]
    stars = [r["judge"]["stars"] for r in judged]
    return {
        "q_total": len(q), "q_correct": correct, "q_wrong": len(q) - correct,
        "q_rate": round(correct / len(q) * 100) if q else None,
        "svg_total": len(svg), "svg_judged": len(judged),
        "svg_avg_stars": (round(sum(stars) / len(stars), 1) if stars else None),
        "avg_latency": (round(sum(lat) / len(lat)) if lat else None),
        "tokens": sum((r.get("tokens") or 0) for r in q) + sum((r.get("tokens") or 0) for r in svg),
    }


def group_stats(q_rows):
    out = []
    for g in GROUPS:
        rs = [r for r in q_rows if r["group"] == g["key"]]
        if not rs:
            continue
        ok = sum(1 for r in rs if r["ok"])
        out.append({"key": g["key"], "label": g["label"], "total": len(rs), "ok": ok,
                    "rate": round(ok / len(rs) * 100)})
    return out


def stars_text(n):
    n = max(0, min(5, int(n or 0)))
    return "★" * n + "☆" * (5 - n)


def build_share_text(models):
    """一键分享用的 Markdown 文本"""
    lines = ["🧠 模型智商检测报告", "时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"), ""]
    ordered = sorted(models, key=lambda m: -(model_stats(m)["q_rate"] or -1))
    for i, m in enumerate(ordered, 1):
        st = model_stats(m)
        lines.append("【%d】%s" % (i, m["model"]))
        rate = "—" if st["q_rate"] is None else "%d%%" % st["q_rate"]
        lines.append("  学科题：%s（%d/%d）" % (rate, st["q_correct"], st["q_total"]))
        gs = " · ".join("%s %d/%d" % (g["label"], g["ok"], g["total"]) for g in group_stats(m.get("q") or []))
        if gs:
            lines.append("  分类：%s" % gs)
        if st["svg_judged"]:
            lines.append("  SVG 动画：%s %.1f★（%d 题）" % (stars_text(round(st["svg_avg_stars"])),
                                                          st["svg_avg_stars"], st["svg_judged"]))
        wrong = [r["qid"] for r in (m.get("q") or []) if not r["ok"]]
        if wrong:
            lines.append("  错题：%s%s" % ("、".join(wrong[:6]), " 等" if len(wrong) > 6 else ""))
        lines.append("")
    lines.append("—— 由「模型智商检测」生成")
    return "\n".join(lines)


def build_csv(models):
    """明细 CSV（不含 API Key）"""
    def cell(v):
        return '"%s"' % str("" if v is None else v).replace('"', '""')

    def row(arr):
        return ",".join(cell(x) for x in arr)

    lines = [row(["模型智商检测报告"]), row(["时间", time.strftime("%Y-%m-%d %H:%M:%S")]), ""]
    lines.append(row(["模型成绩"]))
    lines.append(row(["模型", "正确率", "答对/题数", "SVG平均星", "平均延迟ms", "Tokens"]))
    for m in models:
        st = model_stats(m)
        lines.append(row([m["model"], st["q_rate"], "%d/%d" % (st["q_correct"], st["q_total"]),
                          st["svg_avg_stars"], st["avg_latency"], st["tokens"]]))
    lines.append("")
    lines.append(row(["逐题明细"]))
    lines.append(row(["模型", "题号", "题型", "结果", "期望答案", "模型答案", "延迟ms", "Tokens", "详情"]))
    for m in models:
        for r in (m.get("q") or []):
            lines.append(row([m["model"], r["qid"], r["type"], "通过" if r["ok"] else "未通过",
                              r["expected"], r["got"], r["latency"], r["tokens"],
                              r["error"] or ""]))
        for r in (m.get("svg") or []):
            j = r.get("judge") or {}
            lines.append(row([m["model"], r["task_id"], r["title"],
                              "通过" if j.get("score", 0) >= 60 else "未通过",
                              "按评分维度评审", ("%s分/%s星" % (j.get("score"), j.get("stars"))) if j else "",
                              r["latency"], r["tokens"], r["error"] or j.get("verdict", "")]))
    return "\ufeff" + "\r\n".join(lines) + "\r\n"


# 兼容旧入口名
run_step = ask_question
