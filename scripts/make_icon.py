#!/usr/bin/env python3
"""Generate build/icon.png (1024x1024) for electron-builder.

Dark rounded square, gold ring and a bold gold 'H' — matches the app theme.
electron-builder converts this single PNG into .icns (mac) and .ico (win).
"""
import os

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
BG = (23, 29, 36, 255)        # --panel
GOLD = (231, 184, 76, 255)    # --gold
GOLD_DIM = (168, 134, 47, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded background
margin = 64
d.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin],
                    radius=190, fill=BG, outline=GOLD_DIM, width=10)

# gold ring
ring_m = 220
d.ellipse([ring_m, ring_m, SIZE - ring_m, SIZE - ring_m], outline=GOLD, width=26)

# bold H
font = None
for path in (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Bold.ttf",
):
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, 360)
            break
        except OSError:
            continue

if font:
    bbox = d.textbbox((0, 0), "H", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((SIZE - w) / 2 - bbox[0], (SIZE - h) / 2 - bbox[1]), "H",
           font=font, fill=GOLD)
else:
    # geometric fallback H
    cx, bar = SIZE // 2, 60
    top, bottom = 380, SIZE - 380
    d.rectangle([cx - 130, top, cx - 130 + bar, bottom], fill=GOLD)
    d.rectangle([cx + 130 - bar, top, cx + 130, bottom], fill=GOLD)
    mid = (top + bottom) // 2
    d.rectangle([cx - 130, mid - bar // 2, cx + 130, mid + bar // 2], fill=GOLD)

out = os.path.join(os.path.dirname(__file__), "..", "build", "icon.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out)
print(f"wrote {os.path.abspath(out)}")
