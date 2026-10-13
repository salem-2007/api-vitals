# -*- coding: utf-8 -*-
"""main.py — 模型智商检测 · MiniApp 版

3 个 Tab：检测（跑题） / 成绩（结果与分享） / 配置
题库与桌面版完全一致（bank_data.py 由 questions.js 生成）。
业务逻辑全部在 services.py（可脱离 AppUI 单测：python3 tools/test_miniapp.py）。
"""

import json
import threading
import time

import appui
import haptics
import storage

from bank_data import GROUPS, QUESTIONS, SVG_TASKS
import services

CFG_KEY = "iq_cfg_v1"
ST_KEY = "iq_state_v1"
SVG_KEY = "iq_svg_%s_%s"
SYNC_INTERVAL = 0.4

# ==================== 调色板（自适应深浅）====================
_LIGHT = {
    'bg': '#F2F2F7', 'card': '#FFFFFF', 'border': '#D1D1D6',
    'muted': '#5C5C60', 'secondary': '#48484A', 'text': '#000000',
    'accent': '#15803D', 'green': '#15803D', 'red': '#C1121F',
    'yellow': '#B25E00', 'blue': '#0058D4', 'teal': '#00707F', 'purple': '#5B21B6',
}
_DARK = {
    'bg': '#000000', 'card': '#1C1C1E', 'border': '#48484A',
    'muted': '#B0B0B6', 'secondary': '#B8B8BD', 'text': '#FFFFFF',
    'accent': '#4ADE80', 'green': '#4ADE80', 'red': '#FF6B62',
    'yellow': '#FFD60A', 'blue': '#5EB0FF', 'teal': '#7DDDFC', 'purple': '#C4B5FD',
}


def _is_dark():
    try:
        mode = state.theme_mode
    except Exception:
        mode = "auto"
    if mode == "dark":
        return True
    if mode == "light":
        return False
    for probe in ("get_appearance", "appearance", "color_scheme"):
        try:
            v = getattr(appui, probe)
            v = v() if callable(v) else v
            if isinstance(v, str):
                low = v.lower()
                if low.startswith("d"):
                    return True
                if low.startswith("l"):
                    return False
        except Exception:
            pass
    for probe in ("is_dark", "get_is_dark"):
        try:
            return bool(getattr(appui, probe)())
        except Exception:
            pass
    return False


def C(name):
    return (_DARK if _is_dark() else _LIGHT)[name]


# ==================== 存储 ====================
def _get(key):
    for getter in [lambda: storage.get_json(key, None),
                   lambda: json.loads(storage.get(key, None) or "null")]:
        try:
            v = getter()
            if isinstance(v, dict):
                return v
        except Exception:
            pass
    return {}


def _put(key, obj):
    for setter in [lambda: storage.set_json(key, obj),
                   lambda: storage.set(key, json.dumps(obj, ensure_ascii=False))]:
        try:
            setter()
            return True
        except Exception:
            pass
    return False


def _safe_name(s):
    return "".join(ch if (ch.isalnum() or ch in "._-") else "_" for ch in str(s))[:60] or "x"


def save_cfg():
    _put(CFG_KEY, {
        "base_url": state.base_url, "api_key": state.api_key,
        "models": list(state.models), "sel_models": list(state.sel_models),
        "q_on": list(state.q_on), "svg_on": bool(state.svg_on),
        "judge_on": bool(state.judge_on), "judge_model": state.judge_model,
        "threads": int(state.threads), "timeout": int(state.timeout),
        "max_tokens": int(state.max_tokens), "theme_mode": state.theme_mode,
    })


def mask(key):
    if not key:
        return ""
    return "•" * 8 + key[-4:] if len(key) > 4 else "•" * 6


# ==================== 状态 ====================
_cfg = _get(CFG_KEY)
_key = _cfg.get("api_key", "") or ""
_all_ids = [q["id"] for q in QUESTIONS]

state = appui.State(
    base_url=_cfg.get("base_url", "https://api.openai.com/v1"),
    api_key=_key,
    key_masked=mask(_key),
    show_key=True,
    models=list(_cfg.get("models", [])),
    sel_models=list(_cfg.get("sel_models", [])),
    model_cat="idle",                 # idle | picker
    q_on=list(_cfg.get("q_on", _all_ids)) or list(_all_ids),
    q_cat="idle",                     # idle | picker
    svg_on=bool(_cfg.get("svg_on", True)),
    judge_on=bool(_cfg.get("judge_on", True)),
    judge_model=str(_cfg.get("judge_model", "")),
    threads=int(_cfg.get("threads", 2)),
    timeout=int(_cfg.get("timeout", 120)),
    max_tokens=int(_cfg.get("max_tokens", 4096)),
    theme_mode=str(_cfg.get("theme_mode", "auto")),
    new_model="",
    running=False,
    logs=[], results=[],
    done=0, total=0, now_model="", now_item="", status="准备就绪",
    elapsed=0.0, filter_mode="all",
    fetch_status="", cfg_status="", share_text="", svg_preview="",
    detail_key="",
)


