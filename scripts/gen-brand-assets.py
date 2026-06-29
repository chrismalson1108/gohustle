#!/usr/bin/env python3
"""
Regenerate the canonical Hustlr brand assets in shared/assets/brand from the
designer's raw exports.

Usage:
    python scripts/gen-brand-assets.py "<path to raw export folder>"

The raw export folder is expected to contain the designer's group exports:
    Group 2.png  — orange wordmark (+ red offset) on a solid Electric-Blue background
    Group 3.png  — blue   wordmark (+ red offset) on a solid Hustle-Orange background
    Union-1.png  — orange H-monogram (+ red offset), transparent
    Union.png    — blue   H-monogram (+ red offset), transparent

Most of the time you do NOT need this — to update a logo just drop a new PNG into
shared/assets/brand and run `npm run brand:sync`. This script only re-derives the
whole set (transparent keying + icon composition) from the original solid-bg exports.

Requires: pillow, numpy  (pip install pillow numpy)
"""
import os
import sys
import shutil
import numpy as np
from PIL import Image

BLUE = (63, 37, 254)
ORANGE = (255, 188, 69)
OUT = os.path.join(os.path.dirname(__file__), "..", "shared", "assets", "brand")


def key_out(path, bg, thresh=100, feather=70):
    """Make a flat-color background transparent with a feathered edge, then trim."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    dist = np.sqrt(((a[:, :, :3] - np.array(bg, np.float32)) ** 2).sum(2))
    alpha = np.clip((dist - thresh) / feather, 0.0, 1.0)
    a[:, :, 3] = np.minimum(a[:, :, 3], alpha * 255.0)
    res = Image.fromarray(a.astype(np.uint8), "RGBA")
    bb = res.getbbox()
    return res.crop(bb) if bb else res


def trim(path):
    im = Image.open(path).convert("RGBA")
    bb = im.getbbox()
    return im.crop(bb) if bb else im


def fit_center(size, bg, glyph, pad=0.8):
    W, H = size
    base = Image.new("RGBA", (W, H), bg)
    r = min(W * pad / glyph.width, H * pad / glyph.height)
    g = glyph.resize((max(1, round(glyph.width * r)), max(1, round(glyph.height * r))), Image.LANCZOS)
    base.alpha_composite(g, ((W - g.width) // 2, (H - g.height) // 2))
    return base


def main(src):
    os.makedirs(OUT, exist_ok=True)
    wm_orange = key_out(os.path.join(src, "Group 2.png"), BLUE)
    wm_blue = key_out(os.path.join(src, "Group 3.png"), ORANGE)
    wm_orange.save(os.path.join(OUT, "wordmark-orange.png"))
    wm_blue.save(os.path.join(OUT, "wordmark-blue.png"))

    mono_orange = trim(os.path.join(src, "Union-1.png"))
    mono_blue = trim(os.path.join(src, "Union.png"))
    mono_orange.save(os.path.join(OUT, "monogram-orange.png"))
    mono_blue.save(os.path.join(OUT, "monogram-blue.png"))

    shutil.copy(os.path.join(src, "Group 2.png"), os.path.join(OUT, "lockup-on-blue.png"))
    shutil.copy(os.path.join(src, "Group 3.png"), os.path.join(OUT, "lockup-on-orange.png"))

    fit_center((1024, 1024), (63, 37, 254, 255), mono_orange, 0.60).convert("RGB").save(os.path.join(OUT, "app-icon.png"))
    fit_center((1024, 1024), (0, 0, 0, 0), mono_orange, 0.52).save(os.path.join(OUT, "android-foreground.png"))
    Image.new("RGBA", (1024, 1024), (63, 37, 254, 255)).save(os.path.join(OUT, "android-background.png"))
    white = Image.new("RGBA", mono_orange.size, (255, 255, 255, 0)); white.putalpha(mono_orange.split()[3])
    fit_center((1024, 1024), (0, 0, 0, 0), white, 0.52).save(os.path.join(OUT, "android-monochrome.png"))
    fit_center((1200, 630), (63, 37, 254, 255), wm_orange, 0.80).convert("RGB").save(os.path.join(OUT, "og-image.png"))
    print("Regenerated brand assets in", os.path.normpath(OUT))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python scripts/gen-brand-assets.py \"<raw export folder>\"")
    main(sys.argv[1])
