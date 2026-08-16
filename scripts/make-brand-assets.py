#!/usr/bin/env python3
"""Process the official SoHo logo into transparent-background brand assets."""
from PIL import Image, ImageDraw
import os
import sys

# Regenerates the SoHo brand assets in public/ from the official logo.
#   python3 scripts/make-brand-assets.py [path/to/soho-logo-official.jpg]
# Requires Pillow. Removes the near-white background (transparent PNGs), builds
# the PWA icon set on the brand navy #122560, and crops the SH-roof monogram.
SRC = sys.argv[1] if len(sys.argv) > 1 else \
    '/home/nguye/firstmate/data/soho-logo-branding/soho-logo-official.jpg'
PUB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')

NAVY = (18, 37, 96, 255)   # brand deep navy #122560

src = Image.open(SRC).convert('RGB')
W, H = src.size
px = src.load()

OP, CL = 196.0, 230.0   # luminance ramp: <OP opaque, >CL transparent
rgba = Image.new('RGBA', (W, H))
rp = rgba.load()
for y in range(H):
    for x in range(W):
        r, g, b = px[x, y]
        L = 0.299*r + 0.587*g + 0.114*b
        if L <= OP:
            a = 255
        elif L >= CL:
            a = 0
        else:
            a = int(255 * (CL - L) / (CL - OP))
        rp[x, y] = (r, g, b, a)

def bbox_alpha(img, y0, y1, thr=70):
    p = img.load()
    minx, miny, maxx, maxy = img.width, img.height, -1, -1
    for y in range(y0, y1):
        for x in range(img.width):
            if p[x, y][3] >= thr:
                minx = min(minx, x); miny = min(miny, y)
                maxx = max(maxx, x); maxy = max(maxy, y)
    return (minx, miny, maxx+1, maxy+1)

def save_png(img, name, colors=None):
    path = os.path.join(PUB, name)
    if colors:
        img = img.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    img.save(path, optimize=True)
    return os.path.getsize(path)

# ── logo-full.png : mark + wordmark, exclude faint bottom caption (y<=358) ──
fb = bbox_alpha(rgba, 0, 358)
pad = 10
full = rgba.crop((max(0,fb[0]-pad), max(0,fb[1]-pad), min(W,fb[2]+pad), min(358,fb[3]+pad)))
full = full.resize((640, round(full.height*640/full.width)), Image.LANCZOS)
sz = save_png(full, 'logo-full.png', colors=128)
print('logo-full', full.size, sz)

# ── logo-mark.png : SH-under-roof monogram only (rows ~60..236) ──
mb = bbox_alpha(rgba, 60, 236)
mono = rgba.crop((mb[0]-6, mb[1]-6, mb[2]+6, mb[3]+6))
side = max(mono.size)
mark = Image.new('RGBA', (side, side), (0,0,0,0))
mark.paste(mono, ((side-mono.width)//2, (side-mono.height)//2), mono)
mark512 = mark.resize((512, 512), Image.LANCZOS)
sz = save_png(mark512, 'logo-mark.png', colors=128)
print('logo-mark', mark512.size, sz)

def icon_on_navy(size, mark_frac, radius_frac):
    canvas = Image.new('RGBA', (size, size), (0,0,0,0))
    d = ImageDraw.Draw(canvas)
    if radius_frac > 0:
        d.rounded_rectangle([0,0,size-1,size-1], radius=int(size*radius_frac), fill=NAVY)
    else:
        d.rectangle([0,0,size,size], fill=NAVY)
    m = int(size*mark_frac)
    mk = mark.resize((m, m), Image.LANCZOS)
    canvas.paste(mk, ((size-m)//2, (size-m)//2), mk)
    return canvas

total = sz
for name, (size, frac, rad, colors) in {
    'icon-192.png': (192, 0.76, 0.18, 64),
    'icon-512.png': (512, 0.76, 0.18, 64),
    'icon-192-maskable.png': (192, 0.64, 0.0, 64),
    'icon-512-maskable.png': (512, 0.64, 0.0, 64),
    'apple-touch-icon.png': (180, 0.74, 0.0, 64),
    'favicon-32.png': (32, 0.82, 0.20, 32),
    'favicon-48.png': (48, 0.82, 0.20, 32),
}.items():
    s = save_png(icon_on_navy(size, frac, rad), name, colors=colors)
    print(name, s)

print('done')
