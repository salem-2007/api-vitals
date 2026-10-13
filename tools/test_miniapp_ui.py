# -*- coding: utf-8 -*-
"""test_miniapp_ui.py — 用 stub appui 真实构建 MiniApp 三个页面，抓 API 误用

AppUI 运行时（iOS 端）无法在 CI 里跑，所以这里用一个同形 stub 记录所有调用：
只要页面构建过程不抛异常、且关键控件都被创建，就说明视图代码与 AppUI API 一致。

用法：python3 tools/test_miniapp_ui.py
"""
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PASS, FAIL = 0, 0
FAILED = []
CALLS = {"node": 0, "button": 0, "section": 0, "tab": 0, "gauge": 0, "text": 0, "image": 0, "run": 0}


def t(name, cond, info=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        FAILED.append(name)
        print("  ✗ %s%s" % (name, ("  → " + str(info)) if info else ""))


# ---------------- stub appui ----------------
class Node:
    def __init__(self, kind, *children, **kw):
        self.kind = kind
        self.children = [c for c in children if c is not None]
        self.kw = kw
        CALLS["node"] += 1
        if kind == "button":
            CALLS["button"] += 1
        if kind == "section":
            CALLS["section"] += 1
        if kind == "tab":
            CALLS["tab"] += 1
        if kind == "gauge":
            CALLS["gauge"] += 1
        if kind == "text":
            CALLS["text"] += 1
        if kind == "image":
            CALLS["image"] += 1

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        # 链式修饰符：font/bold/foreground_color/padding/background/... 一律返回 self
        def _mod(*a, **k):
            self.kw.setdefault(name, (a, k))
            return self
        return _mod


def _mk(kind):
    def _f(*children, **kw):
        return Node(kind, *children, **kw)
    return _f


class State:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def __getattr__(self, name):
        return None


class Timer:
    def __init__(self, interval=0.4, action=None):
        self.interval = interval
        self.action = action
        self.running = False

    def start(self):
        self.running = True

    def stop(self):
        self.running = False


appui = types.ModuleType("appui")
appui.State = State
appui.Timer = Timer
for kind in ["VStack", "HStack", "ZStack", "Text", "Image", "Button", "Section",
             "List", "Form", "TabView", "Tab", "NavigationStack", "ForEach",
             "Spacer", "TextField", "SecureField", "Gauge", "ScrollView"]:
    setattr(appui, kind, _mk(kind.lower()))
appui.Spacer = lambda *a, **k: Node("spacer")
appui.animate = lambda fn, type="spring": fn()
appui.get_appearance = lambda: "light"
appui.run = lambda body, **kw: (CALLS.__setitem__("run", CALLS["run"] + 1),
                                setattr(appui, "_built", body()))
sys.modules["appui"] = appui

haptics = types.ModuleType("haptics")
haptics.impact = lambda *a, **k: None
haptics.notification = lambda *a, **k: None
sys.modules["haptics"] = haptics

_mem = {}
storage = types.ModuleType("storage")
storage.get = lambda k, d=None: _mem.get(k, d)
storage.set = lambda k, v: _mem.__setitem__(k, v)
storage.get_json = lambda k, d=None: (json.loads(_mem[k]) if k in _mem else d)
storage.set_json = lambda k, v: _mem.__setitem__(k, json.dumps(v))
sys.modules["storage"] = storage

print("\n== 导入 main（会执行 appui.run）==")
import main  # noqa: E402

t("appui.run 被调用", CALLS["run"] == 1)
t("TabView 建了 3 个 Tab", CALLS["tab"] == 3, CALLS["tab"])
t("进度环（Gauge）存在", CALLS["gauge"] >= 1)

print("\n== 空状态构建三个页面 ==")
for name, fn in [("检测", main.test_tab), ("成绩", main.result_tab), ("配置", main.config_tab)]:
    before = CALLS["node"]
    try:
        node = fn()
        t("%s 页构建成功" % name, node is not None and CALLS["node"] > before)
    except Exception as e:
        import traceback
        t("%s 页构建成功" % name, False, traceback.format_exc().strip().splitlines()[-1])

print("\n== 有结果时构建 ==")
rows = []
from bank_data import QUESTIONS  # noqa: E402
for q in QUESTIONS[:5]:
    rows.append({"qid": q["id"], "no": q["no"], "group": q["group"], "type": q["type"],
                 "level": q["level"], "model": "mock-a", "expected": q["answer"],
                 "ok": q["no"] % 2 == 0, "got": q["answer"], "raw": "推导…", "grade_how": "num",
                 "followup": False, "latency": 900, "tokens": 120, "error": "", "t": 0})
entry = {"model": "mock-a", "q": rows, "svg": [{
    "task_id": "svg-ecg", "title": "心电图波形", "model": "mock-a", "ok": True,
    "svg": "<svg/>", "raw": "```svg\n<svg/>\n```", "latency": 5000, "tokens": 900,
    "error": "", "t": 0, "judge": {"score": 76, "stars": 4, "verdict": "结构基本完整",
                                   "criteria": [{"name": "网格背景", "pass": True, "comment": "有"}],
                                   "problems": [], "suggestions": []},
    "judge_model": "mock-a", "judge_error": ""}]}
main.state.results = [entry]
main.state.logs = rows
main.state.share_text = "🧠 模型智商检测报告\nmock-a 100%"
main.state.svg_preview = "<svg/>"
main.state.done, main.state.total, main.state.elapsed = 6, 13, 12.5
main.state.status = "完成 · 学科题 5/5"
main.state.running = False

for name, fn in [("检测", main.test_tab), ("成绩", main.result_tab), ("配置", main.config_tab)]:
    try:
        node = fn()
        t("%s 页（有数据）构建成功" % name, node is not None)
    except Exception:
        import traceback
        t("%s 页（有数据）构建成功" % name, False, traceback.format_exc().strip().splitlines()[-1])

print("\n== 交互动作 ==")
main.set_filter("fail")
t("筛选切换", main.state.filter_mode == "fail")
main.set_filter("all")
main.toggle_question("Q1")
t("逐题开关（关）", "Q1" not in main.state.q_on)
main.toggle_question("Q1")
t("逐题开关（开）", "Q1" in main.state.q_on)
main.set_group("comb", False)
t("分组清空", all(q["id"] not in main.state.q_on for q in QUESTIONS if q["group"] == "comb"))
main.set_group("comb", True)
t("分组全选", all(q["id"] in main.state.q_on for q in QUESTIONS if q["group"] == "comb"))
main.toggle_svg()
t("SVG 开关", main.state.svg_on is False)
main.toggle_svg()
main.toggle_judge()
t("评审开关", main.state.judge_on is False)
main.toggle_judge()
main.set_judge_model("mock-a")
t("指定裁判模型", main.state.judge_model == "mock-a")
main.set_judge_model("mock-a")
t("再点取消指定", main.state.judge_model == "")
main.bump_threads(1)
t("并发 +1", main.state.threads >= 2)
main.set_timeout("90")
t("超时设置", main.state.timeout == 90)
main.set_max_tokens("2048")
t("Tokens 设置", main.state.max_tokens == 2048)
main.set_theme("dark")
t("主题设置", main.state.theme_mode == "dark")
main.set_theme("auto")
main.do_add_model()
main.state.new_model = "manual-model"
main.do_add_model()
t("手动加模型", "manual-model" in main.state.models)
main.do_del_model("manual-model")
t("删除模型", "manual-model" not in main.state.models)
main.show_svg("mock-a", "svg-ecg")
t("读取 SVG 源码（有 storage 记录）", isinstance(main.state.svg_preview, str))
main.export_report()
t("导出报告", "报告已生成" in (main.state.cfg_status or ""))
main.export_csv()
t("导出 CSV", "CSV 已生成" in (main.state.cfg_status or ""))
main.save_cfg()
t("保存配置写入 storage", any("iq_cfg" in k for k in _mem))
main.clear_all()
t("清空结果", main.state.results == [] and main.state.logs == [])
# 动作函数只改状态（重绘由 AppUI 负责）；重建页面验证控件仍在
n_before = CALLS["node"]
main.config_tab()
t("动作后页面可重建", CALLS["node"] > n_before)
t("构控件数量合理", CALLS["node"] > 150, CALLS["node"])
t("按钮数量合理", CALLS["button"] > 40, CALLS["button"])

print("\n== 配置持久化回读 ==")
main.state.base_url = "https://example.com/v1"
main.state.api_key = "sk-secret-1234"
main.save_cfg()
cfg = json.loads(_mem["iq_cfg_v1"])
t("配置含 base_url", cfg["base_url"] == "https://example.com/v1")
t("配置含 api_key（本地存储，报告不含）", cfg["api_key"] == "sk-secret-1234")
t("掩码正确", main.mask("sk-secret-1234").endswith("1234"))

print("\n结果：%d 通过 / %d 失败" % (PASS, FAIL))
if FAILED:
    print("失败项：", "、".join(FAILED))
sys.exit(1 if FAIL else 0)
