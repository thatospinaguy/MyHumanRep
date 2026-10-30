/** Static public assets served by the Worker (no build step, no client JS). */
export const SITE_CSS = `:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#5d5a54;--line:#e3dfd6;--accent:#1f5d4c;--accent-fg:#fff;--code:#f1eee7;--notice:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--fg:#ecebe7;--muted:#a8a49b;--line:#2c2b28;--accent:#5fc3a4;--accent-fg:#0d0d0c;--code:#1c1b19;--notice:#3a3218}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:focus-visible,.button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:8px;background:var(--bg);padding:4px 8px}
header.site,footer.site,main{max-width:860px;margin:0 auto;padding:16px}
header.site{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
.brand{font-weight:700;text-decoration:none;color:var(--fg);font-size:1.1rem}
nav{display:flex;flex-wrap:wrap;gap:4px 16px}nav a{text-decoration:none}nav a[aria-current=page]{text-decoration:underline;font-weight:600}
h1{font-size:2rem;line-height:1.2;margin:1.2em 0 .4em}h2{margin-top:2em;font-size:1.35rem}h3{font-size:1.05rem;margin-top:1.4em}
.hero h1{font-size:2.6rem}.lead{font-size:1.15rem}.muted{color:var(--muted);font-size:.9rem}
.actions{display:flex;flex-wrap:wrap;gap:12px}.button{display:inline-block;padding:10px 18px;border-radius:6px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600}
.button.secondary{background:transparent;color:var(--accent);border:2px solid var(--accent)}
pre{background:var(--code);padding:12px;border-radius:6px;overflow-x:auto;font-size:.85rem;line-height:1.45}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:.92rem}th,td{border-bottom:1px solid var(--line);text-align:left;padding:6px 8px;vertical-align:top}
.cards{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.cards li{border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:4px}
.facts dt{font-weight:600;margin-top:8px}.facts dd{margin:0;overflow-wrap:anywhere}
.notice{background:var(--notice);padding:10px 12px;border-radius:6px}
footer.site{border-top:1px solid var(--line);margin-top:48px}
`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1f5d4c"/><path d="M8 23V9h3l5 7 5-7h3v14h-3v-9l-5 7-5-7v9z" fill="#fff"/></svg>`;
