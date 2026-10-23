// Same Tailwind settings as the inline `tailwind.config` these pages used with the CDN script (kept identical, not merged with the other page groups).
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const at = (...p) => path.join(root, ...p).split(path.sep).join('/');

module.exports = {
  content: [
    at('404.html'),
    at('privacy.html'),
    at('security.html'),
    at('troubleshooting.html'),
    at('assets/*.js'),
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af"
        }
      }
    }
  }
};