def _assign(name, value):
    """只在值真的变化时写 state：避免无谓重绘"""
    try:
        cur = getattr(state, name)
    except Exception:
        cur = None
    if cur != value:
        try:
            setattr(state, name, value)
        except Exception:
            pass


# ==================== 后台执行 ====================
_lock = threading.Lock()
_pending = []
_prog = {}
_outcome = None
_fetch_out = {}
_stop = threading.Event()
_busy = threading.Event()
_busy.set()
_t0 = 0.0
_last_elapsed = [0.0]
_timer_on = [False]


def _ensure_timer():
    _timer_on[0] = True
    try:
        _timer.start()
    except Exception:
        pass


def _maybe_stop_timer():
    if state.running or not _busy.is_set():
        return
    _timer_on[0] = False
    try:
        _timer.stop()
    except Exception:
        pass


def _cfg_dict():
    return {
        "timeout": int(state.timeout), "max_tokens": int(state.max_tokens),
        "max_tokens_ceiling": max(int(state.max_tokens) * 2, 8192),
        "svg_max_tokens": 8192, "svg_temperature": 0.4,
        "retries": 2, "rl_retries": 6, "rl_base": 5, "rl_cap": 120,
        "threads": max(1, int(state.threads)),
    }


def _worker():
    global _outcome
    base, key = state.base_url, state.api_key
    questions = [q for q in QUESTIONS if q["id"] in state.q_on]
    tasks = list(SVG_TASKS) if state.svg_on else []
    models = list(state.sel_models) or list(state.models)
    if not models:
        try:
            models = services.fetch_models(base, key, timeout=15)
        except Exception as e:
            _outcome = {"error": "拉取模型失败: %s" % e}
            _busy.set()
            return
    if not models:
        _outcome = {"error": "没有可用模型"}
        _busy.set()
        return
    if not questions and not tasks:
        _outcome = {"error": "没有勾选任何测试项"}
        _busy.set()
        return

    cfg = _cfg_dict()
    total = len(models) * (len(questions) + len(tasks))
    _prog["total"] = total
    entries = []
    try:
        for mi, model in enumerate(models):
            entry = {"model": model, "q": [], "svg": []}
            entries.append(entry)
            _prog["model"] = model

            def _on_row(row, _m=model):
                with _lock:
                    _pending.append({
                        "model": _m, "qid": row["qid"], "type": row["type"],
                        "ok": row["ok"], "expected": row["expected"],
                        "got": row["got"], "latency": row["latency"],
                        "tokens": row.get("tokens"), "error": row["error"],
                        "raw": (row["raw"] or "")[:2000], "t": row["t"],
                    })

            def _on_prog(m, q, i, n, note=None, _m=model):
                _prog["item"] = "%s · %s" % (q["id"], q["type"])
                _prog["done"] = _prog.get("done", 0) + (1 if note is None else 0)

            if questions:
                rows = services.run_questions(base, key, model, questions, cfg,
                                              on_row=_on_row, on_progress=_on_prog,
                                              should_stop=lambda: _stop.is_set())
                entry["q"] = rows

            for task in tasks:
                if _stop.is_set():
                    break
                _prog["item"] = "%s · %s" % (task["title"], "生成 SVG")
                row = services.gen_svg(base, key, model, task, cfg)
                if row["ok"]:
                    _put(SVG_KEY % (_safe_name(model), task["id"]), {"svg": row["svg"], "title": task["title"]})
                    if state.judge_on:
                        _prog["item"] = "%s · %s" % (task["title"], "评审中")
                        jm = state.judge_model or model
                        jr = services.judge_svg_source(base, key, jm, task, row["svg"], cfg)
                        row["judge"] = jr.get("judge")
                        row["judge_model"] = jm
                        row["judge_error"] = jr.get("error", "")
                entry["svg"].append(row)
                _prog["done"] = _prog.get("done", 0) + 1
                with _lock:
                    _pending.append({
                        "model": model, "qid": task["id"], "type": "SVG " + task["title"],
                        "ok": bool(row.get("judge") and row["judge"]["score"] >= 60),
                        "expected": "按评分维度评审",
                        "got": ("%s分/%s星" % (row["judge"]["score"], row["judge"]["stars"])) if row.get("judge") else "",
                        "latency": row["latency"], "tokens": row.get("tokens"),
                        "error": row.get("error") or row.get("judge_error") or "",
                        "raw": (row.get("raw") or "")[:2000], "t": row["t"],
                    })
        _outcome = {"entries": entries}
    except Exception as e:
        _outcome = {"error": str(e)}
    _busy.set()


