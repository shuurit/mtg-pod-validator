"""
Generates every home-screen/favicon size from icon-source.png: center-crops
to a square (if not already one) and resizes with high-quality resampling.
Run this again after swapping icon-source.png for a different image --
index.html/manifest.json reference the output filenames directly and don't
need to change.

Usage:
    python scripts/generate_icons.py
"""
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).parent.parent
SOURCE = REPO_ROOT / "icon-source.png"

SIZES = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "favicon-32.png": 32,
    "favicon-16.png": 16,
}


def main():
    img = Image.open(SOURCE).convert("RGB")
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    square = img.crop((left, top, left + side, top + side))

    for filename, size in SIZES.items():
        resized = square.resize((size, size), Image.LANCZOS)
        resized.save(REPO_ROOT / filename)
        print(f"wrote {filename} ({size}x{size})")


if __name__ == "__main__":
    main()
