# Writes test/corpus/align/expected.json: what Pillow, OpenCV and the ML
# service's aligner give, for test/align.test.mjs to check src/toolbox/align.ts,
# cv.ts and resample.ts against.
#
# Needs numpy, opencv-python and Pillow, and the ML's
# ludo_utils/image_alignment.py (Ludo-AI/ai-server) in a folder:
#
#   mkdir -p /tmp/ml && gh api repos/Ludo-AI/ai-server/contents/ludo_utils/image_alignment.py \
#     --jq .content | base64 -d > /tmp/ml/image_alignment.py
#   python3 scripts/align-fixtures.py /tmp/ml
#
# The images for the Pillow and OpenCV cases come from a small linear
# congruential generator that the test reimplements, so only their seeds and
# the SHA-256 of each result are stored. The aligner cases are real frame
# pairs, PNGs next to the JSON.
import hashlib, json, os, sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, sys.argv[1])
import image_alignment as ml  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "corpus", "align")


def stream(seed):
    """Bytes from x = x * 1664525 + 1013904223 (mod 2^32), the top 8 bits each."""
    x = seed & 0xFFFFFFFF
    while True:
        x = (x * 1664525 + 1013904223) & 0xFFFFFFFF
        yield x >> 24


def take(seed, n):
    s = stream(seed)
    return np.array([next(s) for _ in range(n)], dtype=np.uint8)


def sprite(seed, w, h):
    """RGBA noise with sprite-like alpha: a clear top third, a solid lower-left block."""
    arr = take(seed, w * h * 4).reshape(h, w, 4)
    arr[: h // 3, :, 3] = 0
    arr[h // 2 :, : w // 2, 3] = 255
    return arr


def blob_mask(seed, w, h, density):
    """0/1: noise under `density` (of 256), plus a solid block in the middle."""
    m = (take(seed, w * h).reshape(h, w) < density).astype(np.uint8)
    m[h // 4 : h // 2 + 1, w // 4 : w // 2 + 1] = 1
    return m


def sha(a):
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()


def sizes(seed, n, lo, hi):
    return [lo + int(v) % (hi - lo + 1) for v in take(seed, n)]


cases = {"resize": [], "nearest": [], "warp": [], "dilate": [], "clean": [], "ncc": [], "align": []}
filters = {"bilinear": Image.Resampling.BILINEAR, "lanczos": Image.Resampling.LANCZOS, "bicubic": Image.Resampling.BICUBIC}

for i in range(60):
    w, h, tw, th = sizes(1000 + i, 4, 2, 70)
    name = list(filters)[i % 3]
    img = Image.fromarray(sprite(i, w, h), "RGBA")
    cases["resize"].append({"seed": i, "w": w, "h": h, "tw": tw, "th": th, "filter": name, "sha": sha(np.array(img.resize((tw, th), filters[name])))})

for i in range(40):
    w, h, tw, th = sizes(2000 + i, 4, 1, 150)
    m = blob_mask(i, w, h, 128)
    cases["nearest"].append({"seed": i, "w": w, "h": h, "tw": tw, "th": th, "sha": sha(cv2.resize(m, (tw, th), interpolation=cv2.INTER_NEAREST))})

scales = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.25, 1.3, 1.4, 0.7333333, 1.0370370, 0.8765432]
for i in range(48):
    w, h, tw, th = sizes(3000 + i, 4, 5, 160)
    dx, dy = [int(v) % 61 - 30 for v in take(3100 + i, 2)]
    scale = scales[i % len(scales)]
    inverse = i % 2 == 1
    m = blob_mask(i, w, h, 100)
    M = np.array([[scale, 0, dx], [0, scale, dy]], dtype=np.float32)
    flags = cv2.INTER_NEAREST | (cv2.WARP_INVERSE_MAP if inverse else 0)
    out = cv2.warpAffine(m, M, (tw, th), flags=flags)
    cases["warp"].append({"seed": i, "w": w, "h": h, "tw": tw, "th": th, "m": [scale, 0, dx, 0, scale, dy], "inverse": inverse, "sha": sha(out)})

for i in range(24):
    w, h = sizes(4000 + i, 2, 3, 120)
    r = 1 + i % 9
    m = blob_mask(i, w, h, 8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    cases["dilate"].append({"seed": i, "w": w, "h": h, "r": r, "sha": sha(cv2.dilate(m, kernel))})

for i in range(24):
    w, h = sizes(5000 + i, 2, 3, 120)
    m = blob_mask(i, w, h, 20)
    cases["clean"].append({"seed": i, "w": w, "h": h, "sha": sha(ml._clean_mask(m, min_fraction=0.005))})

# Templates matched over sources: unrelated noise, and crops of the source
# (whose best place is where they were cut from).
for i in range(30):
    w1, h1, w2, h2 = sizes(6000 + i, 4, 6, 90)
    src = sprite(i, w1, h1)
    if i % 2:
        x, y = [int(v) for v in take(6100 + i, 2)]
        cw, ch = max(4, w1 // 2), max(4, h1 // 2)
        x, y = x % (w1 - cw + 1), y % (h1 - ch + 1)
        tmpl = src[y : y + ch, x : x + cw].copy()
    else:
        tmpl = sprite(500 + i, w2, h2)
    g1 = ml._premultiplied_gray(Image.fromarray(src, "RGBA"))
    g2 = ml._premultiplied_gray(Image.fromarray(tmpl, "RGBA"))
    res = ml._ncc_match(g1, g2)
    cases["ncc"].append({"seed": i, "src": [w1, h1], "crop": bool(i % 2), "tmpl": [int(tmpl.shape[1]), int(tmpl.shape[0])], "result": list(res) if res else None})

# The aligner, as /utils/align-images calls it.
for name in sorted({f[:-6] for f in os.listdir(OUT) if f.endswith("-a.png")}):
    a = Image.open(os.path.join(OUT, f"{name}-a.png"))
    b = Image.open(os.path.join(OUT, f"{name}-b.png"))
    dx, dy, scale, conf = ml.get_alignment_factors(a, b, fallback_scale=True)
    cases["align"].append({"name": name, "dx": dx, "dy": dy, "scale": scale, "confidence": conf})

with open(os.path.join(OUT, "expected.json"), "w") as f:
    json.dump({"pillow": Image.__version__, "opencv": cv2.__version__, **cases}, f, indent=1)
print({k: len(v) for k, v in cases.items() if isinstance(v, list)})