def _sync():
    """主线程唯一 state 写入口（Timer 驱动）"""
    global _outcome
    with _lock:
        batch = list(_pending)
        if _pending:
            del _pending[:]
    if batch:
        _assign("logs", list(state.logs) + batch)

    if state.running and _prog:
        _assign("done", _prog.get("done", state.done))
        _assign("total", _prog.get("total", state.total))
        _assign("now_model", _prog.get("model", ""))
        _assign("now_item", _prog.get("item", ""))
        if not _stop.is_set():
            _assign("status", "正在检测 %s · %s" % (_prog.get("model", ""), _prog.get("item", "")))
        now = time.time()
        if now - _last_elapsed[0] >= 1.0:
            _assign("elapsed", round(now - _t0, 1))
            _last_elapsed[0] = now

    if _outcome is not None:
        res = _outcome
        _outcome = None
        try:
            if "error" in res:
                _assign("status", "错误: " + res["error"])
            else:
                entries = res["entries"]
                _assign("results", entries)
                _put(ST_KEY, {"results": entries, "elapsed": round(time.time() - _t0, 1)})
                _assign("share_text", services.build_share_text(entries) if entries else "")
                qn = sum(len(e.get("q") or []) for e in entries)
                qok = sum(1 for e in entries for r in (e.get("q") or []) if r["ok"])
                _assign("status", "完成 · 学科题 %d/%d · SVG %d 张 · 耗时 %.1fs" % (
                    qok, qn, sum(len(e.get("svg") or []) for e in entries), time.time() - _t0))
                try:
                    haptics.notification('success' if qn and qok == qn else 'error')
                except Exception:
                    pass
        except Exception as e:
            _assign("status", "结果同步出错: %s" % e)
        finally:
            _assign("elapsed", round(time.time() - _t0, 1))
            _assign("running", False)
            _assign("now_model", "")
            _assign("now_item", "")
            _stop.clear()
            _busy.set()

    with _lock:
        fo = _fetch_out.pop("res", None)
    if fo:
        if fo.get("error"):
            _assign("fetch_status", "拉取失败: %s" % fo["error"])
        else:
            ms = list(fo.get("models", []))
            _assign("models", ms)
            if not state.sel_models:
                _assign("sel_models", ms)
            _assign("fetch_status", "拉取到 %d 个模型" % len(ms))
            save_cfg()
            try:
                haptics.notification('success')
            except Exception:
                pass

    _maybe_stop_timer()


_timer = appui.Timer(interval=SYNC_INTERVAL, action=_sync)


# ==================== 动作 ====================
def start_test():
    global _t0, _outcome
    if not _busy.is_set():
        _assign("status", "上一轮还没结束")
        return
    if not state.api_key.strip():
        _assign("status", "请先填写 API Key")
        return
    save_cfg()
    with _lock:
        del _pending[:]
    _prog.clear()
    _outcome = None
    _stop.clear()
    _busy.clear()
    _assign("logs", [])
    _assign("results", [])
    _assign("done", 0)
    _assign("total", 0)
    _assign("elapsed", 0.0)
    _assign("share_text", "")
    _assign("running", True)
    _assign("status", "正在准备…")
    _t0 = time.time()
    _last_elapsed[0] = 0.0
    _ensure_timer()
    threading.Thread(target=_worker, daemon=True).start()
    try:
        haptics.impact('medium')
    except Exception:
        pass


def stop_test():
    if not state.running:
        return
    if _busy.is_set():
        _assign("running", False)
        _assign("status", "已停止")
        return
    _stop.set()
    _assign("status", "正在停止…")


def clear_all():
    _assign("logs", [])
    _assign("results", [])
    _assign("share_text", "")
    _assign("done", 0)
    _assign("total", 0)
    _assign("elapsed", 0.0)
    _assign("status", "已清空")
    _put(ST_KEY, {"results": [], "elapsed": 0})


def set_filter(mode):
    _assign("filter_mode", mode if mode in ("all", "pass", "fail") else "all")


def toggle_model_picker():
    _assign("model_cat", "idle" if state.model_cat == "picker" else "picker")


def toggle_model(name):
    sel = list(state.sel_models)
    if name in sel:
        sel = [m for m in sel if m != name]
    else:
        sel.append(name)
    _assign("sel_models", sel)
    save_cfg()


def select_all_models(on):
    _assign("sel_models", list(state.models) if on else [])
    save_cfg()


def toggle_q_picker():
    _assign("q_cat", "idle" if state.q_cat == "picker" else "picker")


def toggle_question(qid):
    on = list(state.q_on)
    if qid in on:
        on = [x for x in on if x != qid]
    else:
        on.append(qid)
    _assign("q_on", on)
    save_cfg()


def set_group(group_key, on):
    ids = [q["id"] for q in QUESTIONS if q["group"] == group_key]
    cur = list(state.q_on)
    if on:
        cur = sorted(set(cur) | set(ids))
    else:
        cur = [x for x in cur if x not in ids]
    _assign("q_on", cur)
    save_cfg()


def toggle_svg():
    _assign("svg_on", not state.svg_on)
    save_cfg()


def toggle_judge():
    _assign("judge_on", not state.judge_on)
    save_cfg()


def set_judge_model(name):
    _assign("judge_model", "" if state.judge_model == name else name)
    save_cfg()


def toggle_key_view():
    _assign("show_key", not state.show_key)


def do_save_cfg():
    _assign("key_masked", mask(state.api_key))
    save_cfg()
    _assign("cfg_status", "配置已保存")


def do_clear_key():
    _assign("api_key", "")
    _assign("key_masked", "")
    _assign("show_key", True)
    save_cfg()


