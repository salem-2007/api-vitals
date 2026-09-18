# -*- coding: utf-8 -*-
"""
API 模型健康检测 MiniApp
3 个 Tab：测试（筛选） / 聊天 / 配置
夜间模式自适应 · 支持自定义线程数
"""

import appui
import haptics
import storage
import json
import threading
import time
from services import (
    DEFAULT_PROMPTS, GAP_SECONDS, fetch_models, chat_send,
    run_all_tests, test_one,
)

CFG_KEY = "mt_cfg_v5"
ST_KEY = "mt_state_v5"
SYNC_INTERVAL = 0.4

# ==================== 调色板（自适应深浅模式）====================
_LIGHT = {
    'bg':       '#F2F2F7',
    'card':     '#FFFFFF',
    'border':   '#D1D1D6',
    'muted':    '#636366',    # 对比 5.8:1 (WCAG AA+)
    'secondary':'#5C5C60',    # 对比 6.5:1
    'text':     '#000000',    # 纯黑，最大对比
    'accent':   '#4845C8',
    'green':    '#28A745',
    'red':      '#D70015',
    'yellow':   '#B25E00',
    'blue':     '#0058D4',
    'pink':     '#D80027',
    'teal':     '#0080B0',
    'indigo':   '#4845C8',
}

_DARK = {
    'bg':       '#000000',
    'card':     '#1C1C1E',
    'border':   '#48484A',
    'muted':    '#B8B8BD',   # 对比 7.2:1 (WCAG AAA)
    'secondary':'#B0B0B6',   # 对比 5.5:1 (WCAG AA+)
    'text':     '#FFFFFF',
    'accent':   '#A0A0FF',   # 更亮的紫
    'green':    '#4DDB7A',
    'red':      '#FF6B62',
    'yellow':   '#FFD60A',
    'blue':     '#5EB0FF',
    'pink':     '#FF6B82',
    'teal':     '#7DDDFC',
    'indigo':   '#A0A0FF',
}

def _is_dark():
    """优先手动模式；auto 时探测系统外观"""
    try:
        mode = state.theme_mode
    except Exception:
        mode = "auto"
    if mode == "dark":
        return True
    if mode == "light":
        return False
    # auto：多路探测系统外观，任一可用即可
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
    """取色：跟随深浅模式"""
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
            return
        except Exception:
            pass

def save_cfg():
    _put(CFG_KEY, {
        "base_url": state.base_url, "api_key": state.api_key,
        "models": list(state.models), "prompts": list(state.prompts),
        "gap": state.gap, "threads": state.threads,
        "theme_mode": state.theme_mode,
    })

def save_results():
    _put(ST_KEY, {
        "logs": list(state.logs), "available": list(state.available),
        "failed_models": list(state.failed_models), "elapsed": state.elapsed,
        "fetched_models": list(state.fetched_models),
    })

def mask(key):
    if not key:
        return ""
    return "•" * 8 + key[-4:] if len(key) > 4 else "•" * 6

# ==================== 状态 ====================
_cfg = _get(CFG_KEY)
_st = _get(ST_KEY)
_key = _cfg.get("api_key", "") or ""

state = appui.State(
    base_url=_cfg.get("base_url", "https://api.openai.com/v1"),
    api_key=_key,
    key_masked=mask(_key),
    show_key=True,
    models=list(_cfg.get("models", [])),
    prompts=list(_cfg.get("prompts", [])) or list(DEFAULT_PROMPTS),
    gap=float(_cfg.get("gap", GAP_SECONDS)),
    threads=int(_cfg.get("threads", 1)),
    theme_mode=str(_cfg.get("theme_mode", "auto")),
    new_model="", p_label="", p_user="", p_expect="",
    import_text="", export_text="", export_with_key=False,
    fetched_models=list(_st.get("fetched_models", [])),
    fetch_status="",
    running=False,
    logs=list(_st.get("logs", [])),
    available=list(_st.get("available", [])),
    failed_models=list(_st.get("failed_models", [])),
    elapsed=_st.get("elapsed", 0.0),
    done=0, total=0, now_model="", now_prompt="", status="准备就绪",
    cfg_status="",
    filter_mode="all",
    chat_model="",
    chat_history=[],
    chat_input="",
    chat_busy=False,
    chat_status="选择模型后开始对话",
    chat_model_cat="idle",
    tab=0,
)


def _assign(name, value):
    """只在值真正变化时才写 state：避免无谓重绘导致页面/输入框跳动"""
    try:
        cur = getattr(state, name)
    except Exception:
        cur = None
    if cur != value:
        try:
            setattr(state, name, value)
            _writes[0] += 1
        except Exception:
            pass

# ==================== 后台执行 ====================
_lock = threading.Lock()
_pending = []
_prog = {}
_outcome = None
_fetch_out = {}
_chat_out = {}
_inflight = set()
_last_elapsed = [0.0]
_writes = [0]
_timer_on = [False]
_idle_ticks = [0]
_stop = threading.Event()
_busy = threading.Event()
_busy.set()
_t0 = 0.0


def _ensure_timer():
    _idle_ticks[0] = 0
    _timer_on[0] = True
    try:
        _timer.start()
    except Exception:
        pass


