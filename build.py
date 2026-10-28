"""Bundle index.html + js/*.js into one self-contained file: dist/ki-port.html (no ROM data inside)."""
import os, re
HERE = os.path.dirname(os.path.abspath(__file__))
html = open(os.path.join(HERE, 'index.html'), encoding='utf-8').read()
def inline(m):
    src = open(os.path.join(HERE, m.group(1)), encoding='utf-8').read()
    return '<script>\n' + src.replace('</script', '<\/script') + '\n</script>'
out = re.sub(r'<script src="([^"]+)"></script>', inline, html)
notices = os.path.join(HERE, 'THIRD_PARTY_NOTICES.md')
if os.path.isfile(notices):
    with open(notices, encoding='utf-8-sig') as f:
        out = out.replace('<head>', '<head>\n<!-- Original software: MIT (LICENSE). Third-party notices:\n' + f.read() + '\n-->')
os.makedirs(os.path.join(HERE, 'dist'), exist_ok=True)
p = os.path.join(HERE, 'dist', 'ki-port.html')
open(p, 'w', encoding='utf-8').write(out)
print(p, len(out), 'bytes')
