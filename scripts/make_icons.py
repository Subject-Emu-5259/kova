#!/usr/bin/env python3
"""Generate KOVA's placeholder bundle icons (pure stdlib — no Pillow needed).

Writes valid RGBA PNGs (molten-amber rounded square on transparent, with a
dark 'K'-bar motif approximated by rectangles) into app/src-tauri/icons/.
Run from the v1 project root:  python3 scripts/make_icons.py
"""
import struct
import zlib
from pathlib import Path

AMBER = (255, 122, 26, 255)      # #FF7A1A molten amber
GRAPHITE = (18, 18, 20, 255)     # graphite black
CLEAR = (0, 0, 0, 0)


def png_bytes(size: int) -> bytes:
    # Compose the icon: transparent bg, amber rounded square inset, graphite bar.
    rows = []
    inset = max(1, size // 10)
    bar_x0, bar_x1 = size * 38 // 100, size * 52 // 100
    bar_y0, bar_y1 = size * 24 // 100, size * 76 // 100
    radius = size // 5
    for y in range(size):
        row = bytearray()
        row.append(0)  # PNG filter: none
        for x in range(size):
            inside = inset <= x < size - inset and inset <= y < size - inset
            # crude rounded corners
            if inside:
                cx = min(max(x, inset + radius), size - inset - radius)
                cy = min(max(y, inset + radius), size - inset - radius)
                if (x - cx) ** 2 + (y - cy) ** 2 > radius * radius and (
                    (x < inset + radius and y < inset + radius)
                    or (x > size - inset - radius and y < inset + radius)
                    or (x < inset + radius and y > size - inset - radius)
                    or (x > size - inset - radius and y > size - inset - radius)
                ):
                    inside = False
            if not inside:
                row += bytes(CLEAR)
            elif bar_x0 <= x < bar_x1 and bar_y0 <= y < bar_y1:
                row += bytes(GRAPHITE)
            else:
                row += bytes(AMBER)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "app" / "src-tauri" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for name, size in [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
    ]:
        (out / name).write_bytes(png_bytes(size))
        print(f"wrote {out / name} ({size}x{size})")


if __name__ == "__main__":
    main()