def _timer_is_on():
    """同步表是否在跑（诊断用）"""
    try:
        return bool(_timer.running)
    except Exception:
        return _timer_on[0]


def _begin_op(name):
    """登记在途任务并确保同步表在跑"""
    with _lock:
        _inflight.add(name)
    _ensure_timer()


def _end_op(name):
    with _lock:
        _inflight.discard(name)


def _busy_work():
    """是否存在在途任务（不含测试运行态）"""
    with _lock:
        return bool(_inflight or _fetch_out or _chat_out or _pending)


def _maybe_stop_timer():
    """没有任何在途任务时停表，避免无谓刷新导致界面重绘"""
    if state.running or _busy_work():
        return
    _timer_on[0] = False
    try:
        _timer.stop()
    except Exception:
        pass

def _worker():
    global _outcome
    prompts = state.prompts
    if not prompts:
        _outcome = {"error": "没有可用提示词"}
        _busy.set()
        return
    try:
        models = list(state.models)
        if not models:
            models = fetch_models(state.base_url, state.api_key)
        if not models:
            _outcome = {"error": "未获取到任何模型"}
            _busy.set()
            return
    except Exception as e:
        _outcome = {"error": "拉取模型列表失败: %s" % e}
        _busy.set()
        return

    gap = state.gap
    threads = max(1, int(state.threads or 1))

    def _on_progress(model, label, done, total):
        _prog["model"] = model
        _prog["prompt"] = label
        _prog["done"] = done
        _prog["total"] = total
        _prog["threads"] = threads

    def _on_log(row):
        with _lock:
            _pending.append(row)

    try:
        res = run_all_tests(
            state.base_url, state.api_key, models, prompts,
            gap=gap, threads=threads,
            on_progress=_on_progress, on_log=_on_log,
            should_stop=lambda: _stop.is_set(),
        )
        if "error" in res:
            _outcome = {"error": res["error"]}
        else:
            _outcome = {
                "available": res.get("available", []),
                "failed_models": res.get("failed", []),
                "interrupted": res.get("stopped", False),
            }
    except Exception as e:
        _outcome = {"error": str(e)}
    _busy.set()

def _sync():
    """主线程唯一的 state 写入口（由 Timer 驱动）"""
    global _outcome
    _writes[0] = 0
    with _lock:
        batch = list(_pending)
        if _pending:
            del _pending[:]
    if batch:
        state.logs = list(state.logs) + batch
        _writes[0] += 1
    if state.running and _prog:
        _assign("done", _prog.get("done", state.done))
        _assign("total", _prog.get("total", state.total))
        _assign("now_model", _prog.get("model", ""))
        _assign("now_prompt", _prog.get("prompt", ""))
        if not _stop.is_set():
            _assign("status", "正在测试 %s · %s" % (
                _prog.get("model", ""), _prog.get("prompt", "")))
        # 耗时每秒才更新一次，避免高频重绘
        now = time.time()
        if now - _last_elapsed[0] >= 1.0:
            _assign("elapsed", round(now - _t0, 1))
            _last_elapsed[0] = now

    if _outcome is not None:
        res = _outcome
        _outcome = None
        try:
            if "error" in res:
                state.status = "错误: " + res["error"]
            else:
                state.available = res.get("available", [])
                state.failed_models = res.get("failed_models", [])
                if res.get("interrupted"):
                    state.status = "已停止 · 可用 %d · 失败 %d" % (
                        len(state.available), len(state.failed_models))
                else:
                    state.status = "完成 · 可用 %d · 失败 %d · 耗时 %.1fs" % (
                        len(state.available), len(state.failed_models),
                        time.time() - _t0)
                save_results()
                try:
                    haptics.notification(
                        'success' if state.available and not state.failed_models
                        else 'error')
                except Exception:
                    pass
        except Exception as e:
            state.status = "结果同步出错: %s" % e
        finally:
            # 无论上面发生什么，一定要把运行标志复位
            state.elapsed = round(time.time() - _t0, 1)
            state.running = False
            state.now_model = ""
            state.now_prompt = ""
            _stop.clear()
            _busy.set()

    # ---- 自愈：worker 已结束但运行标志残留 ----
    if state.running and _busy.is_set() and _outcome is None:
        state.running = False
        state.now_model = ""
        state.now_prompt = ""
        _stop.clear()
        if not (state.status.startswith("完成") or state.status.startswith("已停止")
                or state.status.startswith("错误")):
            state.status = "已结束 · 可用 %d · 失败 %d" % (
                len(state.available), len(state.failed_models))

    # ---- 跨线程：拉取模型结果（在子线程里绝不直接写 state） ----
    with _lock:
        fo = _fetch_out.pop("res", None)
    if fo:
        if fo.get("error"):
            state.fetch_status = "拉取失败: %s" % fo["error"]
        else:
            models = list(fo.get("models", []))
            state.fetched_models = models
            state.models = models
            save_cfg()
            save_results()
            state.fetch_status = "拉取到 %d 个模型" % len(models)
            try:
                haptics.notification('success')
            except Exception:
                pass

    # ---- 跨线程：聊天回复 ----
    with _lock:
        co = _chat_out.pop("res", None)
    if co:
        if co.get("err"):
            state.chat_history = list(state.chat_history) + [
                {"role": "assistant", "content": "错误: " + co["err"],
                 "latency": co.get("latency", 0)}]
        else:
            speed_str = ""
            if co.get("spd"):
                speed_str = " · %s %s" % (co["spd"], co.get("unit"))
            state.chat_history = list(state.chat_history) + [
                {"role": "assistant", "content": co.get("reply", ""),
                 "latency": co.get("latency", 0), "speed": speed_str}]
        state.chat_busy = False
        state.chat_status = "就绪 · %dms" % co.get("latency", 0)

    # ---- 空闲看门狗：同步表空转就停掉，避免高频重绘把页面顶回第一页 ----
    if _writes[0] == 0 and not state.running and not _busy_work():
        _idle_ticks[0] += 1
        if _idle_ticks[0] >= 3:
            _idle_ticks[0] = 0
            _timer_on[0] = False
            try:
                _timer.stop()
            except Exception:
                pass
    else:
        _idle_ticks[0] = 0

    _maybe_stop_timer()

