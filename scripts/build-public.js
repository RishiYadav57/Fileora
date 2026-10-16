// Copies ONLY the public front-end files into dist/ (used for static hosting such as Netlify).
// Server code, tests, fixtures, backups, logs and .env files are never copied.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'dist');
const PAGES = ['index', '404', 'about', 'contact', 'cookie-policy', 'disclaimer', 'download', 'faq', 'file-retention', 'privacy-policy', 'privacy', 'security', 'terms', 'troubleshooting'].map(n => n + '.html');
const FILES = [...PAGES, 'converter-engine.js', 'seo-data.js', 'robots.txt', 'sitemap.xml', '_redirects'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of FILES) { if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(out, f)); }
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });

// One static page per tool (dist/tools/<slug>.html, served at /tools/<slug>): the same title, description, canonical, Open Graph,
// JSON-LD and hero that the live server renders, built from seo-data.js, so crawlers get correct metadata in the first response.
const SEO_DATA = require(path.join(root, 'seo-data.js'));
const { renderToolHtml } = require(path.join(root, 'seo-render.js'));
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
fs.mkdirSync(path.join(out, 'tools'), { recursive: true });
let toolPages = 0;
for (const [id, tool] of Object.entries(SEO_DATA)) {
  fs.writeFileSync(path.join(out, 'tools', id + '.html'), renderToolHtml(indexHtml, tool, id));
  toolPages++;
}
console.log(`dist/tools: ${toolPages} static tool pages`);
const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log(`dist/ ready: ${count(out)} files`);
