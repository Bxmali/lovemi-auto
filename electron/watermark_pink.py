#!/usr/bin/env python3
"""Export Lovemi media → 推特资源（粉色水印 + Telegram 友好格式）.

Telegram 对 WebP 常当贴纸发不出；1088 宽 MP4 也容易压缩失败。
统一：图片 → JPEG；视频 → 1080x1920 H.264/AAC +faststart。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

LINE1 = "Lovemi官方出品: https://ackr.app/e2"
LINE2 = "禁止未授权搬运"
PINK = (228, 90, 154, 235)
OUTLINE = (0, 0, 0, 150)

# Telegram / 多数客户端更稳的竖屏尺寸
TG_W = 1080
TG_H = 1920

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/STHeiti Light.ttc",
]


def resolve_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        if not os.path.isfile(path):
            continue
        for index in (0, 2, 1):
            try:
                return ImageFont.truetype(path, size=size, index=index)
            except OSError:
                try:
                    return ImageFont.truetype(path, size=size)
                except OSError:
                    continue
    return ImageFont.load_default()


def resolve_ffmpeg() -> str:
    for c in ("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if c == "ffmpeg":
            found = shutil.which("ffmpeg")
            if found:
                return found
            continue
        if os.path.isfile(c):
            return c
    return "ffmpeg"


def resolve_ffprobe() -> str:
    for c in ("ffprobe", "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"):
        if c == "ffprobe":
            found = shutil.which("ffprobe")
            if found:
                return found
            continue
        if os.path.isfile(c):
            return c
    return "ffprobe"


def draw_lines(
    draw: ImageDraw.ImageDraw,
    font: ImageFont.ImageFont,
    width: int,
    start_y: int,
    line_gap: int,
) -> None:
    y = start_y
    for line in (LINE1, LINE2):
        bbox = draw.textbbox((0, 0), line, font=font)
        tw = bbox[2] - bbox[0]
        x = max(0, (width - tw) // 2)
        for ox, oy in ((-2, 0), (2, 0), (0, -2), (0, 2), (-1, -1), (1, 1)):
            draw.text((x + ox, y + oy), line, font=font, fill=OUTLINE)
        draw.text((x, y), line, font=font, fill=PINK)
        y += line_gap


def fit_portrait(im: Image.Image, tw: int = TG_W, th: int = TG_H) -> Image.Image:
    """Contain into tw×th, pad black — even dims for TG."""
    im = im.convert("RGB")
    w, h = im.size
    scale = min(tw / w, th / h)
    nw = max(2, int(w * scale) // 2 * 2)
    nh = max(2, int(h * scale) // 2 * 2)
    resized = im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (tw, th), (0, 0, 0))
    canvas.paste(resized, ((tw - nw) // 2, (th - nh) // 2))
    return canvas


def apply_watermark_rgb(im: Image.Image) -> Image.Image:
    base = im.convert("RGBA")
    w, h = base.size
    fontsize = max(16, min(42, h // 28))
    font = resolve_font(fontsize)
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    line_gap = max(22, int(fontsize * 1.35))
    block_h = line_gap * 2 + 8
    start_y = max(8, h - block_h - max(12, h // 36))
    draw_lines(draw, font, w, start_y, line_gap)
    return Image.alpha_composite(base, overlay).convert("RGB")


def export_image(src: Path, dest: Path, watermark: bool) -> None:
    with Image.open(src) as im:
        fitted = fit_portrait(im)
        out = apply_watermark_rgb(fitted) if watermark else fitted
        dest.parent.mkdir(parents=True, exist_ok=True)
        # 强制 JPEG：Telegram 对 webp 当贴纸，png 也偶发失败
        dest = dest.with_suffix(".jpg")
        out.save(dest, "JPEG", quality=92, optimize=True, progressive=True)


def make_bar_png(width: int, height: int, out: Path) -> None:
    bar_h = max(56, min(120, height // 12))
    fontsize = max(16, min(36, bar_h // 2 - 4))
    font = resolve_font(fontsize)
    im = Image.new("RGBA", (width, bar_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    line_gap = max(22, int(fontsize * 1.3))
    block = line_gap * 2
    start_y = max(4, (bar_h - block) // 2)
    draw_lines(draw, font, width, start_y, line_gap)
    im.save(out)


def export_video(src: Path, dest: Path, watermark: bool) -> None:
    ffmpeg = resolve_ffmpeg()
    dest = dest.with_suffix(".mp4")
    dest.parent.mkdir(parents=True, exist_ok=True)
    # 缩放到 1080x1920 居中 pad，保证偶数尺寸 + yuv420p
    scale = (
        f"scale={TG_W}:{TG_H}:force_original_aspect_ratio=decrease,"
        f"pad={TG_W}:{TG_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
    )
    with tempfile.TemporaryDirectory(prefix="lovemi-wm-") as td:
        td_path = Path(td)
        if watermark:
            bar = td_path / "wm.png"
            make_bar_png(TG_W, TG_H, bar)
            margin = max(10, TG_H // 36)
            fc = f"[0:v]{scale}[v];[v][1:v]overlay=(W-w)/2:H-h-{margin}[out]"
            cmd = [
                ffmpeg,
                "-y",
                "-i",
                str(src),
                "-i",
                str(bar),
                "-filter_complex",
                fc,
                "-map",
                "[out]",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-profile:v",
                "high",
                "-level",
                "4.1",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                str(dest),
            ]
        else:
            cmd = [
                ffmpeg,
                "-y",
                "-i",
                str(src),
                "-vf",
                scale,
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-profile:v",
                "high",
                "-level",
                "4.1",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                str(dest),
            ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False)
        if r.returncode != 0 or not dest.is_file() or dest.stat().st_size < 200:
            raise RuntimeError((r.stderr or r.stdout or "ffmpeg export failed")[-500:])


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("dest")
    p.add_argument("--video", action="store_true")
    p.add_argument(
        "--no-watermark",
        action="store_true",
        help="仅转 Telegram 友好格式，不打水印",
    )
    args = p.parse_args()
    src = Path(args.src)
    dest = Path(args.dest)
    if not src.is_file():
        print("source missing", file=sys.stderr)
        return 2
    watermark = not args.no_watermark
    try:
        if args.video:
            export_video(src, dest, watermark=watermark)
        else:
            export_image(src, dest, watermark=watermark)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1
    # dest 可能被改成 .jpg/.mp4
    final = dest.with_suffix(".mp4" if args.video else ".jpg")
    if not final.is_file() or final.stat().st_size < 100:
        print("output missing or too small", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