_timer = appui.Timer(interval=SYNC_INTERVAL, action=_sync)

# ==================== 测试动作 ====================
def start_test():
    global _t0, _outcome
    # 唯一权威是工作线程标志 _busy：已置位 = 没有任务在跑
    if _busy.is_set():
        # 合并上一轮结果 + 清理残留，绝不让自己被"上一轮还没结束"卡死
        if _outcome is not None:
            try:
                _sync()
            except Exception:
                _outcome = None
        if state.running:
            state.running = False
            state.now_model = ""
            state.now_prompt = ""
        _stop.clear()
    else:
        state.status = "上一轮还没结束"
        return
    if not state.api_key.strip():
        state.status = "请先填写 API Key"
        return
    save_cfg()
    with _lock:
        del _pending[:]
    _prog.clear()
    _outcome = None
    _stop.clear()
    _busy.clear()
    state.logs = []
    state.available = []
    state.failed_models = []
    state.done = 0
    state.total = len(state.models) or 0
    state.elapsed = 0.0
    state.running = True
    state.status = "正在准备…"
    _t0 = time.time()
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
        # 其实已经结束了，只是标志没复位
        state.running = False
        state.now_model = ""
        state.now_prompt = ""
        _stop.clear()
        state.status = "已停止"
        return
    _stop.set()
    state.status = "正在停止…"

def clear_all():
    state.logs = []
    state.available = []
    state.failed_models = []
    state.done = 0
    state.total = 0
    state.elapsed = 0.0
    state.status = "已清空"
    save_results()

def set_filter(mode):
    state.filter_mode = mode

def fill_available_to_models():
    if not state.available:
        state.status = "没有可用模型，请先运行测试"
        return
    state.models = list(state.available)
    save_cfg()
    state.status = "已填入 %d 个可用模型" % len(state.available)
    try:
        haptics.notification('success')
    except Exception:
        pass

# ==================== 聊天动作 ====================
def _chat_worker():
    history = [
        {"role": "system", "content": "你是一个有用的助手，简洁准确地回答问题。"},
    ] + [{"role": m["role"], "content": m["content"]} for m in state.chat_history]
    reply, latency, spd, unit, err = chat_send(
        state.base_url, state.api_key, state.chat_model, history)
    with _lock:
        _chat_out["res"] = {"reply": reply, "latency": latency,
                            "spd": spd, "unit": unit, "err": err}
    _end_op("chat")

def chat_send_msg():
    txt = state.chat_input.strip()
    if not txt:
        return
    if not state.chat_model:
        state.chat_status = "请先选择模型"
        return
    state.chat_history = list(state.chat_history) + [
        {"role": "user", "content": txt}]
    state.chat_input = ""
    state.chat_busy = True
    state.chat_status = "%s 正在回复…" % state.chat_model
    _begin_op("chat")
    threading.Thread(target=_chat_worker, daemon=True).start()
    try:
        haptics.impact('light')
    except Exception:
        pass

def chat_clear():
    state.chat_history = []
    state.chat_status = "对话已清空"

def toggle_chat_picker():
    state.chat_model_cat = "idle" if state.chat_model_cat == "picker" else "picker"
    try:
        haptics.impact('light')
    except Exception:
        pass

def chat_select_model(name):
    state.chat_model = name
    state.chat_model_cat = "idle"
    state.chat_status = "已切换到 " + name
    try:
        haptics.impact('light')
    except Exception:
        pass

# ==================== 配置动作 ====================
def toggle_key_view():
    state.show_key = not state.show_key

def do_save_cfg():
    state.key_masked = mask(state.api_key)
    save_cfg()
    state.cfg_status = "配置已保存"

def do_clear_key():
    state.api_key = ""
    state.key_masked = ""
    state.show_key = True
    save_cfg()

def do_add_model():
    n = state.new_model.strip()
    if n and n not in state.models:
        state.models = list(state.models) + [n]
        state.new_model = ""
        save_cfg()
        try:
            haptics.impact('light')
        except Exception:
            pass

def do_del_model(name):
    state.models = [m for m in state.models if m != name]
    save_cfg()

def _fetch_worker():
    try:
        models = fetch_models(state.base_url, state.api_key)
        with _lock:
            _fetch_out["res"] = {"models": models}
    except Exception as e:
        with _lock:
            _fetch_out["res"] = {"error": str(e)}
    _end_op("fetch")

