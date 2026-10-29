"""Thumbnail generation for uploaded images (Pillow), with on-disk caching.

Card feeds request downscaled images via ``/uploads/<path>?w=<width>``; we cache
the resized JPEG under ``<upload_folder>/.thumbs/<width>/<path>.jpg`` and only
regenerate when the source file is newer.  Non-raster files (PDFs, etc.), path
traversal attempts, or any failure return None so the caller falls back to
serving the original file untouched.
"""
import os

try:
    from PIL import Image, ImageOps
    _pil_available = True
except Exception:  # pragma: no cover - Pillow always present in this project
    _pil_available = False

_RASTER_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
THUMB_DIRNAME = ".thumbs"
_MIN_W, _MAX_W = 48, 1024


def _safe_width(width):
    try:
        w = int(width)
    except (TypeError, ValueError):
        return None
    return max(_MIN_W, min(_MAX_W, w))


def get_or_create_thumbnail(upload_folder, filename, width):
    """Return ``(directory, rel_path)`` for ``send_from_directory`` pointing at a
    cached thumbnail, or None if it can't/shouldn't be thumbnailed."""
    if not _pil_available:
        return None
    w = _safe_width(width)
    if w is None:
        return None
    if os.path.splitext(filename)[1].lower() not in _RASTER_EXT:
        return None

    root = os.path.abspath(upload_folder)
    src_path = os.path.abspath(os.path.join(root, filename))
    if not src_path.startswith(root + os.sep) or not os.path.isfile(src_path):
        return None  # traversal guard / missing source

    cache_root = os.path.join(root, THUMB_DIRNAME, str(w))
    cache_rel = filename + ".jpg"
    cache_path = os.path.join(cache_root, cache_rel)
    try:
        fresh = (os.path.isfile(cache_path)
                 and os.path.getmtime(cache_path) >= os.path.getmtime(src_path))
        if not fresh:
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with Image.open(src_path) as im:
                im = ImageOps.exif_transpose(im)  # honour camera orientation
                im = im.convert("RGB")
                im.thumbnail((w, w * 8))  # bound width to w; allow tall images
                im.save(cache_path, "JPEG", quality=82, optimize=True)
        return cache_root, cache_rel
    except Exception:
        return None
