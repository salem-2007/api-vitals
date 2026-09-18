# services.py — API 测试 + 聊天业务逻辑
import json
import random
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

GAP_SECONDS = 0.5

DEFAULT_PROMPTS = [
    {"label": "文本摘要", "user": "请用一句话概括：机器学习是人工智能的一个分支，通过算法让计算机从数据中学习规律，而无需显式编程。", "expect": "机器学习"},
    {"label": "数学计算", "user": "计算 17 × 23 + 45 的结果，只输出数字。", "expect": "436"},
    {"label": "JSON 生成", "user": "请输出一个包含 name 和 age 两个字段的 JSON 对象，name 为 Alice，age 为 30。只输出 JSON，不要其他文字。", "expect": "Alice"},
    {"label": "翻译任务", "user": "将以下句子翻译成英文：今天天气很好，适合出去散步。", "expect": "weather"},
    {"label": "逻辑推理", "user": "小明比小红高，小红比小刚高，那么三人中谁最矮？只回答名字。", "expect": "小刚"},
    {"label": "常识问答", "user": "水的化学式是什么？只输出化学式。", "expect": "H2O"},
    {"label": "单位换算", "user": "把 2.5 千米换算成米，只输出数字。", "expect": "2500"},
    {"label": "分类判断", "user": "判断这条评论是正面还是负面（只输出：正面 或 负面）：这家店的菜太咸了，服务也很慢。", "expect": "负面"},
]

def fetch_models(base_url, api_key):
    url = base_url.rstrip("/") + "/models"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + api_key})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    ids = []
    for item in data.get("data", []):
        mid = item.get("id") if isinstance(item, dict) else item
        if mid:
            ids.append(str(mid))
    return sorted(dict.fromkeys(ids))

def _speed(content, tokens, latency_ms):
    if not latency_ms or latency_ms <= 0:
        return None, None
    if tokens:
        return round(tokens / latency_ms * 1000, 1), "tok/s"
    if content:
        return round(len(content) / latency_ms * 1000, 1), "char/s"
    return None, None

def test_one(base_url, api_key, model, prompt):
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你是一个有用的助手。请准确回答用户的问题。"},
            {"role": "user", "content": prompt["user"]},
        ],
        "max_tokens": 200,
        "temperature": 0,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            latency = int((time.time() - t0) * 1000)
            resp = json.loads(r.read())
        content = ""
        tokens = None
        try:
            content = (resp["choices"][0]["message"]["content"] or "").strip()
            tokens = (resp.get("usage") or {}).get("completion_tokens")
        except Exception:
            pass
        speed, unit = _speed(content, tokens, latency)
        ok = True
        err = ""
        expect = prompt.get("expect")
        if expect and expect.lower() not in content.lower():
            ok = False
            err = "缺少关键词「" + expect + "」"
        if not content:
            ok = False
            err = "模型返回空内容"
        return {
            "t": time.time(), "model": model, "label": prompt["label"],
            "pass": ok, "error": err, "latency_ms": latency,
            "speed": speed, "speed_unit": unit,
            "preview": (content[:80] + "...") if len(content) > 80 else content,
        }
    except Exception as e:
        latency = int((time.time() - t0) * 1000)
        msg = str(e)
        try:
            if hasattr(e, "read"):
                body = json.loads(e.read())
                msg = body.get("error", {}).get("message", msg)
        except Exception:
            pass
        return {
            "t": time.time(), "model": model,
            "label": prompt.get("label", ""),
            "pass": False, "error": msg, "latency_ms": latency,
            "speed": None, "speed_unit": None, "preview": "",
        }

def chat_send(base_url, api_key, model, messages, max_tokens=1024):
    """调用 /chat/completions，返回 (reply_text, latency_ms, speed, speed_unit, error)"""
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            latency = int((time.time() - t0) * 1000)
            resp = json.loads(r.read())
        content = (resp["choices"][0]["message"]["content"] or "").strip()
        tokens = (resp.get("usage") or {}).get("completion_tokens")
        spd, unit = _speed(content, tokens, latency)
        return content, latency, spd, unit, None
    except Exception as e:
        latency = int((time.time() - t0) * 1000)
        msg = str(e)
        try:
            if hasattr(e, "read"):
                body = json.loads(e.read())
                msg = body.get("error", {}).get("message", msg)
        except Exception:
            pass
        return "", latency, None, None, msg

run_step = test_one

def run_all_tests(base_url, api_key, models, prompts, gap=0.5, threads=1,
                  on_progress=None, on_log=None, should_stop=None):
    """
    串行/并行测试模型。
    threads=1：完全串行，保留原有行为（含 cooldown 中断检测）。
    threads>1：使用线程池并行，cooldown 在整体结束后生效（避免并发时被截断）。
    """
    if not models:
        try:
            models = fetch_models(base_url, api_key)
        except Exception as e:
            return {"error": "拉取模型失败: " + str(e)}
    if not prompts:
        return {"error": "没有可用提示词"}

    results = []
    t0 = time.time()
    total = len(models)
    threads = max(1, int(threads or 1))

    if on_progress:
        on_progress("", "", 0, total)

    # 并行分支
    if threads > 1:
        order = []
        lock = threading.Lock()

        def _task(i, model):
            if should_stop and should_stop():
                return
            prompt = prompts[i % len(prompts)]
            if on_progress:
                on_progress(model, prompt["label"], i + 1, total)
            row = test_one(base_url, api_key, model, prompt)
            with lock:
                order.append((i, row))
            if on_log:
                on_log(row)

        with ThreadPoolExecutor(max_workers=threads) as pool:
            futs = [pool.submit(_task, i, m) for i, m in enumerate(models)]
            for f in futs:
                if should_stop and should_stop():
                    pool.shutdown(wait=False, cancel_futures=True)
                    break
                try:
                    f.result()
                except Exception:
                    pass
        results = [r for _, r in sorted(order)]
        if should_stop and should_stop():
            _prog_stopped = True
        # 并行时在结果全部收齐后再做 cooldown
        if gap > 0 and not (should_stop and should_stop()):
            deadline = time.time() + gap
            while time.time() < deadline:
                if should_stop and should_stop():
                    break
                time.sleep(0.1)
    else:
        # 串行分支（与旧行为一致）
        _prog_stopped = False
        for i, model in enumerate(models):
            if should_stop and should_stop():
                _prog_stopped = True
                break
            prompt = prompts[i % len(prompts)]
            if on_progress:
                on_progress(model, prompt["label"], i + 1, total)
            row = test_one(base_url, api_key, model, prompt)
            results.append(row)
            if on_log:
                on_log(row)
            if on_progress:
                on_progress(model, prompt["label"], i + 1, total)
            if i < total - 1 and gap > 0:
                deadline = time.time() + gap
                while time.time() < deadline:
                    if should_stop and should_stop():
                        _prog_stopped = True
                        break
                    time.sleep(0.1)
                if _prog_stopped:
                    break

    available = [r["model"] for r in results if r["pass"]]
    failed = [r for r in results if not r["pass"]]
    return {
        "results": results, "available": available, "failed": failed,
        "elapsed": round(time.time() - t0, 1),
        "passed": sum(1 for r in results if r["pass"]),
        "failed_count": sum(1 for r in results if not r["pass"]),
        "total": len(results),
        "stopped": bool(should_stop and should_stop()),
    }