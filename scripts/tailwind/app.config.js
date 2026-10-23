// Same Tailwind settings as the inline `tailwind.config` these pages used with the CDN script (kept identical, not merged with the other page groups).
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const at = (...p) => path.join(root, ...p).split(path.sep).join('/');

module.exports = {
  content: [
    at('index.html'),
    at('seo-render.js'),
    at('seo-data.js'),
    at('converter-engine.js'),
    at('assets/*.js'),
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Plus Jakarta Sans",
          "sans-serif"
        ],
        inter: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif"
        ]
      },
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
