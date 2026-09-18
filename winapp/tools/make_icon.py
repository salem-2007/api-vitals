"""生成 app.ico —— 与 UI 主题一致的图标：深色底 + 圆角 + 绿色心电脉冲（◉ API VITALS）
纯 PIL 绘制，多尺寸打包，供 exe / 任务栏 / 窗口 / favicon 使用。
用法：python3 tools/make_icon.py
"""
from PIL import Image, ImageDraw
import os

# 主题色（与 app.css 深色模式一致）
BG_TOP = (18, 26, 36)        # panel2
BG_BOT = (10, 14, 19)        # bg
SIG = (62, 224, 143)         # --sig 心电绿
GLOW = (62, 224, 143, 70)
RING = (42, 55, 74)          # line2

S = 1024                     # 超采样画布，最后缩到各尺寸，边缘更干净


def ecg_points(w, h):
    """心电波形（相对坐标 0..1），与前端 drawEcg() 的节拍一致"""
    beat = [
        (0.00, 0.50), (0.18, 0.50), (0.24, 0.44), (0.28, 0.50),
        (0.31, 0.50), (0.325, 0.42), (0.34, 0.60),   # Q
        (0.355, 0.16),                                # R 尖峰
        (0.37, 0.72),                                 # S 深谷
        (0.40, 0.50), (0.50, 0.50), (0.56, 0.36),
        (0.64, 0.50), (1.00, 0.50),                   # T + 回到基线
    ]
    return [(x * w, y * h) for x, y in beat]


def build(size):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    r = int(S * 0.22)
    # 垂直渐变底（逐行画，模拟 linear-gradient）
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        col = tuple(round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (S, y)], fill=col)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)

    # 内描边：让图标在深色/浅色任务栏上都有轮廓
    d.rounded_rectangle([3, 3, S - 4, S - 4], radius=r, outline=RING + (220,), width=max(2, S // 170))

    # 心电基线区域
    pad = int(S * 0.16)
    w = S - pad * 2
    h = S - pad * 2
    pts = [(px + pad, py + pad) for px, py in ecg_points(w, h)]

    # 光晕（粗半透明线打底）
    lay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    lw = int(S * 0.075)
    ld.line(pts, fill=GLOW, width=lw, joint="curve")
    lay = lay.filter(__import__("PIL.ImageFilter", fromlist=["ImageFilter"]).GaussianBlur(S * 0.02))
    img.alpha_composite(lay)

    # 主波形 + 圆头端点
    lw2 = max(3, int(S * 0.042))
    d.line(pts, fill=SIG + (255,), width=lw2, joint="curve")
    cap = lw2 // 2
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - cap, p[1] - cap, p[0] + cap, p[1] + cap], fill=SIG + (255,))
    # 左上角小圆点（◉ 品牌符号）
    bx, by, br = int(S * 0.27), int(S * 0.27), int(S * 0.038)
    d.ellipse([bx - br, by - br, bx + br, by + br], outline=SIG + (255,), width=max(2, S // 200))

    return img.resize((size, size), Image.LANCZOS)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "..", "wwwroot")
    out_dir = os.path.normpath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    sizes = [256, 128, 64, 48, 32, 16]
    frames = [build(s) for s in sizes]
    ico_path = os.path.join(out_dir, "app.ico")
    frames[0].save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])

    png_path = os.path.join(out_dir, "app-icon-256.png")
    frames[0].save(png_path, format="PNG")

    print("ICO ->", ico_path, os.path.getsize(ico_path), "bytes")
    print("PNG ->", png_path, os.path.getsize(png_path), "bytes")
    print("sizes:", sizes)


if __name__ == "__main__":
    main()
