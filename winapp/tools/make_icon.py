"""生成 app.ico —— 与 UI 一致的图标：深色圆角底 + 绿色神经元网络（IQ BENCH）
纯 PIL 绘制，多尺寸打包，供 exe / 任务栏 / 窗口 / favicon 使用。
用法：python3 tools/make_icon.py
"""
from PIL import Image, ImageDraw
import os

# 主题色（与 app.css 暗色模式一致）
BG_TOP = (27, 35, 54)         # --card
BG_BOT = (12, 17, 29)         # 更深一档
SIG = (34, 197, 94)           # --accent
NODE = (134, 239, 172)        # 亮一档的绿
RING = (71, 85, 105)          # --line2

S = 1024                      # 超采样画布


def build(size):
    """神经元网络图标：4 个节点 + 3 条连线，代表推理与连接。"""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    r = int(S * 0.22)
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        col = tuple(round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (S, y)], fill=col)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)
    d.rounded_rectangle([3, 3, S - 4, S - 4], radius=r, outline=RING + (220,), width=max(2, S // 170))

    # 节点（相对坐标）：左下 → 中上 → 右下，外加一个输入点
    pts = [
        (0.26, 0.68, 0.055),   # 左下
        (0.50, 0.32, 0.075),   # 中上（主节点）
        (0.76, 0.66, 0.055),   # 右下
        (0.50, 0.80, 0.040),   # 底部
    ]
    P = [(x * S, y * S, rr * S) for x, y, rr in pts]
    edges = [(0, 1), (1, 2), (0, 3), (3, 2)]

    # 连线（先画光晕再画实线）
    lay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    for a, b in edges:
        ld.line([P[a][:2], P[b][:2]], fill=SIG + (150,), width=int(S * 0.022))
    lay = lay.filter(__import__("PIL.ImageFilter", fromlist=["ImageFilter"]).GaussianBlur(S * 0.012))
    img.alpha_composite(lay)
    for a, b in edges:
        d.line([P[a][:2], P[b][:2]], fill=SIG + (255,), width=max(3, int(S * 0.014)))

    # 节点圆点：外圈 + 实心
    for x, y, rr in P:
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=NODE + (255,))
        d.ellipse([x - rr * 0.45, y - rr * 0.45, x + rr * 0.45, y + rr * 0.45], fill=SIG + (255,))

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
