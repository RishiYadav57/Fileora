// Builds the Tailwind stylesheets the pages used to generate in the browser with the CDN script.
// Run by hand after changing classes in a page or script:  node scripts/build-tailwind.js
// The output (assets/tailwind-*.css) is committed, so the site build (scripts/build-public.js) needs no Tailwind install.
// Pinned to the version the CDN served when these pages were converted (3.4.17); override the tool with TAILWIND_CLI=<path to tailwindcss cli.js>.
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const VERSION = '3.4.17';

// One stylesheet per distinct page configuration (each config is kept exactly as the pages had it, not merged):
//   app     -> index.html and the 27 tool pages generated from it (adds the `inter` font family)
//   basic   -> 404, privacy, security, troubleshooting (brand colours only)
//   content -> about, contact, cookie-policy, disclaimer, download, faq, file-retention, privacy-policy, terms
const GROUPS = ['app', 'basic', 'content'];

for (const g of GROUPS) {
  const args = ['-c', path.join(__dirname, 'tailwind', g + '.config.js'), '-i', path.join(__dirname, 'tailwind', 'input.css'), '-o', path.join(root, 'assets', 'tailwind-' + g + '.css'), '--minify'];
  const cli = process.env.TAILWIND_CLI;
  const r = cli
    ? spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
    : spawnSync('npx', ['--yes', 'tailwindcss@' + VERSION, ...args], { stdio: 'inherit', shell: true });
  if (r.status !== 0) { console.error('Tailwind build failed for ' + g); process.exit(r.status || 1); }
}
console.log('Tailwind stylesheets written to assets/tailwind-*.css');
