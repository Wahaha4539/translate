import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'assets'
SIZE = 256
BG = (33, 76, 60, 255)
INK = (238, 242, 222, 255)
ACCENT = (218, 231, 130, 255)
segments = [((61, 79), (61, 171)), ((61, 79), (110, 79)),
            ((61, 125), (101, 125)), ((121, 101), (181, 101)),
            ((151, 82), (151, 175)), ((123, 175), (179, 175))]

def distance(x, y, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)

raw = bytearray()
for y in range(SIZE):
    raw.append(0)
    for x in range(SIZE):
        dx, dy = max(52 - x, 0, x - 203), max(52 - y, 0, y - 203)
        color = BG if dx * dx + dy * dy <= 52 * 52 else (0, 0, 0, 0)
        if color[3] and any(distance(x, y, a, b) <= 6 for a, b in segments): color = INK
        if math.hypot(x - 194, y - 64) <= 12: color = ACCENT
        raw.extend(color)

def chunk(name, data):
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data))

png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw))) + chunk(b'IEND', b'')
ROOT.mkdir(exist_ok=True)
(ROOT / 'icon.png').write_bytes(png)
header = struct.pack('<HHH', 0, 1, 1)
entry = struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(png), 22)
(ROOT / 'icon.ico').write_bytes(header + entry + png)
