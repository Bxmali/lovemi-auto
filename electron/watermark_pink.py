#!/usr/bin/env python3
"""Export Lovemi media → 推特资源（粉色水印 + Telegram 友好格式）.

Telegram 对 WebP 常当贴纸发不出。
图片 → 高清 JPEG（尽量不放大、提高画质）；视频 → H.264/AAC +faststart（偏清晰编码）。
水印：只对文字做 3× 超采样再缩回，画面本体不放大，减少粉边锯齿。
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
# 实心粉 + 实心黑描边，JPEG 上比半透明荧光粉更不容易糊边
PINK = (236, 72, 153, 255)
OUTLINE = (0, 0, 0, 255)

# 导出上限（竖屏）；源图更大则缩小到此，更小则不放大以免发糊
MAX_W = 1440
MAX_H = 2560
# 视频统一画幅（TG 稳）；编码用更高码率避免水印发糊
TG_W = 1080
TG_H = 1920

# 优先 PingFang SC Semibold / Medium，其次 Hiragino W6
# PingFang 在较新 macOS 上常在 AssetsV2，路径带 hash，运行时再 glob
FONT_SPECS: list[tuple[str, tuple[int, ...]]] = [
    # PingFang.ttc: 0–3 Regular, 4–7 Medium, 8–11 Semibold；SC = 3/7/11
    ("PingFang.ttc", (11, 7, 3, 10, 6, 2)),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", (2, 0, 3, 1)),  # W6 优先
    ("/System/Library/Fonts/STHeiti Medium.ttc", (0, 1)),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", (0,)),
    ("/Library/Fonts/Arial Unicode.ttf", (0,)),
    ("/System/Library/Fonts/STHeiti Light.ttc", (0,)),
]

# 文字超采样倍率（只作用于字，不作用于照片）
TEXT_SS = 3
_font_path_cache: dict[str, str | None] = {}


def _find_font_file(name_or_path: str) -> str | None:
    if name_or_path in _font_path_cache:
        return _font_path_cache[name_or_path]
    found: str | None = None
    if os.path.sep in name_or_path or name_or_path.startswith("/"):
        found = name_or_path if os.path.isfile(name_or_path) else None
    else:
        for p in (
            f"/System/Library/Fonts/{name_or_path}",
            f"/Library/Fonts/{name_or_path}",
            f"/System/Library/Fonts/Supplemental/{name_or_path}",
        ):
            if os.path.isfile(p):
                found = p
                break
        if found is None:
            root = "/System/Library/AssetsV2"
            if os.path.isdir(root):
                for dirpath, _dirs, files in os.walk(root):
                    if name_or_path in files:
                        found = os.path.join(dirpath, name_or_path)
                        break
    _font_path_cache[name_or_path] = found
    return found


def resolve_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name, indices in FONT_SPECS:
        path = _find_font_file(name)
        if not path:
            continue
        for index in indices:
            try:
                return ImageFont.truetype(path, size=size, index=index)
            except OSError:
                continue
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
    stroke_width: int = 3,
) -> None:
    y = start_y
    for line in (LINE1, LINE2):
        bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_width)
        tw = bbox[2] - bbox[0]
        x = max(0, (width - tw) // 2)
        draw.text(
            (x, y),
            line,
            font=font,
            fill=PINK,
            stroke_width=stroke_width,
            stroke_fill=OUTLINE,
        )
        y += line_gap


def even(n: int) -> int:
    return max(2, int(n) // 2 * 2)


def fit_export_image(im: Image.Image, max_w: int = MAX_W, max_h: int = MAX_H) -> Image.Image:
    """Contain into max box；绝不放大（小图保持原尺寸，避免水印/画面发糊）。"""
    im = im.convert("RGB")
    w, h = im.size
    scale = min(max_w / w, max_h / h, 1.0)
    nw = even(w * scale)
    nh = even(h * scale)
    if (nw, nh) != (w, h):
        im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    return im


def resolve_text_renderer() -> str | None:
    """Compiled CoreText helper beside this script (much sharper than Pillow)."""
    here = Path(__file__).resolve().parent
    for c in (
        here / "watermark_text",
        here / "bin" / "watermark_text",
        Path(sys.argv[0]).resolve().parent / "watermark_text",
    ):
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def render_text_overlay(width: int, height: int, fontsize: int, line_gap: int, pad: int) -> Image.Image:
    """优先 macOS CoreText 3× 绘字；失败则回退 Pillow。"""
    ss = TEXT_SS
    renderer = resolve_text_renderer()
    if renderer:
        with tempfile.TemporaryDirectory(prefix="lovemi-ct-") as td:
            png = Path(td) / "text.png"
            # 直接在 ss 倍像素上绘字，再缩回目标尺寸
            cmd = [
                renderer,
                str(width),
                str(height),
                str(fontsize),
                str(png),
                str(ss),
            ]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
            if r.returncode == 0 and png.is_file():
                with Image.open(png) as hi:
                    hi = hi.convert("RGBA")
                    if hi.size != (width, height):
                        hi = hi.resize((width, height), Image.Resampling.LANCZOS)
                    return hi.copy()

    # Pillow 回退
    ow, oh = width * ss, height * ss
    overlay = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = resolve_font(fontsize * ss)
    stroke = max(3, (fontsize * ss) // 11)
    gap = max(line_gap * ss, int(fontsize * ss * 1.55))
    block = gap * 2
    start_y = max(pad * ss // 2, (oh - block) // 2)
    draw_lines(draw, font, ow, start_y, gap, stroke_width=stroke)
    return overlay.resize((width, height), Image.Resampling.LANCZOS)


def apply_watermark_rgb(im: Image.Image) -> Image.Image:
    """底部渐变暗底 + 3× 超采样文字（照片条带不放大）。"""
    base = im.convert("RGBA")
    w, h = base.size
    fontsize = max(32, min(56, h // 20))
    line_gap = max(40, int(fontsize * 1.55))
    pad = max(24, h // 32)
    band_h = min(h, line_gap * 2 + pad * 2)
    y0 = h - band_h

    band = base.crop((0, y0, w, h))
    shade = Image.new("RGBA", (w, band_h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for i in range(band_h):
        t = (i + 1) / band_h
        a = int(55 + 155 * (t**0.8))
        sd.line([(0, i), (w, i)], fill=(0, 0, 0, a))
    band = Image.alpha_composite(band, shade)

    text = render_text_overlay(w, band_h, fontsize, line_gap, pad)
    band = Image.alpha_composite(band, text)

    out = base.copy()
    out.paste(band, (0, y0), band)
    return out.convert("RGB")


def export_image(src: Path, dest: Path, watermark: bool) -> None:
    with Image.open(src) as im:
        try:
            from PIL import ImageOps

            im = ImageOps.exif_transpose(im)
        except Exception:
            pass
        fitted = fit_export_image(im)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest = dest.with_suffix(".jpg")
        out = apply_watermark_rgb(fitted) if watermark else fitted
        out.save(dest, "JPEG", quality=98, optimize=True, progressive=False, subsampling=0)


def make_bar_png(width: int, height: int, out: Path) -> None:
    """视频底部水印条：3× 超采样绘字 + 渐变底。"""
    bar_h = max(96, min(188, height // 9))
    fontsize = max(28, min(50, bar_h // 2 + 8))
    line_gap = max(36, int(fontsize * 1.45))
    pad = max(12, bar_h // 8)

    im = Image.new("RGBA", (width, bar_h), (0, 0, 0, 0))
    draw_bg = ImageDraw.Draw(im)
    for i in range(bar_h):
        a = int(155 * ((i + 1) / bar_h) ** 1.0)
        draw_bg.line([(0, i), (width, i)], fill=(0, 0, 0, a))

    text = render_text_overlay(width, bar_h, fontsize, line_gap, pad)
    im = Image.alpha_composite(im, text)
    im.save(out)


def export_video(src: Path, dest: Path, watermark: bool) -> None:
    ffmpeg = resolve_ffmpeg()
    dest = dest.with_suffix(".mp4")
    dest.parent.mkdir(parents=True, exist_ok=True)
    scale = (
        f"scale={TG_W}:{TG_H}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={TG_W}:{TG_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
    )
    x264 = [
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-level",
        "4.1",
        "-preset",
        "medium",
        "-crf",
        "16",
        "-x264-params",
        "aq-mode=3:aq-strength=0.8",
    ]
    audio = ["-c:a", "aac", "-b:a", "192k"]
    with tempfile.TemporaryDirectory(prefix="lovemi-wm-") as td:
        td_path = Path(td)
        if watermark:
            bar = td_path / "wm.png"
            make_bar_png(TG_W, TG_H, bar)
            margin = max(12, TG_H // 32)
            fc = f"[0:v]{scale}[v];[v][1:v]overlay=(W-w)/2:H-h-{margin}:format=auto[out]"
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
                *x264,
                *audio,
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
                *x264,
                *audio,
                "-movflags",
                "+faststart",
                str(dest),
            ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=420, check=False)
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
    final = dest.with_suffix(".mp4" if args.video else ".jpg")
    if not final.is_file() or final.stat().st_size < 100:
        print("output missing or too small", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