def do_fetch_models():
    if not state.api_key.strip():
        state.fetch_status = "请先填写 API Key"
        return
    state.fetch_status = "正在拉取…"
    _begin_op("fetch")
    threading.Thread(target=_fetch_worker, daemon=True).start()
    try:
        haptics.impact('medium')
    except Exception:
        pass

def do_add_prompt():
    lb = state.p_label.strip()
    us = state.p_user.strip()
    ex = state.p_expect.strip()
    if not lb or not us:
        return
    state.prompts = list(state.prompts) + [
        {"label": lb, "user": us, "expect": ex or None}]
    state.p_label = ""
    state.p_user = ""
    state.p_expect = ""
    save_cfg()

def do_del_prompt(label):
    state.prompts = [p for p in state.prompts if p["label"] != label]
    save_cfg()

def set_gap(v):
    try:
        state.gap = max(0.0, min(10.0, float(v)))
    except Exception:
        pass

def set_threads(v):
    try:
        state.threads = max(1, min(8, int(float(v))))
    except Exception:
        pass

def bump_threads(delta):
    n = max(1, min(8, int(state.threads or 1) + delta))
    if n == state.threads:
        return
    state.threads = n
    save_cfg()
    try:
        haptics.impact('light')
    except Exception:
        pass

def set_theme(mode):
    state.theme_mode = mode if mode in ("auto", "light", "dark") else "auto"
    save_cfg()

def do_export():
    """导出配置。默认不含 API Key，避免分享配置时泄露密钥。"""
    data = {
        "base_url": state.base_url,
        "models": list(state.models),
        "prompts": list(state.prompts),
        "gap": state.gap,
        "threads": state.threads,
        "theme_mode": state.theme_mode,
    }
    if state.export_with_key:
        data["api_key"] = state.api_key
    else:
        data["api_key"] = ""
    state.export_text = json.dumps(data, ensure_ascii=False, indent=2)
    if state.export_with_key:
        state.cfg_status = "已导出（含 API Key，请勿外发）"
    else:
        state.cfg_status = "已导出（不含 API Key）"

def toggle_export_key():
    state.export_with_key = not state.export_with_key
    try:
        haptics.impact('light')
    except Exception:
        pass

def do_import():
    txt = state.import_text.strip()
    if not txt:
        return
    try:
        cfg = json.loads(txt)
    except Exception as e:
        state.cfg_status = "JSON 错误: %s" % e
        return
    if not isinstance(cfg, dict):
        state.cfg_status = "格式错误：顶层需为对象"
        return
    try:
        if cfg.get("base_url"):
            state.base_url = str(cfg["base_url"])
        # 只有导入内容里带了真实 Key 才覆盖，避免用空值/掩码把已有配置冲掉
        k = str(cfg.get("api_key") or "")
        if k and not k.startswith("•"):
            state.api_key = k
        if isinstance(cfg.get("models"), list):
            state.models = [str(m) for m in cfg["models"] if m]
        if isinstance(cfg.get("prompts"), list):
            state.prompts = [p for p in cfg["prompts"]
                             if isinstance(p, dict) and p.get("label") and p.get("user")]
        if "gap" in cfg:
            state.gap = max(0.0, min(10.0, float(cfg["gap"])))
        if "threads" in cfg:
            state.threads = max(1, min(8, int(float(cfg["threads"]))))
        if "theme_mode" in cfg:
            state.theme_mode = str(cfg["theme_mode"])
            if state.theme_mode not in ("auto", "light", "dark"):
                state.theme_mode = "auto"
        state.key_masked = mask(state.api_key)
        state.import_text = ""
        save_cfg()
        state.cfg_status = "配置已导入"
    except Exception as e:
        state.cfg_status = "导入失败: %s" % e

# ==================== 设计系统 ====================
def card_view(*children, padding=14):
    return appui.VStack(list(children), spacing=8
    ).background(C('card')).cornerRadius(16
    ).padding(padding)

def chip(label, icon=None, color=None, active=False):
    if color is None:
        color = C('accent')
    btn = appui.Button(
        ("  " + label if icon else label),
        action=lambda: None,
    )
    return btn.button_style("bordered_prominent" if active else "bordered"
    ).tint(color if active else C('muted'))

def stat_pill(icon, color, value, label):
    return appui.VStack([
        appui.HStack([
            appui.Image(system_name=icon).foreground_color(color).font("body"),
            appui.Text(str(value)).font("headline").bold().foreground_color(color),
        ], spacing=4),
        appui.Text(label).font("footnote").foreground_color(C('muted')),
    ], spacing=2)

def progress_ring(pct, size=72, color=None):
    if color is None:
        color = C('accent')
    return appui.Gauge(value=pct, label="%d%%" % int(pct * 100)
    ).frame(width=size, height=size).tint(color)

def section_header(title, icon=None, color=None):
    if color is None:
        color = C('accent')
    if icon:
        return appui.HStack([
            appui.Image(system_name=icon).foreground_color(color).font("subheadline"),
            appui.Text(title).font("headline").foreground_color(C('text')),
        ], spacing=6)
    return appui.Text(title).font("headline").foreground_color(C('text'))

