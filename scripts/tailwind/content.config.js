// Same Tailwind settings as the inline `tailwind.config` these pages used with the CDN script (kept identical, not merged with the other page groups).
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const at = (...p) => path.join(root, ...p).split(path.sep).join('/');

module.exports = {
  content: [
    at('about.html'),
    at('contact.html'),
    at('cookie-policy.html'),
    at('disclaimer.html'),
    at('download.html'),
    at('faq.html'),
    at('file-retention.html'),
    at('privacy-policy.html'),
    at('terms.html'),
    at('assets/*.js'),
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Plus Jakarta Sans",
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
