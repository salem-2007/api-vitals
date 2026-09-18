from widget import Widget
import os

APP_NAME = os.environ.get("MINIAPP_NAME", "Api测试") or "Api测试"
APP_SYMBOL = "square.grid.2x2"
APP_ACCENT = "#2563EB"
APP_BACKGROUND = ("#EFF6FF", "#0F172A")

w = Widget(background=APP_BACKGROUND, padding=14, style="clean")
w.symbol(APP_SYMBOL).color(APP_ACCENT).align("topTrailing")
w.title(APP_NAME).line_limit(1)
w.caption("点击打开 MiniApp").line_limit(1)
w.value("打开").font(size=32).color(APP_ACCENT).monospaced().compressed()
w.progress(0.72).color(APP_ACCENT)
w.caption("来自 MiniApp 的桌面入口").line_limit(1)
w.render()