def do_add_model():
    n = state.new_model.strip()
    if n and n not in state.models:
        _assign("models", list(state.models) + [n])
        _assign("sel_models", sorted(set(list(state.sel_models) + [n])))
        _assign("new_model", "")
        save_cfg()


def do_del_model(name):
    _assign("models", [m for m in state.models if m != name])
    _assign("sel_models", [m for m in state.sel_models if m != name])
    save_cfg()


def _fetch_worker():
    try:
        ms = services.fetch_models(state.base_url, state.api_key, timeout=15)
        with _lock:
            _fetch_out["res"] = {"models": ms}
    except Exception as e:
        with _lock:
            _fetch_out["res"] = {"error": str(e)}


def do_fetch_models():
    if not state.api_key.strip():
        _assign("fetch_status", "请先填写 API Key")
        return
    _assign("fetch_status", "正在拉取…")
    _busy.clear()
    _ensure_timer()
    threading.Thread(target=_fetch_worker, daemon=True).start()


def set_threads(v):
    try:
        n = max(1, min(8, int(float(v))))
    except Exception:
        return
    _assign("threads", n)
    save_cfg()


def bump_threads(delta):
    set_threads(int(state.threads or 1) + delta)


def set_timeout(v):
    try:
        n = max(10, min(600, int(float(v))))
    except Exception:
        return
    _assign("timeout", n)
    save_cfg()


def set_max_tokens(v):
    try:
        n = max(256, min(32768, int(float(v))))
    except Exception:
        return
    _assign("max_tokens", n)
    save_cfg()


def set_theme(mode):
    _assign("theme_mode", mode if mode in ("auto", "light", "dark") else "auto")
    save_cfg()


def show_svg(model, task_id):
    key = SVG_KEY % (_safe_name(model), task_id)
    try:
        obj = storage.get_json(key, None) or {}
    except Exception:
        obj = {}
    svg = obj.get("svg") or ""
    _assign("svg_preview", svg[:3000] if svg else "（未找到该作品的 SVG 源码）")


def export_report():
    """导出报告（Markdown）到 storage，并把分享文本显示出来"""
    entries = state.results or []
    if not entries:
        _assign("cfg_status", "还没有结果可导出")
        return
    md = state.share_text or services.build_share_text(entries)
    _put("iq_report_%d" % int(time.time()), {"markdown": md})
    _assign("share_text", md)
    _assign("cfg_status", "报告已生成（见「成绩」页）")


def export_csv():
    entries = state.results or []
    if not entries:
        _assign("cfg_status", "还没有结果可导出")
        return
    csv_text = services.build_csv(entries)
    _put("iq_csv_%d" % int(time.time()), {"csv": csv_text})
    _assign("cfg_status", "CSV 已生成（含明细，不含 API Key）")


def animate_action(fn, anim_type='spring'):
    def _do():
        try:
            fn()
        except Exception as e:
            try:
                _assign("cfg_status", "操作失败: %s" % e)
            except Exception:
                pass
    try:
        appui.animate(_do, type=anim_type)
    except Exception:
        _do()


# ==================== 组件 ====================
def card_view(*children, padding=14):
    return appui.VStack(list(children), spacing=8).padding(padding).background(C('card')).cornerRadius(14)


def stat_pill(icon, color, value, label):
    return appui.VStack([
        appui.HStack([
            appui.Image(system_name=icon).foreground_color(color).font("body"),
            appui.Text(str(value)).font("headline").bold().foreground_color(color),
        ], spacing=4),
        appui.Text(label).font("footnote").foreground_color(C('muted')),
    ], spacing=2)


def progress_ring(pct, size=76, color=None):
    return appui.Gauge(value=max(0.0, min(1.0, float(pct or 0))),
                       label="%d%%" % int((pct or 0) * 100))


def section_header(title, icon=None, color=None):
    if icon:
        return appui.HStack([
            appui.Image(system_name=icon).foreground_color(color or C('accent')).font("subheadline"),
            appui.Text(title).font("headline").foreground_color(C('text')),
        ], spacing=6)
    return appui.Text(title).font("headline").foreground_color(C('text'))


def stars_text(n):
    return services.stars_text(n)


# ==================== 检测页 ====================
def log_row(rec):
    ok = rec["ok"]
    color = C('green') if ok else C('red')
    icon = 'checkmark.circle.fill' if ok else 'xmark.circle.fill'
    note = rec.get("error") or ("答：" + (rec.get("got") or "")) or ""
    rows = [
        appui.HStack([
            appui.Text("%s · %s" % (rec["qid"], rec["type"])).font("subheadline").bold()
                .foreground_color(C('text')),
            appui.Spacer(),
            appui.Text("%dms" % rec["latency"]).font("footnote").foreground_color(C('muted')),
        ]),
        appui.HStack([
            appui.Text(rec["model"]).font("footnote").foreground_color(C('secondary')),
            appui.Spacer(),
            appui.Text("期望 %s" % str(rec["expected"])[:24]).font("footnote")
                .foreground_color(C('muted')),
        ]),
    ]
    if note:
        rows.append(appui.Text(note[:90]).font("footnote").foreground_color(color))
    return appui.HStack([
        appui.ZStack([
            appui.Image(system_name="circle.fill").foreground_color(color + '22').font("title3"),
            appui.Image(system_name=icon).foreground_color(color).font("footnote"),
        ]),
        appui.VStack(rows, spacing=3),
    ], spacing=10).padding(vertical=4)


