"""Erzeugt eine einzelne HTML-Datei, die per Doppelklick funktioniert."""
import json, re, pathlib
root = pathlib.Path(__file__).parent
html = (root / 'index.html').read_text(encoding='utf-8')
css = (root / 'styles.css').read_text(encoding='utf-8')
js = (root / 'app.js').read_text(encoding='utf-8')
data = json.loads((root / 'data/outbreaks.json').read_text(encoding='utf-8'))
icon = (root / 'icon.svg').read_text(encoding='utf-8')
import base64
icon_uri = 'data:image/svg+xml;base64,' + base64.b64encode(icon.encode()).decode()
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>\n' + css + '\n</style>')
html = html.replace('icon.svg', icon_uri)
safe = lambda t: t.replace('</script', '<\\/script')
html = html.replace('<script src="app.js"></script>',
    '<script>window.GPR_DATA = ' + safe(json.dumps(data, ensure_ascii=False)) + ';</script>\n<script>\n' + safe(js) + '\n</script>')
out = root.parent / 'Gefluegelpest-Radar.html'
out.write_text(html, encoding='utf-8')
print(out, len(html))
