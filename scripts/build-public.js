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
const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log(`dist/ ready: ${count(out)} files`);