def filter_btn(label, mode, color):
    is_active = state.filter_mode == mode
    return appui.Button(label, action=lambda m=mode: animate_action(lambda: set_filter(m))
                        ).button_style("bordered_prominent" if is_active else "bordered"
                                       ).tint(color if is_active else C('muted'))


def test_tab():
    rows_all = state.logs
    ok_n = sum(1 for r in rows_all if r["ok"])
    fail_n = len(rows_all) - ok_n
    pct = (state.done / state.total) if state.total else 0.0
    items = []

    items.append(appui.Section([
        appui.HStack([
            appui.VStack([
                appui.Text("%d / %d" % (state.done, state.total))
                    .font("system", size=32, weight="bold").foreground_color(C('accent')),
                appui.Text("已完成 / 总数").font("footnote").foreground_color(C('muted')),
            ], spacing=4),
            appui.Spacer(),
            progress_ring(pct, 76, C('accent')),
        ]),
        appui.HStack([
            appui.Image(system_name="arrow.triangle.2.circlepath" if state.running else "checkmark.circle")
                .foreground_color(C('accent') if state.running else C('green')),
            appui.Text(state.status).font("footnote").bold()
                .foreground_color(C('accent') if state.running else C('muted')),
        ], spacing=6),
        appui.Text("端点 %s · 模型 %d · 题 %d · SVG %d" % (
            state.base_url, len(state.sel_models or state.models),
            len(state.q_on), len(SVG_TASKS) if state.svg_on else 0)
        ).font("footnote").foreground_color(C('muted')),
    ], header="进度"))

    is_busy = state.running and not _busy.is_set()
    items.append(appui.Section([
        appui.Button("停止检测" if is_busy else "开始检测",
                     action=lambda: animate_action(stop_test if is_busy else start_test)
                     ).button_style("bordered_prominent"
                                    ).tint(C('red') if is_busy else C('accent')),
        appui.Button("清空结果", action=lambda: animate_action(clear_all)
                     ).button_style("bordered").tint(C('muted')),
    ], header="操作"))

    if rows_all:
        items.append(appui.Section([
            appui.HStack([
                stat_pill("checkmark.circle.fill", C('green'), ok_n, "通过"),
                appui.Spacer(),
                stat_pill("xmark.circle.fill", C('red'), fail_n, "未通过"),
                appui.Spacer(),
                stat_pill("stopwatch", C('muted'), "%.1fs" % state.elapsed, "耗时"),
            ]),
            appui.HStack([
                filter_btn("全部", "all", C('accent')),
                filter_btn("通过", "pass", C('green')),
                filter_btn("未通过", "fail", C('red')),
            ]),
        ], header="汇总"))

    show = rows_all
    if state.filter_mode == "pass":
        show = [r for r in rows_all if r["ok"]]
    elif state.filter_mode == "fail":
        show = [r for r in rows_all if not r["ok"]]
    if show:
        hdr = {"all": "全部 %d 条", "pass": "通过 %d 条", "fail": "未通过 %d 条"}[state.filter_mode]
        items.append(appui.Section(
            [log_row(r) for r in show[-80:]],
            header=hdr % len(show)))

    if not rows_all and not state.running:
        items.append(appui.Section([
            appui.HStack([
                appui.Image(system_name="info.circle").foreground_color(C('accent')),
                appui.Text("先到「配置」页填 BaseURL / API Key 并拉取模型，再回来点开始。")
                    .font("footnote").foreground_color(C('muted')),
            ], spacing=6),
        ], header="说明"))

    return appui.NavigationStack(appui.List(items).navigation_title("模型智商检测"))


# ==================== 成绩页 ====================
def model_card(entry):
    st = services.model_stats(entry)
    rate = st["q_rate"]
    color = C('green') if (rate or 0) >= 80 else C('yellow') if (rate or 0) >= 50 else C('red')
    rows = [
        appui.HStack([
            appui.Text(entry["model"]).font("headline").bold().foreground_color(C('text')),
            appui.Spacer(),
            appui.Text("—" if rate is None else "%d%%" % rate).font("headline").bold()
                .foreground_color(color),
        ]),
        appui.Text("IQ 分 · %d/%d 题" % (st["q_correct"], st["q_total"]))
            .font("footnote").foreground_color(C('muted')),
    ]
    for g in services.group_stats(entry.get("q") or []):
        rows.append(appui.HStack([
            appui.Text(g["label"]).font("footnote").foreground_color(C('secondary')),
            appui.Spacer(),
            appui.Text("%d/%d" % (g["ok"], g["total"])).font("footnote").bold()
                .foreground_color(C('text')),
        ]))
    if st["svg_judged"]:
        rows.append(appui.Text("SVG 动画 %s %.1f★（%d 题）" % (
            stars_text(round(st["svg_avg_stars"])), st["svg_avg_stars"], st["svg_judged"]))
            .font("footnote").foreground_color(C('purple')))
    rows.append(appui.Text("平均延迟 %sms · Tokens %d" % (
        st["avg_latency"] if st["avg_latency"] is not None else "—", st["tokens"]))
        .font("footnote").foreground_color(C('muted')))
    return card_view(*rows)