def animate_action(fn, anim_type='spring'):
    def _do():
        fn()
    try:
        appui.animate(_do, type=anim_type)
    except Exception:
        # 动画事务冲突/不可用时直接执行，绝不让异常冒泡到 AppUI
        try:
            _do()
        except Exception as e:
            try:
                state.cfg_status = "操作失败: %s" % e
            except Exception:
                pass

# ==================== 日志行（美化）====================
def log_row(rec):
    ok = rec["pass"]
    color = C('green') if ok else C('red')
    icon = 'checkmark.circle.fill' if ok else 'xmark.circle.fill'
    spd = ("%s %s" % (rec["speed"], rec["speed_unit"])) if rec.get("speed") else "—"
    note = rec.get("error") or rec.get("preview") or ""
    rows = [
        appui.HStack([
            appui.Text(rec["model"]).font("subheadline").bold().foreground_color(C('text')),
            appui.Spacer(),
            appui.Text("%dms" % rec["latency_ms"]).font("footnote").foreground_color(C('muted')),
        ]),
        appui.HStack([
            appui.Text(rec["label"]).font("footnote").foreground_color(C('secondary')),
            appui.Spacer(),
            appui.Text(spd).font("footnote").foreground_color(C('accent')),
        ]),
    ]
    if note:
        rows.append(
            appui.Text(note[:80]).font("footnote").foreground_color(color))
    return appui.HStack([
        appui.ZStack([
            appui.Image(system_name="circle.fill").foreground_color(color + '22').font("title3"),
            appui.Image(system_name=icon).foreground_color(color).font("footnote"),
        ]),
        appui.VStack(rows, spacing=3),
    ], spacing=10).padding(vertical=4)

def filter_btn(label, mode, color):
    is_active = state.filter_mode == mode
    return appui.Button(
        label,
        action=lambda m=mode: animate_action(lambda: set_filter(m)),
    ).button_style("bordered_prominent" if is_active else "bordered"
    ).tint(color if is_active else C('muted'))

# ==================== 测试页（美化）====================
def test_tab():
    secs = len(state.logs)
    p_n = sum(1 for l in state.logs if l["pass"])
    f_n = secs - p_n
    pct = (state.done / state.total) if state.total else 0.0

    items = []
    items.append(appui.Section([
        appui.HStack([
            appui.VStack([
                appui.Text("%d / %d" % (state.done, state.total))
                    .font("system", size=32, weight="bold")
                    .foreground_color(C('accent')),
                appui.Text("已测 / 总数").font("footnote")
                    .foreground_color(C('muted')),
            ], spacing=4),
            appui.Spacer(),
            progress_ring(pct, 76, C('accent')),
        ]),
        appui.HStack([
            appui.Image(system_name="arrow.triangle.2.circlepath" if state.running else "checkmark.circle"
                        ).foreground_color(C('accent') if state.running else C('green')),
            appui.Text(state.status).font("footnote").bold()
                .foreground_color(C('accent') if state.running else C('muted')),
        ], spacing=6),
    ], header="进度"))

    # 以工作线程真实状态判定，避免 running 卡住导致按钮消失
    is_busy = state.running and not _busy.is_set()
    items.append(appui.Section([
        appui.Button(
            "停止测试" if is_busy else "开始测试",
            action=lambda: animate_action(stop_test if is_busy else start_test),
        ).button_style("bordered_prominent"
        ).tint(C('red') if is_busy else C('accent')),
        appui.Button("清空结果",
            action=lambda: animate_action(clear_all)
        ).button_style("bordered").tint(C('muted')),
    ], header="操作"))

    if secs:
        items.append(appui.Section([
            appui.HStack([
                stat_pill("checkmark.circle.fill", C('green'), p_n, "通过"),
                appui.Spacer(),
                stat_pill("xmark.circle.fill", C('red'), f_n, "失败"),
                appui.Spacer(),
                stat_pill("stopwatch", C('muted'), "%.1fs" % state.elapsed, "耗时"),
            ]),
            appui.HStack([
                filter_btn("全部", "all", C('accent')),
                filter_btn("通过", "pass", C('green')),
                filter_btn("失败", "fail", C('red')),
            ]),
            appui.Button("填入通过模型到配置",
                action=lambda: animate_action(fill_available_to_models)
            ).button_style("bordered").tint(C('green')
            ).disabled(not state.available),
        ], header="汇总"))

    mode = state.filter_mode
    fails = [l for l in state.logs if not l["pass"]]
    oks = [l for l in state.logs if l["pass"]]
    if mode == "fail":
        show = fails
    elif mode == "pass":
        show = oks
    else:
        show = state.logs
    if show:
        hdr = {"all": "全部 %d 条", "pass": "通过 %d 个", "fail": "失败 %d 个"}[mode]
        items.append(appui.Section([
            appui.ForEach(show, row_builder=log_row,
                          key=lambda r: "%s-%s" % (r["model"], r["t"])),
        ], header=hdr % len(show)))

    if not secs and not state.running:
        items.append(appui.Section([
            appui.HStack([
                appui.Image(system_name="info.circle").foreground_color(C('accent')),
                appui.Text("每个模型随机分配一个任务，间隔 %.1fs · 线程 %d" % (state.gap, state.threads))
                    .font("footnote").foreground_color(C('muted')),
            ], spacing=6),
        ], header="说明"))

    return appui.NavigationStack(
        appui.List(items).navigation_title("模型测试"))

