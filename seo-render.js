// Builds the HTML for one tool page from the shared index.html: unique title, description, canonical, Open Graph / Twitter
// tags, JSON-LD and the pre-rendered hero. Used by the server (live rendering) and by scripts/build-public.js (static pages),
// so both always produce the same result from seo-data.js.
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderToolHtml(html, tool, toolId) {
    // 1. Unique Page Title
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(tool.title)}</title>`);

    // 2. Meta description
    html = html.replace(/<meta\s+name=["']description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="description" content="${escapeHtml(tool.metaDescription)}">`);

    // 3. Canonical link
    html = html.replace(/<link\s+rel=["']canonical["']\s+href=["'][\s\S]*?["']\s*\/?>/i,
      `<link rel="canonical" href="${tool.canonical}">`);

    // 4. Open Graph tags
    html = html.replace(/<meta\s+property=["']og:title["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta property="og:title" content="${escapeHtml(tool.title)}">`);
    html = html.replace(/<meta\s+property=["']og:description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta property="og:description" content="${escapeHtml(tool.metaDescription)}">`);
    html = html.replace(/<meta\s+property=["']og:url["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta property="og:url" content="${tool.canonical}">`);

    // 5. Twitter card tags
    html = html.replace(/<meta\s+name=["']twitter:title["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="twitter:title" content="${escapeHtml(tool.title)}">`);
    html = html.replace(/<meta\s+name=["']twitter:description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="twitter:description" content="${escapeHtml(tool.metaDescription)}">`);
    html = html.replace(/<meta\s+name=["']twitter:url["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="twitter:url" content="${tool.canonical}">`);

    // 6. JSON-LD structured data (WebApplication, BreadcrumbList, FAQPage)
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebApplication",
          "@id": `${tool.canonical}#app`,
          "url": tool.canonical,
          "name": tool.name || tool.h1,
          "description": tool.metaDescription,
          "applicationCategory": "BusinessApplication",
          "operatingSystem": "All modern browsers (Chrome, Edge, Firefox, Safari)",
          "offers": {
            "@type": "Offer",
            "price": "0",
            "priceCurrency": "USD"
          }
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${tool.canonical}#breadcrumb`,
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "name": "Home",
              "item": "https://pdfconverterfree.in/"
            },
            {
              "@type": "ListItem",
              "position": 2,
              "name": tool.name || tool.h1,
              "item": tool.canonical
            }
          ]
        },
        {
          "@type": "FAQPage",
          "@id": `${tool.canonical}#faq`,
          "mainEntity": (tool.faqs || []).map(f => ({
            "@type": "Question",
            "name": f.q,
            "acceptedAnswer": {
              "@type": "Answer",
              "text": f.a
            }
          }))
        }
      ]
    };

    html = html.replace(/<script\s+id=["']seo-jsonld["']\s+type=["']application\/ld\+json["'][\s\S]*?<\/script>/i,
      `<script id="seo-jsonld" type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>`);

    // 7. Pre-render Hero H1 and Subtitle in raw HTML
    const heroH1Rendered = tool.h1Html || escapeHtml(tool.h1);
    html = html.replace(/<h1 id=["']hero-main-h1["'][\s\S]*?<\/h1>/i,
      `<h1 id="hero-main-h1" class="text-2xl sm:text-3xl md:text-4xl font-black text-slate-950 dark:text-white tracking-tight leading-tight">${heroH1Rendered}</h1>`);
    html = html.replace(/<p id=["']hero-main-sub["'][\s\S]*?<\/p>/i,
      `<p id="hero-main-sub" class="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1 sm:mt-1.5 max-w-xl mx-auto leading-normal">${escapeHtml((tool.intro || '').split('\\n')[0])}</p>`);

    // 8. Bootstrap client script with current tool ID
    html = html.replace('</body>', `<script>window.INITIAL_TOOL_ID = "${toolId}";</script>\n</body>`);
  return html;
}

module.exports = { renderToolHtml, escapeHtml };