def svg_row(entry, rec):
    judge = rec.get("judge") or {}
    ok = bool(judge.get("score", 0) >= 60)
    color = C('green') if ok else C('red') if judge else C('muted')
    rows = [
        appui.HStack([
            appui.Text(rec["title"]).font("subheadline").bold().foreground_color(C('text')),
            appui.Spacer(),
            appui.Text(("%d 分 %s" % (judge["score"], stars_text(judge["stars"]))) if judge else "未评审")
                .font("footnote").bold().foreground_color(color),
        ]),
        appui.Text(judge.get("verdict") or rec.get("error") or rec.get("judge_error") or "")
            .font("footnote").foreground_color(C('muted')),
    ]
    if judge.get("criteria"):
        for c in judge["criteria"]:
            rows.append(appui.HStack([
                appui.Image(system_name="checkmark.circle.fill" if c.get("pass") else "xmark.circle.fill")
                    .foreground_color(C('green') if c.get("pass") else C('red')).font("caption2"),
                appui.Text("%s%s" % (c.get("name", ""), (" — " + c["comment"]) if c.get("comment") else ""))
                    .font("footnote").foreground_color(C('secondary')),
            ], spacing=4))
    rows.append(appui.HStack([
        appui.Button("查看 SVG 源码",
                     action=lambda m=entry["model"], t=rec["task_id"]: animate_action(lambda: show_svg(m, t))
                     ).button_style("bordered").tint(C('teal')).font("footnote"),
        appui.Text("仅源码评审（MiniApp 无法渲染动画）").font("caption2").foreground_color(C('muted')),
    ], spacing=8))
    return card_view(*rows)


def result_tab():
    items = []
    entries = state.results or []
    if not entries:
        items.append(appui.Section([
            appui.HStack([
                appui.Image(system_name="chart.bar").foreground_color(C('muted')),
                appui.Text("还没有成绩，先去「检测」页跑一轮。").font("footnote")
                    .foreground_color(C('muted')),
            ], spacing=6),
        ], header="成绩"))
        return appui.NavigationStack(appui.List(items).navigation_title("成绩"))

    ordered = sorted(entries, key=lambda e: -(services.model_stats(e)["q_rate"] or -1))
    items.append(appui.Section([model_card(e) for e in ordered], header="模型成绩（%d）" % len(ordered)))

    for e in ordered:
        svgs = e.get("svg") or []
        if svgs:
            items.append(appui.Section([svg_row(e, r) for r in svgs],
                                       header="SVG 动画 · %s" % e["model"]))

    if state.svg_preview:
        items.append(appui.Section([
            appui.Text(state.svg_preview).font("caption2").foreground_color(C('secondary')),
        ], header="SVG 源码预览", footer="完整源码已存入 storage（键名 iq_svg_<模型>_<题号>）。"))

    share = state.share_text or services.build_share_text(entries)
    items.append(appui.Section([
        appui.Text(share).font("footnote").foreground_color(C('text')),
        appui.Button("导出报告 Markdown", action=lambda: animate_action(export_report)
                     ).button_style("bordered_prominent").tint(C('accent')),
        appui.Button("导出明细 CSV", action=lambda: animate_action(export_csv)
                     ).button_style("bordered").tint(C('teal')),
        appui.Text(state.cfg_status).font("footnote").foreground_color(C('green')),
    ], header="分享报告", footer="复制上面的文本即可分享；报告与 CSV 均不含 API Key。"))

    return appui.NavigationStack(appui.List(items).navigation_title("成绩"))


