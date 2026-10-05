#!/usr/bin/env python3
"""Turn a `tmux capture-pane -e -p` dump into a framed HTML page for screenshots.

usage: ansi2html.py <in.ansi> <out.html> <title> [first_col] [last_col] [first_row] [last_row]
Columns and rows are 1-based and inclusive; they crop the capture.
"""
import html
import re
import sys

BASE16 = ['#1B1B2E', '#F05252', '#10B981', '#E5B53A', '#3B82F6', '#C084FC', '#00D4FF', '#D7D7E0',
          '#6E6E86', '#FF6B6B', '#34D399', '#FACC15', '#60A5FA', '#E879F9', '#67E8F9', '#FFFFFF']
FG, BG = '#D7D7E0', '#0B0B12'


def xterm256(n):
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return '#%02x%02x%02x' % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return '#%02x%02x%02x' % (v, v, v)


def parse_line(line):
    """Yields (char, style) per visible cell."""
    style = {}
    out = []
    i = 0
    for m in re.finditer(r'\x1b\[([0-9;:]*)m|([^\x1b]+)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.', line):
        if m.group(2) is not None:
            for ch in m.group(2):
                out.append((ch, dict(style)))
            continue
        if m.group(1) is None:
            continue
        codes = [int(c) if c.isdigit() else 0 for c in re.split('[;:]', m.group(1) or '0')]
        k = 0
        while k < len(codes):
            c = codes[k]
            if c == 0:
                style = {}
            elif c == 1:
                style['bold'] = True
            elif c == 2:
                style['dim'] = True
            elif c == 3:
                style['italic'] = True
            elif c == 4:
                style['underline'] = True
            elif c == 7:
                style['inverse'] = True
            elif c == 22:
                style.pop('bold', None); style.pop('dim', None)
            elif c == 23:
                style.pop('italic', None)
            elif c == 24:
                style.pop('underline', None)
            elif c == 27:
                style.pop('inverse', None)
            elif 30 <= c <= 37:
                style['fg'] = BASE16[c - 30]
            elif 90 <= c <= 97:
                style['fg'] = BASE16[c - 90 + 8]
            elif 40 <= c <= 47:
                style['bg'] = BASE16[c - 40]
            elif 100 <= c <= 107:
                style['bg'] = BASE16[c - 100 + 8]
            elif c == 39:
                style.pop('fg', None)
            elif c == 49:
                style.pop('bg', None)
            elif c in (38, 48) and k + 1 < len(codes):
                key = 'fg' if c == 38 else 'bg'
                if codes[k + 1] == 5 and k + 2 < len(codes):
                    style[key] = xterm256(codes[k + 2]); k += 2
                elif codes[k + 1] == 2 and k + 4 < len(codes):
                    style[key] = '#%02x%02x%02x' % tuple(codes[k + 2:k + 5]); k += 4
            k += 1
    return out


def is_dim_bg(color):
    if not color or not color.startswith('#') or len(color) != 7:
        return False
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    return max(r, g, b) < 90 and abs(r - g) < 20 and abs(g - b) < 28


def css(style):
    fg, bg = style.get('fg', FG), style.get('bg')
    if is_dim_bg(bg) and not style.get('inverse'):
        bg = None
    if style.get('inverse'):
        fg, bg = (bg or BG), fg
    parts = [f'color:{fg}']
    if bg:
        parts.append(f'background:{bg}')
    if style.get('bold'):
        parts.append('font-weight:700')
    if style.get('dim'):
        parts.append('opacity:.55')
    if style.get('italic'):
        parts.append('font-style:italic')
    if style.get('underline'):
        parts.append('text-decoration:underline')
    return ';'.join(parts)


def main():
    src, dst, title = sys.argv[1:4]
    c0, c1, r0, r1 = (int(x) for x in (sys.argv[4:8] + ['1', '9999', '1', '9999'][len(sys.argv[4:8]):]))
    rows = open(src, encoding='utf-8', errors='replace').read().split('\n')[r0 - 1:r1]
    # Drop trailing blank rows.
    while rows and not re.sub(r'\x1b\[[0-9;:]*m', '', rows[-1]).strip():
        rows.pop()
    import os
    blank = re.compile(os.environ['BLANK_RE']) if os.environ.get('BLANK_RE') else None
    blank_to = int(os.environ.get('BLANK_COLS', '0'))
    body = []
    for row in rows:
        cells = parse_line(row)
        if blank and blank.search(''.join(ch for ch, _ in cells[:blank_to or None])):
            cells = [(' ', {}) if i < blank_to else cell for i, cell in enumerate(cells)]
        cells = cells[c0 - 1:c1]
        spans, run, cur = [], '', None
        for ch, st in cells:
            key = css(st)
            if key != cur and run:
                spans.append(f'<span style="{cur}">{html.escape(run)}</span>'); run = ''
            cur = key
            run += ch
        if run:
            spans.append(f'<span style="{cur}">{html.escape(run)}</span>')
        body.append(''.join(spans) or ' ')
    open(dst, 'w').write(f'''<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>*{{margin:0;box-sizing:border-box}}html,body{{background:#060609}}
body{{padding:28px;display:inline-block}}
.win{{border:1px solid #252542;border-radius:12px;background:{BG};overflow:hidden;box-shadow:0 24px 70px #000c;display:inline-block}}
.bar{{height:34px;border-bottom:1px solid #1B1B2E;display:flex;align-items:center;gap:8px;padding:0 14px;color:#7A7A92;font:13px 'JetBrains Mono',monospace}}
.bar i{{width:11px;height:11px;border-radius:50%;background:#2A2A40;display:inline-block}}.bar span{{margin-left:12px}}
pre{{font:15px/1.45 'JetBrains Mono',monospace;color:{FG};padding:14px 18px 16px;white-space:pre;-webkit-font-smoothing:antialiased}}
</style></head><body><div class="win"><div class="bar"><i></i><i></i><i></i><span>{html.escape(title)}</span></div>
<pre>{chr(10).join(body)}</pre></div></body></html>''')


main()