# ==================== 聊天页（美化）====================
def model_pill(m):
    is_sel = m == state.chat_model
    return appui.HStack([
        appui.ZStack([
            appui.Image(system_name="circle.fill"
                        ).foreground_color(C('accent') + '18' if is_sel else C('border')
                        ).font("title3"),
            appui.Image(system_name="cpu"
                        ).foreground_color(C('accent') if is_sel else C('secondary')
                        ).font("footnote"),
        ]),
        appui.Text(m).font("subheadline"
                   ).foreground_color(C('text') if is_sel else C('secondary')
                   ).bold() if is_sel else appui.Text(m).font("subheadline"
                   ).foreground_color(C('secondary')),
        appui.Spacer(),
        appui.Text("已选" if is_sel else "").font("caption2"
                   ).foreground_color(C('accent')),
    ], spacing=10
    ).on_tap(lambda n=m: animate_action(lambda: chat_select_model(n)))

def chat_bubble(m):
    is_user = m["role"] == "user"
    lat = m.get("latency", "")
    spd = m.get("speed", "")
    meta = "%dms%s" % (lat, spd) if lat else ""
    bg = C('accent') + '12' if is_user else C('green') + '12'
    icon = "person.fill" if is_user else "cpu"
    icon_color = C('accent') if is_user else C('green'
        ) if False else C('green')   # placeholder resolved
    # safety: re-resolve icon_color with proper is_user check
    icon_color = C('accent') if is_user else C('green')
    name = "你" if is_user else state.chat_model
    rows = [
        appui.HStack([
            appui.Image(system_name=icon).foreground_color(icon_color).font("footnote"),
            appui.Text(name).font("footnote").foreground_color(C('muted')),
            appui.Spacer(),
            appui.Text(meta).font("footnote").foreground_color(C('secondary')),
        ], spacing=4),
        appui.Text(m["content"]).font("subheadline").bold().foreground_color(C('text')),
    ]
    return appui.VStack(rows, spacing=4
    ).padding(10
    ).background(bg
    ).cornerRadius(12)

