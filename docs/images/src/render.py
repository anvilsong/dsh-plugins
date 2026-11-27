import sys
from playwright.sync_api import sync_playwright
src, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(device_scale_factor=2, viewport={'width': 1100, 'height': 900})
    pg.goto('file://' + src)
    el = pg.locator('#stage')
    el.screenshot(path=out, type='png')
    b.close()
print('ok')
