"""Regenerate icons/icon{16,48,128}.png (needs Pillow: pip install pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

ORANGE = (242, 107, 29, 255)
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"


def draw(size: int) -> Image.Image:
    s = 512  # draw large, downsample for smooth edges
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((16, 16, s - 16, s - 16), radius=110, fill=ORANGE)
    # train front
    d.rounded_rectangle((136, 96, 376, 360), radius=56, fill=WHITE)
    d.rounded_rectangle((170, 138, 342, 228), radius=22, fill=ORANGE)  # windscreen
    d.ellipse((178, 268, 222, 312), fill=ORANGE)  # lamps
    d.ellipse((290, 268, 334, 312), fill=ORANGE)
    # rails / legs
    d.polygon([(186, 360), (226, 360), (176, 430), (136, 430)], fill=WHITE)
    d.polygon([(286, 360), (326, 360), (376, 430), (336, 430)], fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for n in (16, 48, 128):
        draw(n).save(OUT / f"icon{n}.png")
        print("wrote", OUT / f"icon{n}.png")