def chat_tab():
    avail = list(dict.fromkeys(state.available))
    show_picker = state.chat_model_cat == "picker"
    items = []

    items.append(appui.Section([
        appui.HStack([
            appui.Image(system_name="cpu").foreground_color(C('accent')).font("body"),
            appui.Text(state.chat_model or "未选择")
                .font("headline").foreground_color(C('accent')),
            appui.Spacer(),
            appui.Image(system_name="chevron.down" if show_picker else "chevron.right"
                        ).foreground_color(C('muted')).font("footnote"),
        ], spacing=6).on_tap(lambda: animate_action(toggle_chat_picker)),
        appui.Text(state.chat_status).font("footnote").foreground_color(C('muted')),
    ], header="当前模型"))

    if show_picker:
        if avail:
            items.append(appui.Section([
                appui.ForEach(avail, row_builder=model_pill, key=lambda m: m),
            ], header="可用模型（%d）" % len(avail)))
        else:
            items.append(appui.Section([
                appui.HStack([
                    appui.Image(system_name="exclamationmark.triangle").foreground_color(C('yellow')),
                    appui.Text("请先运行测试获取可用模型").font("footnote").foreground_color(C('muted')),
                ], spacing=6),
            ], header="可用模型（0）"))

    if state.chat_history:
        msgs = [chat_bubble(m) for m in state.chat_history]
        items.append(appui.Section(msgs,
            header="对话 %d 轮" % (len(state.chat_history) // 2 + 1)))
    else:
        items.append(appui.Section([
            appui.HStack([
                appui.Image(system_name="bubble.left").foreground_color(C('secondary')),
                appui.Text("选择模型后，输入问题发送").font("footnote").foreground_color(C('muted')),
            ], spacing=6),
        ], header="对话"))

    items.append(appui.Section([
        appui.HStack([
            appui.TextField("输入消息…", text=state.chat_input,
                            on_change=lambda v: setattr(state, 'chat_input', v)),
            appui.Button("发送", action=lambda: animate_action(chat_send_msg))
                .button_style("bordered_prominent").tint(C('accent'))
                .disabled(state.chat_busy),
        ]),
        appui.Button("清空对话",
            action=lambda: animate_action(chat_clear)
        ).button_style("bordered").tint(C('muted')),
    ]))

    return appui.NavigationStack(
        appui.List(items).navigation_title("模型聊天"))

# ==================== 配置页（美化）====================
def config_tab():
    key_field = (
        appui.SecureField(placeholder="sk-...", text=state.api_key,
                          on_change=lambda v: setattr(state, 'api_key', v))
        if not state.show_key else
        appui.TextField(placeholder="sk-...", text=state.api_key,
                        on_change=lambda v: setattr(state, 'api_key', v))
    )
    fetch_ok = "拉取到" in state.fetch_status
    fetch_err = "拉取失败" in state.fetch_status

    def theme_btn(label, mode):
        is_active = state.theme_mode == mode
        return appui.Button(label,
            action=lambda m=mode: animate_action(lambda: set_theme(m))
        ).button_style("bordered_prominent" if is_active else "bordered"
        ).tint(C('accent') if is_active else C('muted'))

    theme_icon = (
        "circle.lefthalf.filled" if state.theme_mode == "auto"
        else "sun.max.fill" if state.theme_mode == "light"
        else "moon.fill"
    )
    theme_desc = {
        "auto": "跟随系统外观自动切换",
        "light": "强制使用浅色",
        "dark": "强制使用深色",
    }[state.theme_mode]

    return appui.NavigationStack(
        appui.Form([
            appui.Section([
                appui.HStack([
                    theme_btn("自动", "auto"),
                    theme_btn("浅色", "light"),
                    theme_btn("深色", "dark"),
                ]),
                appui.HStack([
                    appui.Image(system_name=theme_icon).foreground_color(C('accent')),
                    appui.Text(theme_desc).font("footnote").foreground_color(C('muted')),
                ], spacing=6),
            ], header="外观"),

            appui.Section([
                appui.TextField(placeholder="https://api.openai.com/v1",
                                text=state.base_url,
                                on_change=lambda v: setattr(state, 'base_url', v)),
                key_field,
                appui.HStack([
                    appui.Image(system_name="lock.fill" if state.key_masked else "lock.open"
                                ).foreground_color(C('green') if state.key_masked else C('red')),
                    appui.Text("已保存 " + state.key_masked if state.key_masked
                               else "未填写 API Key")
                        .font("footnote")
                        .foreground_color(C('green') if state.key_masked else C('red')),
                ], spacing=6),
                appui.Text(state.cfg_status).font("footnote").bold()
                    .foreground_color(C('green') if state.cfg_status else C('muted')),
                appui.HStack([
                    appui.Button("保存",
                        action=lambda: animate_action(do_save_cfg)
                    ).button_style("bordered_prominent").tint(C('accent')),
                    appui.Button("清除",
                        action=lambda: animate_action(do_clear_key)
                    ).button_style("bordered").tint(C('red')),
                    appui.Button("隐藏" if state.show_key else "显示",
                        action=lambda: animate_action(toggle_key_view)
                    ).button_style("bordered").tint(C('muted')),
                ]),
            ], header="API 配置", footer="保存后重启自动恢复。"),

            appui.Section([
                appui.TextField("间隔秒数", text=str(state.gap),
                                on_change=set_gap),
                appui.HStack([
                    appui.Image(system_name="timer").foreground_color(C('teal')),
                    appui.Text("当前 %.1fs（越小越快，0 = 不等待）" % state.gap)
                        .font("footnote").foreground_color(C('muted')),
                ], spacing=6),
                appui.HStack([
                    appui.Image(system_name="square.stack.3d.up").foreground_color(C('blue')),
                    appui.Text("测试线程数").font("subheadline").bold()
                        .foreground_color(C('text')),
                    appui.Spacer(),
                    appui.Button("-", action=lambda: animate_action(lambda: bump_threads(-1)))
                        .button_style("bordered").tint(C('muted')),
                    appui.Text("%d" % state.threads).font("headline").bold()
                        .foreground_color(C('blue')),
                    appui.Button("+", action=lambda: animate_action(lambda: bump_threads(1)))
                        .button_style("bordered").tint(C('blue')),
                ], spacing=8),
                appui.Text("1 = 串行（默认）；2~8 = 并行测试。并发过高可能被服务端限流。")
                    .font("footnote").foreground_color(C('muted')),
                appui.HStack([
                    appui.Image(system_name="waveform.path.ecg")
                    .foreground_color(C('green') if _timer_is_on() else C('muted')),
                    appui.Text("同步表：%s" % ("运行中" if _timer_is_on() else "已停止"))
                        .font("footnote").foreground_color(C('muted')),
                ], spacing=6),
            ], header="测试性能", footer="空闲时同步表应显示「已停止」。"),

            appui.Section([
                appui.Button("从 API 拉取全部模型",
                    action=lambda: animate_action(do_fetch_models)
                ).button_style("bordered_prominent").tint(C('accent')),
                appui.HStack([
                    appui.Image(system_name="checkmark.circle.fill" if fetch_ok else
                                "xmark.circle.fill" if fetch_err else
                                "arrow.triangle.2.circlepath"
                                ).foreground_color(
                                    C('green') if fetch_ok else
                                    C('red') if fetch_err else C('muted')),
                    appui.Text(state.fetch_status).font("footnote").bold()
                        .foreground_color(C('green') if fetch_ok else
                                          C('red') if fetch_err else C('muted')),
                ], spacing=6),
                appui.HStack([
                    appui.TextField("手动添加模型", text=state.new_model,
                                    on_change=lambda v: setattr(state, 'new_model', v)),
                    appui.Button("添加",
                        action=lambda: animate_action(do_add_model)
                    ).button_style("bordered").tint(C('accent')),
                ]),
                appui.ForEach(state.models, row_builder=lambda m: appui.HStack([
                    appui.ZStack([
                        appui.Image(system_name="circle.fill").foreground_color(C('accent') + '18').font("body"),
                        appui.Image(system_name="cpu").foreground_color(C('accent')).font("footnote"),
                    ]),
                    appui.Text(m).font("subheadline").bold().foreground_color(C('text')),
                    appui.Spacer(),
                    appui.Button("删除", action=lambda n=m: do_del_model(n))
                        .foreground_color(C('red')).font("footnote"),
                ]), key=lambda m: m),
            ], header="模型（%d）" % len(state.models),
               footer="点「拉取」自动填充全部模型，也可手动添加。留空则测试时自动拉取。"),

            appui.Section([
                appui.TextField("任务标签", text=state.p_label,
                                on_change=lambda v: setattr(state, 'p_label', v)),
                appui.TextField("提示词内容", text=state.p_user,
                                on_change=lambda v: setattr(state, 'p_user', v)),
                appui.TextField("期望关键词", text=state.p_expect,
                                on_change=lambda v: setattr(state, 'p_expect', v)),
                appui.Button("添加提示词",
                    action=lambda: animate_action(do_add_prompt)
                ).button_style("bordered_prominent").tint(C('accent')),
                appui.ForEach(state.prompts, row_builder=lambda p: appui.HStack([
                    appui.ZStack([
                        appui.Image(system_name="circle.fill").foreground_color(C('teal') + '18').font("body"),
                        appui.Image(system_name="text.bubble").foreground_color(C('teal')).font("footnote"),
                    ]),
                    appui.VStack([
                        appui.Text(p["label"]).font("subheadline").bold().foreground_color(C('text')),
                        appui.Text(p.get("user", "")[:42] + '…').font("footnote").foreground_color(C('muted')),
                    ], spacing=2),
                    appui.Spacer(),
                    appui.Button("删除", action=lambda l=p["label"]: do_del_prompt(l))
                        .foreground_color(C('red')).font("footnote"),
                ]), key=lambda p: p["label"]),
            ], header="提示词（%d）" % len(state.prompts)),

            appui.Section([
                appui.Button("导出配置",
                    action=lambda: animate_action(do_export)
                ).button_style("bordered_prominent").tint(C('accent')),
                appui.Text(state.export_text).font("footnote").foreground_color(C('muted')),
                appui.HStack([
                    appui.Image(system_name="key.slash" if not state.export_with_key
                                else "key.fill"
                                ).foreground_color(C('green') if not state.export_with_key
                                                   else C('red')),
                    appui.Text("导出内容包含 API Key（外发会泄露）"
                               if state.export_with_key
                               else "导出内容不含 API Key（推荐）")
                        .font("footnote")
                        .foreground_color(C('red') if state.export_with_key else C('green')),
                    appui.Spacer(),
                    appui.Button("改成不含" if state.export_with_key else "需要含 Key",
                        action=lambda: animate_action(toggle_export_key)
                    ).button_style("bordered").tint(C('muted')),
                ], spacing=6),
                appui.TextField("粘贴 JSON", text=state.import_text,
                                on_change=lambda v: setattr(state, 'import_text', v)),
                appui.Button("导入配置",
                    action=lambda: animate_action(do_import)
                ).button_style("bordered").tint(C('accent')),
            ], header="备份 / 迁移",
               footer="源码 main.py / services.py 不含密钥；密钥只存在本机存储里。"),
        ]).navigation_title("配置"))

def _safe(name, builder):
    """单个 Tab 构建失败时只替换该 Tab，不影响其他页面"""
    try:
        return builder()
    except Exception:
        import traceback
        tb = traceback.format_exc().strip().splitlines()
        return appui.NavigationStack(appui.List([
            appui.Section([
                appui.HStack([
                    appui.Image(system_name="exclamationmark.triangle")
                    .foreground_color(C('red')),
                    appui.Text("%s 页构建失败" % name).font("headline").bold()
                    .foreground_color(C('red')),
                ], spacing=6),
            ]),
            appui.Section([
                appui.Text("\n".join(tb[-10:])).font("footnote")
                .foreground_color(C('text')),
            ], header="错误详情"),
        ]).navigation_title(name))


def _pump_once():
    """视图构建时顺带同步一次，不依赖 Timer 也能推进状态"""
    try:
        if state.running or _outcome is not None or _pending or _fetch_out or _chat_out:
            _sync()
    except Exception:
        pass


def _body():
    _pump_once()
    return appui.TabView([
        appui.Tab(title="测试", system_image="play.circle.fill",
                  content=_safe("测试", test_tab)),
        appui.Tab(title="聊天", system_image="bubble.left.and.bubble.right.fill",
                  content=_safe("聊天", chat_tab)),
        appui.Tab(title="配置", system_image="gearshape.fill",
                  content=_safe("配置", config_tab)),
    ])

def body():
    """构建失败时把错误显示出来，而不是让界面整体消失"""
    try:
        return _body()
    except Exception:
        import traceback
        tb = traceback.format_exc().strip().splitlines()
        return appui.NavigationStack(appui.List([
            appui.Section([
                appui.HStack([
                    appui.Image(system_name="exclamationmark.triangle")
                    .foreground_color(C('red')),
                    appui.Text("界面构建失败").font("headline").bold()
                    .foreground_color(C('red')),
                ], spacing=6),
            ]),
            appui.Section([
                appui.Text("\n".join(tb[-12:])).font("footnote")
                .foreground_color(C('text')),
            ], header="错误详情"),
        ]).navigation_title("出错了"))

appui.run(body, state=state, presentation='fullscreen_with_close')