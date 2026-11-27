# Sources of the redrawn images

`router-model-menu.html`, `advisor-model-menu.html` and `ultracode-explainer-switches.html` draw the Model router, Advisor and switch-only menus, and `sessions-overview.html` draws the Sessions Overview page, from the plugin's own CSS and strings and
DSH's dark theme tokens (`@deepseek-ai/dsh-client-ui-theme`, `design-platform.css`). Render it at 2x
with `python3 render.py <absolute path to the html> <out.png>` (Playwright, Chromium), then
`cwebp -q 90 -m 6 <out.png> -o ../<name>.webp`.

These are redraws, not captures. The host's switch is drawn approximately, and the model names are
sample data.