# ==================== 配置页 ====================
def config_tab():
    key_field = (appui.SecureField(placeholder="sk-...", text=state.api_key,
                                   on_change=lambda v: setattr(state, 'api_key', v))
                 if not state.show_key else
                 appui.TextField(placeholder="sk-...", text=state.api_key,
                                 on_change=lambda v: setattr(state, 'api_key', v)))
    fetch_ok = "拉取到" in state.fetch_status
    fetch_err = "拉取失败" in state.fetch_status

    def theme_btn(label, mode):
        active = state.theme_mode == mode
        return appui.Button(label, action=lambda m=mode: animate_action(lambda: set_theme(m))
                            ).button_style("bordered_prominent" if active else "bordered"
                                           ).tint(C('accent') if active else C('muted'))

    model_rows = []
    sel = set(state.sel_models or [])
    for m in state.models:
        is_sel = m in sel
        model_rows.append(appui.HStack([
            appui.Image(system_name="checkmark.circle.fill" if is_sel else "circle")
                .foreground_color(C('accent') if is_sel else C('border')).font("body"),
            appui.Text(m).font("subheadline").foreground_color(C('text') if is_sel else C('secondary')),
            appui.Spacer(),
            appui.Button("删除", action=lambda n=m: animate_action(lambda: do_del_model(n))
                         ).foreground_color(C('red')).font("footnote"),
        ]).on_tap(lambda n=m: animate_action(lambda: toggle_model(n))))

    q_rows = []
    for q in QUESTIONS:
        on = q["id"] in state.q_on
        q_rows.append(appui.HStack([
            appui.Image(system_name="checkmark.circle.fill" if on else "circle")
                .foreground_color(C('accent') if on else C('border')).font("footnote"),
            appui.Text("%d. %s" % (q["no"], q["type"])).font("footnote")
                .foreground_color(C('text') if on else C('muted')),
            appui.Spacer(),
        ]).on_tap(lambda i=q["id"]: animate_action(lambda: toggle_question(i))))

    group_rows = []
    for g in GROUPS:
        ids = [q["id"] for q in QUESTIONS if q["group"] == g["key"]]
        on = sum(1 for i in ids if i in state.q_on)
        group_rows.append(appui.HStack([
            appui.Text(g["label"]).font("subheadline").bold().foreground_color(C('text')),
            appui.Spacer(),
            appui.Text("%d/%d" % (on, len(ids))).font("footnote").foreground_color(C('muted')),
            appui.Button("全选", action=lambda k=g["key"]: animate_action(lambda: set_group(k, True))
                         ).button_style("bordered").tint(C('accent')).font("footnote"),
            appui.Button("清空", action=lambda k=g["key"]: animate_action(lambda: set_group(k, False))
                         ).button_style("bordered").tint(C('muted')).font("footnote"),
        ], spacing=6))

    judge_rows = []
    if state.judge_on:
        judge_rows.append(appui.HStack([
            appui.Image(system_name="checkmark.circle.fill" if not state.judge_model else "circle")
                .foreground_color(C('accent') if not state.judge_model else C('border')).font("footnote"),
            appui.Text("跟随被测模型").font("footnote").foreground_color(C('secondary')),
        ]).on_tap(lambda: animate_action(lambda: set_judge_model(""))))
        for m in (state.sel_models or state.models):
            is_sel = state.judge_model == m
            judge_rows.append(appui.HStack([
                appui.Image(system_name="checkmark.circle.fill" if is_sel else "circle")
                    .foreground_color(C('accent') if is_sel else C('border')).font("footnote"),
                appui.Text(m).font("footnote").foreground_color(C('text') if is_sel else C('secondary')),
                appui.Spacer(),
            ]).on_tap(lambda n=m: animate_action(lambda: set_judge_model(n))))

    return appui.NavigationStack(appui.Form([
        appui.Section([
            appui.HStack([theme_btn("自动", "auto"), theme_btn("浅色", "light"), theme_btn("深色", "dark")]),
            appui.Text({"auto": "跟随系统外观", "light": "强制浅色", "dark": "强制深色"}[state.theme_mode])
                .font("footnote").foreground_color(C('muted')),
        ], header="外观"),
        appui.Section([
            appui.TextField(placeholder="https://api.openai.com/v1", text=state.base_url,
                            on_change=lambda v: setattr(state, 'base_url', v)),
            key_field,
            appui.HStack([
                appui.Image(system_name="lock.fill" if state.key_masked else "lock.open")
                    .foreground_color(C('green') if state.key_masked else C('red')),
                appui.Text(("已保存 " + state.key_masked) if state.key_masked else "未填写 API Key")
                    .font("footnote").foreground_color(C('green') if state.key_masked else C('red')),
            ], spacing=6),
            appui.Text(state.cfg_status).font("footnote").bold()
                .foreground_color(C('green') if state.cfg_status else C('muted')),
            appui.HStack([
                appui.Button("保存", action=lambda: animate_action(do_save_cfg)
                             ).button_style("bordered_prominent").tint(C('accent')),
                appui.Button("清除", action=lambda: animate_action(do_clear_key)
                             ).button_style("bordered").tint(C('red')),
                appui.Button("隐藏" if state.show_key else "显示",
                             action=lambda: animate_action(toggle_key_view)
                             ).button_style("bordered").tint(C('muted')),
            ]),
        ], header="API 配置", footer="保存后重启自动恢复；导出报告不含 Key。"),
        appui.Section([
            appui.Button("从 API 拉取模型", action=lambda: animate_action(do_fetch_models)
                         ).button_style("bordered_prominent").tint(C('accent')),
            appui.HStack([
                appui.Image(system_name="checkmark.circle.fill" if fetch_ok else
                            "xmark.circle.fill" if fetch_err else "arrow.triangle.2.circlepath")
                    .foreground_color(C('green') if fetch_ok else C('red') if fetch_err else C('muted')),
                appui.Text(state.fetch_status).font("footnote").bold()
                    .foreground_color(C('green') if fetch_ok else C('red') if fetch_err else C('muted')),
            ], spacing=6),
            appui.HStack([
                appui.TextField("手动添加模型", text=state.new_model,
                                on_change=lambda v: setattr(state, 'new_model', v)),
                appui.Button("添加", action=lambda: animate_action(do_add_model)
                             ).button_style("bordered").tint(C('accent')),
            ]),
            appui.HStack([
                appui.Button("全选", action=lambda: animate_action(lambda: select_all_models(True))
                             ).button_style("bordered").tint(C('accent')).font("footnote"),
                appui.Button("全不选", action=lambda: animate_action(lambda: select_all_models(False))
                             ).button_style("bordered").tint(C('muted')).font("footnote"),
                appui.Spacer(),
                appui.Text("已选 %d / %d" % (len(state.sel_models), len(state.models)))
                    .font("footnote").foreground_color(C('muted')),
            ], spacing=6),
        ] + model_rows, header="模型（点行选中）",
           footer="未选中任何模型时，检测会自动拉取并测试全部模型。"),
        appui.Section([
            appui.HStack([
                appui.Image(system_name="square.stack.3d.up").foreground_color(C('blue')),
                appui.Text("并发答题数").font("subheadline").bold().foreground_color(C('text')),
                appui.Spacer(),
                appui.Button("-", action=lambda: animate_action(lambda: bump_threads(-1))
                             ).button_style("bordered").tint(C('muted')),
                appui.Text("%d" % state.threads).font("headline").bold().foreground_color(C('blue')),
                appui.Button("+", action=lambda: animate_action(lambda: bump_threads(1))
                             ).button_style("bordered").tint(C('blue')),
            ], spacing=8),
            appui.TextField("单请求超时（秒）", text=str(state.timeout), on_change=set_timeout),
            appui.TextField("最大输出 Tokens", text=str(state.max_tokens), on_change=set_max_tokens),
            appui.Text("并发过高易被限流；429 会自动退避重试。").font("footnote")
                .foreground_color(C('muted')),
        ], header="性能"),
        appui.Section([
            appui.HStack([
                appui.Image(system_name="checkmark.square.fill" if state.svg_on else "square")
                    .foreground_color(C('accent') if state.svg_on else C('border')),
                appui.Text("测试 SVG 动画题（%d 道）" % len(SVG_TASKS)).font("subheadline")
                    .foreground_color(C('text')),
            ], spacing=8).on_tap(lambda: animate_action(toggle_svg)),
            appui.HStack([
                appui.Image(system_name="checkmark.square.fill" if state.judge_on else "square")
                    .foreground_color(C('accent') if state.judge_on else C('border')),
                appui.Text("启用 AI 评审（源码评审）").font("subheadline").foreground_color(C('text')),
            ], spacing=8).on_tap(lambda: animate_action(toggle_judge)),
            appui.Text("MiniApp 无法渲染 SVG 动画，评审只依据源码 + 评分维度；桌面版会截帧做视觉评审。")
                .font("footnote").foreground_color(C('muted')),
        ], header="SVG 动画题"),
        appui.Section(judge_rows or [appui.Text("（启用 AI 评审后可选择裁判模型）")
                                     .font("footnote").foreground_color(C('muted'))],
                      header="裁判模型"),
        appui.Section(group_rows, header="题库分组（%d/%d 题已选）" % (len(state.q_on), len(QUESTIONS))),
        appui.Section(q_rows, header="逐题勾选"),
    ]).navigation_title("配置"))


# ==================== 入口 ====================
def _safe(name, builder):
    try:
        return builder()
    except Exception:
        import traceback
        tb = traceback.format_exc().strip().splitlines()
        return appui.NavigationStack(appui.List([
            appui.Section([
                appui.HStack([
                    appui.Image(system_name="exclamationmark.triangle").foreground_color(C('red')),
                    appui.Text("%s 页构建失败" % name).font("headline").bold()
                        .foreground_color(C('red')),
                ], spacing=6),
            ]),
            appui.Section([appui.Text("\n".join(tb[-10:])).font("footnote")
                           .foreground_color(C('text'))], header="错误详情"),
        ]).navigation_title(name))


def _pump_once():
    try:
        if state.running or _outcome is not None or _pending or _fetch_out:
            _sync()
    except Exception:
        pass


def _body():
    _pump_once()
    return appui.TabView([
        appui.Tab(title="检测", system_image="brain.head.profile",
                  content=_safe("检测", test_tab)),
        appui.Tab(title="成绩", system_image="chart.bar.fill",
                  content=_safe("成绩", result_tab)),
        appui.Tab(title="配置", system_image="gearshape.fill",
                  content=_safe("配置", config_tab)),
    ])


def body():
    try:
        return _body()
    except Exception:
        import traceback
        tb = traceback.format_exc().strip().splitlines()
        return appui.NavigationStack(appui.List([
            appui.Section([
                appui.HStack([
                    appui.Image(system_name="exclamationmark.triangle").foreground_color(C('red')),
                    appui.Text("界面构建失败").font("headline").bold().foreground_color(C('red')),
                ], spacing=6),
            ]),
            appui.Section([appui.Text("\n".join(tb[-12:])).font("footnote")
                           .foreground_color(C('text'))], header="错误详情"),
        ]).navigation_title("出错了"))


appui.run(body, state=state, presentation='fullscreen_with_close')
