/**
 * Fileora - Core High-Fidelity Conversion Engine
 * Production-grade document converter supporting:
 * - PDF to DOCX (Text, Headings, Lists, Tables, Images, Scanned OCR Fallback)
 * - PDF to XLSX (Deterministic 2D Table Extraction)
 * - PDF to PPTX (High-Res Visual & Editable Reconstruction)
 * - DOCX to PDF (Client/Node Fallback with formatting, tables & images)
 * - XLSX to PDF (Client/Node Fallback with table grid & auto-orientation)
 * - PPTX to PDF (Client/Node Fallback with slide text & images)
 * - High-Fidelity Image processing (PNG Transparency, EXIF, Lossless JPEG embedding)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const JSZip = require('jszip');
    const pdfLib = require('pdf-lib');
    module.exports = factory(JSZip, pdfLib);
  } else {
    root.FileConverterEngine = factory(root.JSZip, root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (JSZip, PDFLib) {
  'use strict';

  if (!JSZip) {
    console.warn('[FileConverterEngine] JSZip is not available in global scope yet.');
  }

  // -------------------------------------------------------------------------
  // XML & String Escaping Utilities
  // -------------------------------------------------------------------------
  function xmlEscape(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  // Standard PDF fonts only encode WinAnsi; any other character (check marks, Symbol-font bullets, CJK...) makes
  // pdf-lib throw and the whole conversion fail. Map common ones to look-alikes and replace the rest with '?'.
  const WIN_ANSI_FALLBACKS = { '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '→': '->', '←': '<-', '•': '•',
    '': '•', '': '•', '': '>', '': '•', '●': '•', '▪': '•', '−': '-',
    ' ': ' ', ' ': ' ', '​': '', '﻿': '' };
  function winAnsiSafe(text) {
    let out = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) { out += ch; continue; }
      if (Object.prototype.hasOwnProperty.call(WIN_ANSI_FALLBACKS, ch)) { out += WIN_ANSI_FALLBACKS[ch]; continue; }
      out += ('‘’“”–—…€™'.indexOf(ch) >= 0) ? ch : '?';
    }
    return out;
  }
  function safeEmbedFont(pdf, name) {
    return pdf.embedFont(name).then(font => {
      const w = font.widthOfTextAtSize.bind(font), e = font.encodeText.bind(font);
      font.widthOfTextAtSize = (t, s) => w(winAnsiSafe(t), s);
      font.encodeText = t => e(winAnsiSafe(t));
      return font;
    });
  }

  function cleanText(str) {
    if (!str) return '';
    return String(str).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  // -------------------------------------------------------------------------
  // Zero-Dependency Pure JS PNG Encoder (used to embed high-res extracted PDF images)
  // -------------------------------------------------------------------------
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
  }

  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  function createPngChunk(type, data) {
    const len = data.length;
    const chunk = new Uint8Array(12 + len);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, len);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    const crc = crc32(chunk.subarray(4, 8 + len));
    view.setUint32(8 + len, crc);
    return chunk;
  }

  // Deflate using pako, node zlib, or uncompressed DEFLATE store blocks
  function deflateRaw(uncompressed) {
    if (typeof window !== 'undefined' && window.pako && window.pako.deflate) {
      return window.pako.deflate(uncompressed);
    }
    if (typeof require === 'function') {
      try {
        const zlib = require('zlib');
        return new Uint8Array(zlib.deflateSync(uncompressed));
      } catch (e) {}
    }
    // Fallback: standard DEFLATE uncompressed store blocks (compatible with all PNG readers)
    const blocks = [];
    let offset = 0;
    while (offset < uncompressed.length) {
      const remaining = uncompressed.length - offset;
      const chunkSize = Math.min(remaining, 65535);
      const isFinal = (offset + chunkSize) >= uncompressed.length;
      const header = new Uint8Array(5);
      header[0] = isFinal ? 0x01 : 0x00;
      header[1] = chunkSize & 0xFF;
      header[2] = (chunkSize >> 8) & 0xFF;
      const nlen = (~chunkSize) & 0xFFFF;
      header[3] = nlen & 0xFF;
      header[4] = (nlen >> 8) & 0xFF;
      blocks.push(header);
      blocks.push(uncompressed.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }
    // Wrap in standard zlib stream: header (0x78, 0x01) + blocks + adler32
    let s1 = 1, s2 = 0;
    for (let i = 0; i < uncompressed.length; i++) {
      s1 = (s1 + uncompressed[i]) % 65521;
      s2 = (s2 + s1) % 65521;
    }
    const adler = ((s2 << 16) | s1) >>> 0;
    const adlerBuf = new Uint8Array(4);
    new DataView(adlerBuf.buffer).setUint32(0, adler);
    const zlibHeader = new Uint8Array([0x78, 0x01]);
    const totalLen = 2 + blocks.reduce((a, b) => a + b.length, 0) + 4;
    const result = new Uint8Array(totalLen);
    let cur = 0;
    result.set(zlibHeader, cur); cur += 2;
    for (const b of blocks) { result.set(b, cur); cur += b.length; }
    result.set(adlerBuf, cur);
    return result;
  }

  function encodeRgbaToPng(width, height, rgbaData) {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width);
    ihdrView.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    const ihdrChunk = createPngChunk('IHDR', ihdr);

    const lineLength = width * 4;
    const filtered = new Uint8Array(height * (lineLength + 1));
    for (let y = 0; y < height; y++) {
      filtered[y * (lineLength + 1)] = 0; // filter byte 0 (None)
      filtered.set(rgbaData.subarray(y * lineLength, (y + 1) * lineLength), y * (lineLength + 1) + 1);
    }
    const compressed = deflateRaw(filtered);
    const idatChunk = createPngChunk('IDAT', compressed);
    const iendChunk = createPngChunk('IEND', new Uint8Array(0));

    const total = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
    const out = new Uint8Array(total);
    let pos = 0;
    out.set(signature, pos); pos += signature.length;
    out.set(ihdrChunk, pos); pos += ihdrChunk.length;
    out.set(idatChunk, pos); pos += idatChunk.length;
    out.set(iendChunk, pos);
    return out;
  }

  function normalizeFontFamily(rawName) {
    if (!rawName) return 'Calibri';
    const clean = String(rawName).replace(/^[A-Z0-9]{6}\+/, '');
    if (/timesnewroman|times/i.test(clean) && !/liberation/i.test(clean)) return 'Times New Roman';
    if (/arial|helvetica/i.test(clean) && !/liberation|dejavu/i.test(clean)) return 'Arial';
    if (/calibri|carlito|aptos/i.test(clean)) return 'Calibri';
    if (/liberationserif/i.test(clean)) return 'Liberation Serif';
    if (/liberationsans/i.test(clean)) return 'Liberation Sans';
    if (/dejavusans/i.test(clean)) return 'DejaVu Sans';
    if (/dejavuserif/i.test(clean)) return 'DejaVu Serif';
    if (/georgia/i.test(clean)) return 'Georgia';
    if (/garamond|ebgaramond/i.test(clean)) return 'Garamond';
    if (/cambria/i.test(clean)) return 'Cambria';
    if (/trebuchet/i.test(clean)) return 'Trebuchet MS';
    if (/verdana/i.test(clean)) return 'Verdana';
    if (/tahoma/i.test(clean)) return 'Tahoma';
    if (/palatino|bookantiqua/i.test(clean)) return 'Palatino Linotype';
    if (/centurygothic/i.test(clean)) return 'Century Gothic';
    if (/courier|liberationmono/i.test(clean)) return 'Courier New';
    if (/consolas/i.test(clean)) return 'Consolas';
    if (/segoe/i.test(clean)) return 'Segoe UI';
    if (/roboto/i.test(clean)) return 'Roboto';
    if (/open\s*sans/i.test(clean)) return 'Open Sans';
    if (/lato/i.test(clean)) return 'Lato';
    if (/montserrat/i.test(clean)) return 'Montserrat';
    if (/poppins/i.test(clean)) return 'Poppins';
    if (/serif/i.test(clean)) return 'Times New Roman';
    if (/sans/i.test(clean)) return 'Arial';
    if (/mono/i.test(clean)) return 'Courier New';
    const trimmed = clean.replace(/[,\-_](Bold|Italic|Regular|BoldItalic|Medium|Light|SemiBold|Heavy|Black|PSMT|MT|Roman).*$/i, '').trim();
    return trimmed || 'Calibri';
  }

  // -------------------------------------------------------------------------
  // PDF Text & Geometry Extraction (compatible with PDF.js)
  // -------------------------------------------------------------------------
  async function extractPdfPagesData(pdfDoc, options = {}) {
    const totalPages = pdfDoc.numPages;
    const pages = [];
    const maxPages = options.maxPages || totalPages;

    for (let pageNum = 1; pageNum <= Math.min(totalPages, maxPages); pageNum++) {
      if (options.onProgress) {
        options.onProgress({
          step: 'extracting',
          current: pageNum,
          total: totalPages,
          message: `Analyzing page ${pageNum} of ${totalPages}...`
        });
      }

      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const width = viewport.width;
      const height = viewport.height;

      const textContent = await page.getTextContent({ normalizeWhitespace: true });
      const rawItems = textContent.items || [];
      const styles = textContent.styles || {};

      // Map true font family names from page operator list
      let ops = null;
      try { ops = await page.getOperatorList(); } catch (e) {}

      const opsLib = (typeof pdfjsLib !== 'undefined' && pdfjsLib.OPS)
        ? pdfjsLib.OPS
        : (typeof window !== 'undefined' && window.pdfjsLib && window.pdfjsLib.OPS)
          ? window.pdfjsLib.OPS
          : { setFont: 37, save: 10, restore: 11, transform: 12, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 84 };

      const fontNameMap = {};
      if (ops && ops.fnArray) {
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] === opsLib.setFont && ops.argsArray[i]) {
            const fId = ops.argsArray[i][0];
            let fontObj = null;
            if (page.commonObjs) {
              try { fontObj = page.commonObjs.get(fId); } catch (e) {}
            }
            if (!fontObj && page.objs) {
              try { fontObj = page.objs.get(fId); } catch (e) {}
            }
            if (fontObj && fontObj.name) fontNameMap[fId] = fontObj.name;
          }
        }
      }

      // Extract embedded images from operator list
      function multiplyMatrix(m1, m2) {
        if (!m1 || !m2 || m1.length < 6 || m2.length < 6) return m1 || [1,0,0,1,0,0];
        return [
          m1[0] * m2[0] + m1[2] * m2[1],
          m1[1] * m2[0] + m1[3] * m2[1],
          m1[0] * m2[2] + m1[2] * m2[3],
          m1[1] * m2[2] + m1[3] * m2[3],
          m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
          m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
        ];
      }

      const images = [];
      if (ops && ops.fnArray) {
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];

        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          const args = ops.argsArray[i];
          if (fn === opsLib.save) {
            stack.push([...ctm]);
          } else if (fn === opsLib.restore) {
            if (stack.length) ctm = stack.pop();
          } else if (fn === opsLib.transform && Array.isArray(args)) {
            ctm = multiplyMatrix(ctm, args);
          } else if (fn === opsLib.paintImageXObject && Array.isArray(args) && args[0]) {
            const imgName = args[0];
            const imgTop = height - ctm[5] - Math.abs(ctm[3]);
            const imgLeft = ctm[4];
            const imgW = Math.abs(ctm[0]);
            const imgH = Math.abs(ctm[3]);
            images.push({
              name: imgName,
              top: Math.max(0, imgTop),
              left: Math.max(0, imgLeft),
              width: imgW,
              height: imgH
            });
          } else if ((fn === opsLib.paintInlineImageXObject || fn === 86 || fn === 84) && Array.isArray(args) && args[0]) {
            const inlineObj = args[0];
            const imgTop = height - ctm[5] - Math.abs(ctm[3]);
            const imgLeft = ctm[4];
            const imgW = Math.abs(ctm[0]) || (inlineObj.width || 100);
            const imgH = Math.abs(ctm[3]) || (inlineObj.height || 100);
            images.push({
              inlineObj: inlineObj,
              top: Math.max(0, imgTop),
              left: Math.max(0, imgLeft),
              width: imgW,
              height: imgH
            });
          }
        }
      }

      const items = [];
      let totalCharCount = 0;

      for (const it of rawItems) {
        if (!it.str || typeof it.str !== 'string' || !it.str.trim()) continue;
        const text = it.str;
        totalCharCount += text.length;

        const tx = it.transform; // [scaleX, skewY, skewX, scaleY, x, y]
        const x = tx ? tx[4] : it.x || 0;
        const y = tx ? tx[5] : it.y || 0;
        const scaleX = tx ? tx[0] : 1;
        const scaleY = tx ? tx[3] : 1;
        const itemWidth = it.width || Math.abs(scaleX) * text.length * 0.5;
        const itemHeight = Math.abs(scaleY) || it.height || 10;

        // In PDF coordinates, y=0 is at the bottom. Convert to top-down:
        const top = height - y - itemHeight;
        const left = x;
        // Store the raw baseline y for accurate line clustering (y in PDF coords = baseline)
        const baselineY = y;

        // Style analysis
        const rawFontKey = it.fontName || '';
        const realFontName = fontNameMap[rawFontKey] || rawFontKey;
        const styleObj = styles[rawFontKey] || {};
        const fontFam = normalizeFontFamily(realFontName || styleObj.fontFamily);
        const isBold = /bold|black|heavy|demi|b\d+/i.test(realFontName) || /bold/i.test(styleObj.fontFamily);
        const isItalic = /italic|oblique|slanted/i.test(realFontName) || /italic/i.test(styleObj.fontFamily);
        let derivedSize = itemHeight;
        if (tx && (tx[0] || tx[3])) {
          const sx = Math.hypot(tx[0], tx[1]);
          const sy = Math.hypot(tx[2], tx[3]);
          derivedSize = sy || sx || derivedSize;
        }
        const fontSize = Math.round(Math.max(4, Math.min(144, derivedSize)));

        items.push({
          text,
          left,
          top,
          right: left + itemWidth,
          bottom: top + itemHeight,
          width: itemWidth,
          height: itemHeight,
          fontSize,
          baselineY,
          isBold,
          isItalic,
          fontFamily: fontFam
        });
      }

      // Check if page is primarily a scan (full covering image and minimal selectable text)
      const hasCoveringImage = images.some(img => (img.width >= width * 0.5 && img.height >= height * 0.5));
      const isScanned = totalCharCount < 40 && hasCoveringImage;

      pages.push({
        pageNum,
        width,
        height,
        orientation: width > height ? 'landscape' : 'portrait',
        items,
        images,
        isScanned,
        charCount: totalCharCount,
        pageRef: page
      });
    }

    return pages;
  }

  // -------------------------------------------------------------------------
  // Layout Clustering: Lines, Tables, Headings, Paragraphs
  // -------------------------------------------------------------------------
  function analyzePageLayout(pageData) {
    const { items, width, height } = pageData;
    if (!items.length) {
      return { elements: [], tables: [], isScanned: pageData.isScanned };
    }

    const isSlidePresentation = width > height && (width > 900 || height > 500);
    const scaleFactor = isSlidePresentation ? 792 / width : 1.0;

    items.forEach(it => {
      it.effectiveFontSize = Math.round(it.fontSize * scaleFactor);
    });

    const elements = [];
    const tables = [];

    if (isSlidePresentation) {
      // -------------------------------------------------------------
      // SLIDE PRESENTATION LAYOUT ANALYZER
      // -------------------------------------------------------------
      const xClusters = [];
      const sortedByX = [...items].sort((a, b) => a.left - b.left);
      for (const it of sortedByX) {
        let matched = xClusters.find(c => Math.abs(c.center - it.left) < 35);
        if (matched) {
          matched.items.push(it);
          matched.center = matched.items.reduce((s, i) => s + i.left, 0) / matched.items.length;
        } else {
          xClusters.push({ center: it.left, items: [it] });
        }
      }

      const significantClusters = xClusters.filter(c => c.items.length >= 3).sort((a, b) => a.center - b.center);

      // Case 1: Structured Multi-Column Table on slide (e.g. Slide 5 Literature Survey)
      if (significantClusters.length >= 3) {
        const colCenters = significantClusters.map(c => c.center);
        const minX = colCenters[0] - 50;
        const maxX = colCenters[colCenters.length - 1] + 350;

        const tableItems = items.filter(it => it.left >= minX && it.left <= maxX && it.top > 70 && (it.right - it.left) < (maxX - minX) * 0.8);
        const nonTableItems = items.filter(it => !tableItems.includes(it));

        for (const it of nonTableItems) {
          const sz = it.effectiveFontSize || it.fontSize;
          const role = sz >= 18 ? 'heading1' : sz >= 14 ? 'heading2' : 'paragraph';
          elements.push({
            type: role,
            text: it.text,
            fontSize: sz,
            isBold: it.isBold,
            fontFamily: it.fontFamily,
            align: (it.left > width * 0.2 && it.right < width * 0.8) ? 'center' : 'left',
            top: it.top
          });
        }

        if (tableItems.length) {
          const col0Items = tableItems.filter(it => Math.abs(it.left - colCenters[0]) < 60 && /^\d+$/.test(it.text))
            .sort((a, b) => a.top - b.top);

          let rowCuts = [];
          if (col0Items.length >= 2) {
            const headerBottom = Math.max(...tableItems.filter(it => it.top < col0Items[0].top).map(it => it.bottom), 0);
            const firstRowTop = col0Items[0].top;
            const headerCut = headerBottom > 0 ? (headerBottom + firstRowTop) / 2 : firstRowTop - 15;
            rowCuts.push({ min: 0, max: headerCut, name: 'Header' });
            for (let r = 0; r < col0Items.length; r++) {
              const min = r === 0 ? headerCut : (col0Items[r - 1].top + col0Items[r].top) / 2;
              const max = r === col0Items.length - 1 ? 99999 : (col0Items[r].top + col0Items[r + 1].top) / 2;
              rowCuts.push({ min, max, name: 'Row ' + (r + 1) });
            }
          } else {
            tableItems.sort((a, b) => a.top - b.top);
            let curMin = tableItems[0].top - 5;
            for (let i = 1; i < tableItems.length; i++) {
              if (tableItems[i].top - tableItems[i - 1].bottom > 25) {
                rowCuts.push({ min: curMin, max: (tableItems[i].top + tableItems[i - 1].bottom) / 2 });
                curMin = (tableItems[i].top + tableItems[i - 1].bottom) / 2;
              }
            }
            rowCuts.push({ min: curMin, max: 99999 });
          }

          const colBounds = [];
          for (let c = 0; c < colCenters.length; c++) {
            const leftBound = c === 0 ? 0 : (colCenters[c - 1] + colCenters[c]) / 2;
            const rightBound = c === colCenters.length - 1 ? width : (colCenters[c] + colCenters[c + 1]) / 2;
            colBounds.push({ leftBound, rightBound });
          }

          const rows = rowCuts.map(() => colBounds.map(() => ''));
          for (const it of tableItems) {
            const rIdx = rowCuts.findIndex(rc => it.top >= rc.min && it.top < rc.max);
            const cIdx = colBounds.findIndex(cb => it.left >= cb.leftBound && it.left < cb.rightBound);
            if (rIdx !== -1 && cIdx !== -1) {
              rows[rIdx][cIdx] = (rows[rIdx][cIdx] ? rows[rIdx][cIdx] + ' ' : '') + it.text;
            }
          }

          const validRows = rows.filter(r => r.some(cell => cell.trim().length > 0));
          if (validRows.length >= 2) {
            const tblObj = {
              type: 'table',
              rows: validRows,
              colCount: colBounds.length,
              borderless: false,
              top: tableItems[0].top
            };
            elements.push(tblObj);
            tables.push(tblObj);
          }
        }

        const pageImages = pageData.images || [];
        pageImages.forEach(img => {
          elements.push({
            type: 'image',
            top: img.top,
            left: img.left,
            width: img.width,
            height: img.height,
            imgName: img.name
          });
        });

        elements.sort((a, b) => (a.top || 0) - (b.top || 0));
        return { elements, tables, isScanned: pageData.isScanned };
      }

      // Case 2: 2-Column Presentation Layout (e.g. Slide 1 Guide vs Students)
      if (significantClusters.length === 2) {
        const col1Center = significantClusters[0].center;
        const col2Center = significantClusters[1].center;
        const col1Items = significantClusters[0].items.filter(it => it.right < col2Center - 40).sort((a, b) => a.top - b.top);
        const col2Items = significantClusters[1].items.filter(it => it.left > col1Center + 40).sort((a, b) => a.top - b.top);
        const colItems = new Set([...col1Items, ...col2Items]);
        const nonColItems = items.filter(it => !colItems.has(it));

        for (const it of nonColItems) {
          const sz = it.effectiveFontSize || it.fontSize;
          const role = sz >= 18 ? 'heading1' : sz >= 14 ? 'heading2' : 'paragraph';
          elements.push({
            type: role,
            text: it.text,
            fontSize: sz,
            isBold: it.isBold,
            fontFamily: it.fontFamily,
            align: (it.left > width * 0.15 && it.right < width * 0.85) ? 'center' : 'left',
            top: it.top
          });
        }

        const maxRows = Math.max(col1Items.length, col2Items.length);
        if (maxRows > 0) {
          const rows = [];
          for (let r = 0; r < maxRows; r++) {
            rows.push([
              col1Items[r] ? col1Items[r].text : '',
              col2Items[r] ? col2Items[r].text : ''
            ]);
          }
          const tblObj = {
            type: 'table',
            rows,
            colCount: 2,
            borderless: true,
            top: Math.min(col1Items[0] ? col1Items[0].top : 999, col2Items[0] ? col2Items[0].top : 999)
          };
          elements.push(tblObj);
          tables.push(tblObj);
        }

        const pageImages = pageData.images || [];
        pageImages.forEach(img => {
          elements.push({
            type: 'image',
            top: img.top,
            left: img.left,
            width: img.width,
            height: img.height,
            imgName: img.name
          });
        });

        elements.sort((a, b) => (a.top || 0) - (b.top || 0));
        return { elements, tables, isScanned: pageData.isScanned };
      }
    }

    // -------------------------------------------------------------
    // STANDARD DOCUMENT LINE & TABLE ANALYZER (Portrait / A4 / Letter)
    // -------------------------------------------------------------
    // 1. Sort items primarily by baseline y (descending in PDF coords = ascending visually), then left
    items.sort((a, b) => {
      // Use baseline y for sorting: higher baseline y = higher on page in PDF coords
      const baseA = a.baselineY !== undefined ? a.baselineY : (height - a.top - a.height);
      const baseB = b.baselineY !== undefined ? b.baselineY : (height - b.top - b.height);
      const yDiff = baseB - baseA; // descending baseline = ascending visual order
      if (Math.abs(yDiff) > 3) return yDiff;
      return a.left - b.left;
    });

    // 2. Group items into horizontal lines using baseline y-coordinate
    const lines = [];
    for (const it of items) {
      const lastLine = lines[lines.length - 1];
      const itBaseline = it.baselineY !== undefined ? it.baselineY : (height - it.top - it.height);
      if (lastLine) {
        const lastBaseline = lastLine.baselineY;
        // Use a tolerance based on the larger font size in the comparison
        const maxHeight = Math.max(it.height, lastLine.height);
        const tolerance = Math.max(4, maxHeight * 0.5);
        if (Math.abs(lastBaseline - itBaseline) <= tolerance) {
          lastLine.items.push(it);
          lastLine.bottom = Math.max(lastLine.bottom, it.bottom);
          lastLine.right = Math.max(lastLine.right, it.right);
          lastLine.top = Math.min(lastLine.top, it.top);
          // Keep the baseline as the average or the first item's baseline
          continue;
        }
      }
      lines.push({
        top: it.top,
        bottom: it.bottom,
        left: it.left,
        right: it.right,
        height: it.height,
        baselineY: itBaseline,
        items: [it]
      });
    }

    // Sort items within each line from left to right
    for (const line of lines) {
      line.items.sort((a, b) => a.left - b.left);
    }

    let currentTableRows = [];

    function flushTable() {
      if (currentTableRows.length >= 2) {
        const colCount = Math.max(...currentTableRows.map(r => r.cells.length));
        if (colCount >= 2) {
          // Layout-inferred tables from PDF are borderless by default (resumes, CVs, contact info, etc.)
          // Only mark as bordered if there is explicit evidence of a grid table (not yet implemented)
          const isBorderless = true;
          const tblObj = {
            type: 'table',
            rows: currentTableRows.map(r => r.cells),
            colCount,
            borderless: isBorderless,
            top: currentTableRows[0].top,
            bottom: currentTableRows[currentTableRows.length - 1].bottom
          };
          tables.push(tblObj);
          elements.push(tblObj);
          currentTableRows = [];
          return;
        }
      }
      for (const row of currentTableRows) {
        if (row.cells && row.cells.length === 2 && row.cells[0] && row.cells[1]) {
          elements.push({
            type: 'two_column_line',
            top: row.top,
            bottom: row.bottom,
            leftText: row.cells[0],
            rightText: row.cells[1],
            fontSize: Math.max(...row.originalLine.items.map(it => it.effectiveFontSize || it.fontSize)),
            isBold: row.originalLine.items.some(it => it.isBold),
            fontFamily: row.originalLine.items[0] ? row.originalLine.items[0].fontFamily : null
          });
        } else {
          elements.push({
            type: 'paragraph',
            top: row.top,
            line: row.originalLine
          });
        }
      }
      currentTableRows = [];
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const itemsInLine = line.items;

      const hasMultipleColumns = itemsInLine.length >= 2 && itemsInLine.some((it, idx) => {
        if (idx === 0) return false;
        const prev = itemsInLine[idx - 1];
        const prevR = prev.right !== undefined ? prev.right : (prev.left + (prev.width || 0));
        return (it.left - prevR) > 35 && it.left > width * 0.42;
      });

      if (hasMultipleColumns) {
        const cells = [];
        let curCell = itemsInLine[0].text;
        for (let j = 1; j < itemsInLine.length; j++) {
          const prev = itemsInLine[j - 1];
          const curr = itemsInLine[j];
          const prevR = prev.right !== undefined ? prev.right : (prev.left + (prev.width || 0));
          const gap = curr.left - prevR;
          if (gap > 35 && curr.left > width * 0.42) {
            cells.push(cleanText(curCell));
            curCell = curr.text;
          } else {
            curCell += ' ' + curr.text;
          }
        }
        cells.push(cleanText(curCell));

        currentTableRows.push({
          top: line.top,
          bottom: line.bottom,
          cells,
          originalLine: line
        });
      } else {
        if (currentTableRows.length >= 2) {
          flushTable();
        } else if (currentTableRows.length === 1) {
          const singleRow = currentTableRows[0];
          if (singleRow.cells && singleRow.cells.length === 2 && singleRow.cells[0] && singleRow.cells[1]) {
            elements.push({
              type: 'two_column_line',
              top: singleRow.top,
              bottom: singleRow.bottom,
              leftText: singleRow.cells[0],
              rightText: singleRow.cells[1],
              fontSize: Math.max(...singleRow.originalLine.items.map(it => it.effectiveFontSize || it.fontSize)),
              isBold: singleRow.originalLine.items.some(it => it.isBold),
              fontFamily: singleRow.originalLine.items[0] ? singleRow.originalLine.items[0].fontFamily : null
            });
          } else {
            elements.push({
              type: 'paragraph',
              top: singleRow.top,
              line: singleRow.originalLine
            });
          }
          currentTableRows = [];
        }

        const text = line.items.map(it => it.text).join(' ').trim();
        if (text) {
          const maxFontSize = Math.max(...line.items.map(it => it.effectiveFontSize || it.fontSize));
          const isAllBold = line.items.every(it => it.isBold);
          const isBullet = /^([•\u2022\u25CF\u25AA\-*]|\d+[.)])\s/.test(text);

          const isSectionHeading = (
            /^(Objective|Summary|Professional Summary|Skills|Technical Skills|Skills Summary|Experience|Work Experience|Internships|Projects|Key Projects|Education|Academic Qualifications|Certifications|Achievements|Achievements & Certifications|Publications|Awards|Languages|Interests|Personal Details|Declaration)\b/i.test(text) ||
            (isAllBold && text.length < 50 && (maxFontSize >= 12 || (maxFontSize >= 11 && line.items.length <= 4)))
          );

          let role = 'paragraph';
          let hasBottomRule = false;
          if (maxFontSize >= 18) {
            role = 'heading1';
          } else if (maxFontSize >= 14 || isSectionHeading) {
            role = 'heading2';
            // Do not add synthetic borders. Only set hasBottomRule if an actual visual rule is detected in the PDF.
            hasBottomRule = false;
          } else if (isBullet) {
            role = 'list';
          }

          const isCentered = (line.left > width * 0.2 && line.right < width * 0.8 && Math.abs((line.left + line.right) / 2 - width / 2) < width * 0.15);
          const isContactLine = /@/.test(text) || /\+?\d[\d -]{7,}\d/.test(text) || /linkedin\.com|github\.com/i.test(text);

          // Check if this line can merge with previous paragraph to eliminate broken lines and extra spacing
          const prevEl = elements[elements.length - 1];
          const canMergeWithPrev = prevEl &&
            prevEl.type === 'paragraph' &&
            role === 'paragraph' &&
            !isBullet &&
            !prevEl.isBullet &&
            !isContactLine &&
            !prevEl.isContactLine &&
            !prevEl.isSectionHeading &&
            !isSectionHeading &&
            (prevEl.line && (prevEl.line.right > width * 0.65 || /-\s*$/.test(prevEl.text))) &&
            Math.abs(line.left - (prevEl.line ? prevEl.line.left : line.left)) < 25 &&
            Math.abs(line.top - (prevEl.bottom || prevEl.top)) <= Math.max(14, (line.height || 10) * 1.35) &&
            !/[.?!:;]$/.test(prevEl.text.trim()) &&
            Math.abs(maxFontSize - prevEl.fontSize) <= 1.5;

          if (canMergeWithPrev) {
            prevEl.text += ' ' + text;
            if (prevEl.line && prevEl.line.items) {
              prevEl.line.items.push(...line.items);
            }
            prevEl.bottom = line.bottom;
          } else {
            elements.push({
              type: role,
              text,
              line,
              top: line.top,
              bottom: line.bottom,
              fontSize: maxFontSize,
              isBold: isAllBold,
              isItalic: line.items.some(it => it.isItalic),
              align: isCentered ? 'center' : 'left',
              hasBottomRule,
              isContactLine,
              isSectionHeading
            });
          }
        }
      }
    }

    if (currentTableRows.length) {
      flushTable();
    }

    // Merge layout images into elements by top position
    const pageImages = [...(pageData.images || [])];

    // Detect profile photo in top right (e.g. resume header with photo beside name)
    const headerPhoto = pageImages.find(img => img.top < 220 && img.left > width * 0.45 && img.width < 250 && img.height < 250);
    if (headerPhoto) {
      const photoBottom = headerPhoto.top + headerPhoto.height + 15;
      const headerElements = elements.filter(el => {
        if (el.top > photoBottom) return false;
        if (el.isSectionHeading || el.type === 'heading1' || el.type === 'heading2') return false;
        if (el.type === 'table' || el.type === 'two_column_line') return false;
        if (el.line && el.line.left > width * 0.65) return false;
        return true;
      });
      if (headerElements.length > 0) {
        const headerSet = new Set(headerElements);
        const remainingElements = elements.filter(el => !headerSet.has(el));
        const headerObj = {
          type: 'header_with_photo',
          top: 0,
          leftElements: headerElements,
          photo: headerPhoto
        };
        elements.length = 0;
        elements.push(headerObj, ...remainingElements);
        const photoIdx = pageImages.indexOf(headerPhoto);
        if (photoIdx !== -1) pageImages.splice(photoIdx, 1);
      }
    }

    pageImages.forEach(img => {
      elements.push({
        type: 'image',
        top: img.top,
        left: img.left,
        width: img.width,
        height: img.height,
        imgName: img.name,
        inlineObj: img.inlineObj
      });
    });

    elements.sort((a, b) => (a.top || 0) - (b.top || 0));

    return { elements, tables, isScanned: pageData.isScanned };
  }

  // -------------------------------------------------------------------------
  // High-Fidelity DOCX OpenXML Generator
  // -------------------------------------------------------------------------
  async function generateDocxBlob(documentStructure, options = {}) {
    const zip = new JSZip();
    const mediaFiles = options.mediaFiles || []; // [{ id, filename, bytes }]

    // 1. [Content_Types].xml
    let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;
    zip.file('[Content_Types].xml', contentTypesXml);

    // 2. _rels/.rels
    let rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    zip.file('_rels/.rels', rootRelsXml);

    // 3. word/_rels/document.xml.rels
    let docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`;

    mediaFiles.forEach((m, idx) => {
      docRelsXml += `\n  <Relationship Id="rIdMedia${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.filename}"/>`;
      zip.file(`word/media/${m.filename}`, m.bytes);
    });
    docRelsXml += `\n</Relationships>`;
    zip.file('word/_rels/document.xml.rels', docRelsXml);

    // 4. word/styles.xml
    let docFontFamily = options.docFontFamily || 'Calibri';
    if (!options.docFontFamily) {
      const fontCounts = {};
      for (const page of documentStructure) {
        for (const el of (page.elements || [])) {
          if (el.fontFamily) fontCounts[el.fontFamily] = (fontCounts[el.fontFamily] || 0) + (el.text ? el.text.length : 10);
          if (el.line && el.line.items) {
            for (const it of el.line.items) {
              if (it.fontFamily) fontCounts[it.fontFamily] = (fontCounts[it.fontFamily] || 0) + (it.text ? it.text.length : 1);
            }
          }
        }
      }
      let maxCnt = 0;
      for (const f in fontCounts) {
        if (fontCounts[f] > maxCnt) {
          maxCnt = fontCounts[f];
          docFontFamily = f;
        }
      }
    }

    let stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${xmlEscape(docFontFamily)}" w:hAnsi="${xmlEscape(docFontFamily)}" w:cs="${xmlEscape(docFontFamily)}"/>
        <w:sz w:val="22"/>
        <w:color w:val="1E293B"/>
        <w:lang w:val="en-US"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="6" w:line="230" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr>
      <w:spacing w:before="80" w:after="12" w:line="240" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:rFonts w:ascii="${xmlEscape(docFontFamily)}" w:hAnsi="${xmlEscape(docFontFamily)}"/>
      <w:sz w:val="34"/>
      <w:color w:val="0F172A"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr>
      <w:spacing w:before="50" w:after="6" w:line="230" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:rFonts w:ascii="${xmlEscape(docFontFamily)}" w:hAnsi="${xmlEscape(docFontFamily)}"/>
      <w:sz w:val="26"/>
      <w:color w:val="1E293B"/>
    </w:rPr>
  </w:style>
</w:styles>`;
    zip.file('word/styles.xml', stylesXml);

    // 5. word/settings.xml
    let settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
</w:settings>`;
    zip.file('word/settings.xml', settingsXml);

    // 6. word/document.xml body builder
    let bodyXml = '';

    for (let pIdx = 0; pIdx < documentStructure.length; pIdx++) {
      const page = documentStructure[pIdx];

      // If page was scanned, output full-page high-res image
      if (page.isScanned && page.mediaRelId) {
        const emuW = Math.round(page.width * 12700 * 0.95);
        const emuH = Math.round(page.height * 12700 * 0.95);
        bodyXml += `
        <w:p>
          <w:pPr><w:jc w:val="center"/></w:pPr>
          <w:r>
            <w:drawing>
              <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
                <wp:extent cx="${emuW}" cy="${emuH}"/>
                <wp:docPr id="${pIdx + 1}" name="Page Image ${pIdx + 1}"/>
                <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                      <pic:nvPicPr>
                        <pic:cNvPr id="0" name="Page_${pIdx + 1}.png"/>
                        <pic:cNvPicPr/>
                      </pic:nvPicPr>
                      <pic:blipFill>
                        <a:blip r:embed="${page.mediaRelId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
                        <a:stretch><a:fillRect/></a:stretch>
                      </pic:blipFill>
                      <pic:spPr>
                        <a:xfrm><a:off x="0" y="0"/><a:ext cx="${emuW}" cy="${emuH}"/></a:xfrm>
                        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                      </pic:spPr>
                    </pic:pic>
                  </a:graphicData>
                </a:graphic>
              </wp:inline>
            </w:drawing>
          </w:r>
        </w:p>`;
      } else {
        // Digital document: Render extracted elements
        for (const el of page.elements) {
          if (el.type === 'header_with_photo') {
            bodyXml += renderHeaderWithPhoto(el, docFontFamily);
          } else if (el.type === 'two_column_line') {
            bodyXml += renderTwoColumnLine(el, docFontFamily);
          } else if (el.type === 'image' && el.mediaRelId) {
            // Embedded image (e.g. logos, figures, diagrams)
            const maxEmuW = 5943600;
            const aspect = (el.height || 1) / (el.width || 1);
            let targetW = Math.round((el.width || 100) * 12700 * 0.95);
            let targetH = Math.round((el.height || 100) * 12700 * 0.95);
            if (targetW > maxEmuW) {
              targetW = maxEmuW;
              targetH = Math.round(targetW * aspect);
            }
            bodyXml += `
            <w:p>
              <w:pPr><w:jc w:val="center"/><w:spacing w:before="40" w:after="40"/></w:pPr>
              <w:r>
                <w:drawing>
                  <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
                    <wp:extent cx="${targetW}" cy="${targetH}"/>
                    <wp:docPr id="${Math.round(Math.random() * 1000000)}" name="Embedded Image"/>
                    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                          <pic:nvPicPr>
                            <pic:cNvPr id="0" name="image.png"/>
                            <pic:cNvPicPr/>
                          </pic:nvPicPr>
                          <pic:blipFill>
                            <a:blip r:embed="${el.mediaRelId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
                            <a:stretch><a:fillRect/></a:stretch>
                          </pic:blipFill>
                          <pic:spPr>
                            <a:xfrm><a:off x="0" y="0"/><a:ext cx="${targetW}" cy="${targetH}"/></a:xfrm>
                            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                          </pic:spPr>
                        </pic:pic>
                      </a:graphicData>
                    </a:graphic>
                  </wp:inline>
                </w:drawing>
              </w:r>
            </w:p>`;
          } else if (el.type === 'table') {
            bodyXml += renderDocxTable(el, docFontFamily);
          } else if (el.type === 'heading1') {
            bodyXml += renderDocxParagraph(el, '<w:pStyle w:val="Heading1"/>', docFontFamily);
          } else if (el.type === 'heading2') {
            let extra = '<w:pStyle w:val="Heading2"/>';
            if (el.hasBottomRule) {
              extra += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="334155"/></w:pBdr>';
            }
            bodyXml += renderDocxParagraph(el, extra, docFontFamily);
          } else if (el.type === 'list') {
            bodyXml += renderDocxParagraph(el, '<w:ind w:left="400" w:hanging="260"/>', docFontFamily);
          } else {
            // Standard paragraph with formatted runs
            bodyXml += renderDocxParagraph(el, '', docFontFamily);
          }
        }
      }

      // Add page break if not last page
      if (pIdx < documentStructure.length - 1) {
        bodyXml += `
        <w:p>
          <w:r><w:br w:type="page"/></w:r>
        </w:p>`;
      }
    }

    // Section properties (margins, page dimensions)
    const firstPage = documentStructure[0] || { width: 612, height: 792, orientation: 'portrait' };
    const isWidescreen = firstPage.width > 900;
    const pgW = isWidescreen ? 15840 : Math.round(firstPage.width * 20); // Letter landscape or standard twips
    const pgH = isWidescreen ? 12240 : Math.round(firstPage.height * 20);
    const pgOrient = (firstPage.orientation === 'landscape' || isWidescreen) ? 'landscape' : 'portrait';

    let docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="${pgW}" w:h="${pgH}" w:orient="${pgOrient}"/>
      <w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    zip.file('word/document.xml', docXml);

    const zipType = typeof window === 'undefined' ? 'nodebuffer' : 'blob';
    return await zip.generateAsync({
      type: zipType,
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }

  function renderHeaderWithPhoto(el, docFontFamily) {
    const photo = el.photo || {};
    const emuW = Math.round(Math.min(125, photo.width || 100) * 12700);
    const emuH = Math.round(Math.min(125, photo.height || 100) * 12700);

    let leftContent = '';
    for (const item of (el.leftElements || [])) {
      leftContent += renderDocxParagraph(item, '', docFontFamily, true);
    }

    let rightPhotoXml = '';
    if (photo.mediaRelId) {
      rightPhotoXml = `
        <w:p>
          <w:pPr><w:jc w:val="right"/><w:spacing w:after="0" w:line="220" w:lineRule="auto"/></w:pPr>
          <w:r>
            <w:drawing>
              <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
                <wp:extent cx="${emuW}" cy="${emuH}"/>
                <wp:docPr id="${Math.round(Math.random() * 1000000)}" name="Profile Photo"/>
                <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                      <pic:nvPicPr>
                        <pic:cNvPr id="0" name="photo.png"/>
                        <pic:cNvPicPr/>
                      </pic:nvPicPr>
                      <pic:blipFill>
                        <a:blip r:embed="${photo.mediaRelId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
                        <a:stretch><a:fillRect/></a:stretch>
                      </pic:blipFill>
                      <pic:spPr>
                        <a:xfrm><a:off x="0" y="0"/><a:ext cx="${emuW}" cy="${emuH}"/></a:xfrm>
                        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                      </pic:spPr>
                    </pic:pic>
                  </a:graphicData>
                </a:graphic>
              </wp:inline>
            </w:drawing>
          </w:r>
        </w:p>`;
    }

    return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="10800" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>
        </w:tblBorders>
        <w:jc w:val="center"/>
      </w:tblPr>
      <w:tblGrid>
        <w:gridCol w:w="7800"/>
        <w:gridCol w:w="3000"/>
      </w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr>
            <w:tcW w:w="7800" w:type="dxa"/>
            <w:tcMar><w:top w:w="0"/><w:bottom w:w="0"/><w:left w:w="0"/><w:right w:w="80"/></w:tcMar>
          </w:tcPr>
          ${leftContent}
        </w:tc>
        <w:tc>
          <w:tcPr>
            <w:tcW w:w="3000" w:type="dxa"/>
            <w:tcMar><w:top w:w="0"/><w:bottom w:w="0"/><w:left w:w="80"/><w:right w:w="0"/></w:tcMar>
          </w:tcPr>
          ${rightPhotoXml || '<w:p/>'}
        </w:tc>
      </w:tr>
    </w:tbl>`;
  }

  function renderTwoColumnLine(el, docFontFamily) {
    const leftText = el.leftText || '';
    const rightText = el.rightText || '';
    const fam = el.fontFamily || docFontFamily || 'Calibri';
    const isBold = el.isBold || false;
    const isItalic = el.isItalic || false;
    const sz = el.fontSize ? Math.round(el.fontSize * 2) : 22;

    return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="10800" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>
          <w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>
        </w:tblBorders>
        <w:jc w:val="center"/>
      </w:tblPr>
      <w:tblGrid>
        <w:gridCol w:w="7500"/>
        <w:gridCol w:w="3300"/>
      </w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr>
            <w:tcW w:w="7500" w:type="dxa"/>
            <w:tcMar><w:top w:w="20"/><w:bottom w:w="20"/><w:left w:w="0"/><w:right w:w="60"/></w:tcMar>
          </w:tcPr>
          <w:p>
            <w:pPr><w:jc w:val="left"/><w:spacing w:after="20" w:line="230" w:lineRule="auto"/></w:pPr>
            <w:r>
              <w:rPr>
                <w:rFonts w:ascii="${xmlEscape(fam)}" w:hAnsi="${xmlEscape(fam)}"/>
                ${isBold ? '<w:b/>' : ''}
                ${isItalic ? '<w:i/>' : ''}
                <w:sz w:val="${sz}"/>
              </w:rPr>
              <w:t xml:space="preserve">${xmlEscape(leftText)}</w:t>
            </w:r>
          </w:p>
        </w:tc>
        <w:tc>
          <w:tcPr>
            <w:tcW w:w="3300" w:type="dxa"/>
            <w:tcMar><w:top w:w="20"/><w:bottom w:w="20"/><w:left w:w="60"/><w:right w:w="0"/></w:tcMar>
          </w:tcPr>
          <w:p>
            <w:pPr><w:jc w:val="right"/><w:spacing w:after="20" w:line="230" w:lineRule="auto"/></w:pPr>
            <w:r>
              <w:rPr>
                <w:rFonts w:ascii="${xmlEscape(fam)}" w:hAnsi="${xmlEscape(fam)}"/>
                ${isBold ? '<w:b/>' : ''}
                ${isItalic ? '<w:i/>' : ''}
                <w:sz w:val="${sz}"/>
              </w:rPr>
              <w:t xml:space="preserve">${xmlEscape(rightText)}</w:t>
            </w:r>
          </w:p>
        </w:tc>
      </w:tr>
    </w:tbl>`;
  }

  function renderDocxParagraph(el, pPrExtra = '', docFontFamily = 'Calibri', isCompact = false) {
    if (!el) return '';
    const items = el.line ? el.line.items : null;
    let spacingTag = isCompact ? '<w:spacing w:after="20" w:line="220" w:lineRule="auto"/>' : '<w:spacing w:after="30" w:line="230" w:lineRule="auto"/>';
    if (el.type === 'heading1') spacingTag = '<w:spacing w:before="140" w:after="40" w:line="240" w:lineRule="auto"/>';
    else if (el.type === 'heading2') spacingTag = '<w:spacing w:before="100" w:after="30" w:line="230" w:lineRule="auto"/>';
    else if (el.type === 'list') spacingTag = '<w:spacing w:after="15" w:line="220" w:lineRule="auto"/>';

    let pPr = `<w:pPr>${pPrExtra}${spacingTag}<w:jc w:val="${el.align || 'left'}"/></w:pPr>`;
    const defaultFam = el.fontFamily || docFontFamily;

    if (!items || !items.length) {
      let rPr = '<w:rPr>';
      if (defaultFam) rPr += `<w:rFonts w:ascii="${xmlEscape(defaultFam)}" w:hAnsi="${xmlEscape(defaultFam)}"/>`;
      if (el.isBold) rPr += '<w:b/>';
      if (el.isItalic) rPr += '<w:i/>';
      if (el.fontSize) rPr += `<w:sz w:val="${Math.round(el.fontSize * 2)}"/>`;
      rPr += '</w:rPr>';
      return `
      <w:p>
        ${pPr}
        <w:r>
          ${rPr}
          <w:t xml:space="preserve">${xmlEscape(el.text || '')}</w:t>
        </w:r>
      </w:p>`;
    }

    let runsXml = '';
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let rPr = '<w:rPr>';
      const fam = it.fontFamily || el.fontFamily || docFontFamily;
      if (fam) rPr += `<w:rFonts w:ascii="${xmlEscape(fam)}" w:hAnsi="${xmlEscape(fam)}"/>`;
      if (it.isBold || el.isBold) rPr += '<w:b/>';
      if (it.isItalic || el.isItalic) rPr += '<w:i/>';
      const sz = it.effectiveFontSize || it.fontSize || el.fontSize;
      if (sz) rPr += `<w:sz w:val="${Math.round(sz * 2)}"/>`;
      rPr += '</w:rPr>';

      let textContent = it.text;
      if (i < items.length - 1 && !textContent.endsWith(' ')) {
        const next = items[i + 1];
        if (next && next.left > it.right + 1 && !next.text.startsWith(' ')) {
          textContent += ' ';
        }
      }

      runsXml += `
      <w:r>
        ${rPr}
        <w:t xml:space="preserve">${xmlEscape(textContent)}</w:t>
      </w:r>`;
    }

    return `
    <w:p>
      ${pPr}
      ${runsXml}
    </w:p>`;
  }

  function renderDocxTable(tableEl, docFontFamily = 'Calibri') {
    const rows = tableEl.rows || [];
    if (!rows.length) return '';
    const colCount = tableEl.colCount || Math.max(...rows.map(r => r.length));
    const isBorderless = Boolean(tableEl.borderless);
    const totalDxa = tableEl.totalWidthDxa || (isBorderless ? 10800 : 9360);
    const colWidthDxa = Math.floor(totalDxa / Math.max(1, colCount));

    const borderVal = isBorderless ? 'none' : 'single';
    const borderSz = isBorderless ? '0' : '6';
    const borderColor = isBorderless ? 'auto' : '94A3B8';
    const innerColor = isBorderless ? 'auto' : 'E2E8F0';

    let tblPr = `
    <w:tblPr>
      <w:tblW w:w="${totalDxa}" w:type="dxa"/>
      <w:tblBorders>
        <w:top w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
        <w:left w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
        <w:bottom w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
        <w:right w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
        <w:insideH w:val="${borderVal}" w:sz="4" w:space="0" w:color="${innerColor}"/>
        <w:insideV w:val="${borderVal}" w:sz="4" w:space="0" w:color="${innerColor}"/>
      </w:tblBorders>
      <w:jc w:val="center"/>
    </w:tblPr>`;

    let tblGrid = '<w:tblGrid>';
    if (isBorderless && colCount === 2) {
      tblGrid += `<w:gridCol w:w="7600"/><w:gridCol w:w="3200"/>`;
    } else {
      for (let c = 0; c < colCount; c++) {
        tblGrid += `<w:gridCol w:w="${colWidthDxa}"/>`;
      }
    }
    tblGrid += '</w:tblGrid>';

    let rowsXml = '';
    rows.forEach((row, rowIdx) => {
      let cellsXml = '';
      const isHeader = rowIdx === 0 && !isBorderless;

      for (let c = 0; c < colCount; c++) {
        const cellText = row[c] || '';
        const bgShd = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>' : '';
        const thisColWidth = (isBorderless && colCount === 2) ? (c === 0 ? 7600 : 3200) : colWidthDxa;
        const cellAlign = (isBorderless && colCount === 2 && c === 1) ? 'right' : (isHeader ? 'center' : 'left');

        cellsXml += `
        <w:tc>
          <w:tcPr>
            <w:tcW w:w="${thisColWidth}" w:type="dxa"/>
            ${bgShd}
            <w:tcBorders>
              <w:top w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
              <w:left w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
              <w:bottom w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
              <w:right w:val="${borderVal}" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>
            </w:tcBorders>
            <w:tcMar>
              <w:top w:w="${isBorderless ? '20' : '100'}" w:type="dxa"/>
              <w:bottom w:w="${isBorderless ? '20' : '100'}" w:type="dxa"/>
              <w:left w:w="${isBorderless ? '0' : '120'}" w:type="dxa"/>
              <w:right w:w="${isBorderless ? '40' : '120'}" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
          <w:p>
            <w:pPr>
              <w:spacing w:after="20" w:line="220" w:lineRule="auto"/>
              <w:jc w:val="${cellAlign}"/>
            </w:pPr>
            <w:r>
              <w:rPr>
                ${isHeader ? '<w:b/>' : ''}
                <w:rFonts w:ascii="${xmlEscape(docFontFamily)}" w:hAnsi="${xmlEscape(docFontFamily)}"/>
                <w:sz w:val="${isHeader ? '22' : '20'}"/>
              </w:rPr>
              <w:t xml:space="preserve">${xmlEscape(cellText)}</w:t>
            </w:r>
          </w:p>
        </w:tc>`;
      }

      rowsXml += `
      <w:tr>
        <w:trPr>${isHeader ? '<w:tblHeader/>' : ''}</w:trPr>
        ${cellsXml}
      </w:tr>`;
    });

    return `
    <w:tbl>
      ${tblPr}
      ${tblGrid}
      ${rowsXml}
    </w:tbl>
    <w:p><w:pPr><w:spacing w:after="30"/></w:pPr></w:p>`;
  }

  // -------------------------------------------------------------------------
  // Deterministic PDF to Excel (OpenXML XLSX)
  // -------------------------------------------------------------------------
  async function generateXlsxBlob(tablesData) {
    const zip = new JSZip();

    // 1. [Content_Types].xml
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;
    zip.file('[Content_Types].xml', contentTypes);

    // 2. _rels/.rels
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    zip.file('_rels/.rels', rootRels);

    // 3. xl/_rels/workbook.xml.rels
    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;
    zip.file('xl/_rels/workbook.xml.rels', wbRels);

    // 4. xl/workbook.xml
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
    zip.file('xl/workbook.xml', workbook);

    // 5. xl/styles.xml
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><name val="Calibri"/><sz val="11"/></font>
    <font><b/><name val="Calibri"/><sz val="11"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/></border>
  </borders>
  <cellXfs count="2">
    <xf fontId="0" fillId="0" borderId="0"/>
    <xf fontId="1" fillId="0" borderId="0"/>
  </cellXfs>
</styleSheet>`;
    zip.file('xl/styles.xml', styles);

    // Build Sheet Rows & Shared Strings
    const sharedStrings = [];
    const stringMap = new Map();

    function getSharedStringIdx(str) {
      if (stringMap.has(str)) return stringMap.get(str);
      const idx = sharedStrings.length;
      sharedStrings.push(str);
      stringMap.set(str, idx);
      return idx;
    }

    function colLetter(colIdx) {
      let letter = '';
      let temp = colIdx + 1;
      while (temp > 0) {
        let mod = (temp - 1) % 26;
        letter = String.fromCharCode(65 + mod) + letter;
        temp = Math.floor((temp - mod) / 26);
      }
      return letter;
    }

    let rowsXml = '';
    let curRow = 1;

    for (const table of tablesData) {
      const rows = table.rows || [];
      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const rowData = rows[rIdx];
        const isHeader = rIdx === 0;
        let cellsXml = '';

        for (let cIdx = 0; cIdx < rowData.length; cIdx++) {
          const val = rowData[cIdx];
          const cellRef = `${colLetter(cIdx)}${curRow}`;

          // Check if numeric
          const numVal = Number(val);
          if (val !== '' && !isNaN(numVal) && !/^\s*0\d+/.test(val)) {
            cellsXml += `<c r="${cellRef}" s="${isHeader ? 1 : 0}"><v>${numVal}</v></c>`;
          } else {
            const strIdx = getSharedStringIdx(String(val || ''));
            cellsXml += `<c r="${cellRef}" t="s" s="${isHeader ? 1 : 0}"><v>${strIdx}</v></c>`;
          }
        }

        rowsXml += `<row r="${curRow}">${cellsXml}</row>`;
        curRow++;
      }
      curRow++; // empty spacing row between tables
    }

    // 6. xl/worksheets/sheet1.xml
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${rowsXml}
  </sheetData>
</worksheet>`;
    zip.file('xl/worksheets/sheet1.xml', sheetXml);

    // 7. xl/sharedStrings.xml
    let sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`;
    for (const s of sharedStrings) {
      sstXml += `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`;
    }
    sstXml += `</sst>`;
    zip.file('xl/sharedStrings.xml', sstXml);

    const zipType = typeof window === 'undefined' ? 'nodebuffer' : 'blob';
    return await zip.generateAsync({
      type: zipType,
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }

  // -------------------------------------------------------------------------
  // Public High-Level Conversion APIs
  // -------------------------------------------------------------------------
  return {
    xmlEscape,
    cleanText,
    extractPdfPagesData,
    analyzePageLayout,
    generateDocxBlob,
    generateXlsxBlob,

    // One-step PDF to DOCX converter
    convertPdfToDocx: async function (pdfDoc, options = {}) {
      const pagesData = await extractPdfPagesData(pdfDoc, options);
      const mediaFiles = [];
      const structure = [];

      async function extractImageBytesFromObj(imgObj) {
        if (!imgObj) return null;

        // 1. ImageBitmap, HTMLImageElement, HTMLCanvasElement, or bitmap property
        const isBitmap = (typeof ImageBitmap !== 'undefined' && imgObj instanceof ImageBitmap) ||
                         (imgObj.bitmap && typeof ImageBitmap !== 'undefined' && imgObj.bitmap instanceof ImageBitmap);
        const isHtmlImg = (typeof HTMLImageElement !== 'undefined' && imgObj instanceof HTMLImageElement);
        const isCanvas = (typeof HTMLCanvasElement !== 'undefined' && imgObj instanceof HTMLCanvasElement);

        if (isBitmap || isHtmlImg || isCanvas) {
          const src = imgObj.bitmap || imgObj;
          const w = src.width;
          const h = src.height;
          if (w && h) {
            if (typeof OffscreenCanvas !== 'undefined') {
              try {
                const off = new OffscreenCanvas(w, h);
                const ctx = off.getContext('2d');
                ctx.drawImage(src, 0, 0);
                const blob = await off.convertToBlob({ type: 'image/png' });
                const ab = await blob.arrayBuffer();
                return new Uint8Array(ab);
              } catch (e) {}
            }
            if (typeof document !== 'undefined') {
              try {
                const c = document.createElement('canvas');
                c.width = w;
                c.height = h;
                const ctx = c.getContext('2d');
                ctx.drawImage(src, 0, 0);
                const imgData = ctx.getImageData(0, 0, w, h);
                c.width = c.height = 0;
                return encodeRgbaToPng(w, h, imgData.data);
              } catch (e) {}
            }
          }
        }

        // 2. Raw pixel buffer data
        if (imgObj.data) {
          const w = imgObj.width;
          const h = imgObj.height;
          if (!w || !h) return null;
          let rgbaBuf;
          if (imgObj.kind === 3 || imgObj.data.length === w * h * 4) {
            rgbaBuf = new Uint8Array(imgObj.data);
          } else if (imgObj.kind === 2 || imgObj.data.length === w * h * 3) {
            rgbaBuf = new Uint8Array(w * h * 4);
            for (let i = 0, j = 0; i < imgObj.data.length; i += 3, j += 4) {
              rgbaBuf[j] = imgObj.data[i];
              rgbaBuf[j+1] = imgObj.data[i+1];
              rgbaBuf[j+2] = imgObj.data[i+2];
              rgbaBuf[j+3] = 255;
            }
          } else if (imgObj.kind === 1 || imgObj.data.length === w * h) {
            rgbaBuf = new Uint8Array(w * h * 4);
            for (let i = 0, j = 0; i < imgObj.data.length; i++, j += 4) {
              rgbaBuf[j] = imgObj.data[i];
              rgbaBuf[j+1] = imgObj.data[i];
              rgbaBuf[j+2] = imgObj.data[i];
              rgbaBuf[j+3] = 255;
            }
          } else {
            rgbaBuf = new Uint8Array(imgObj.data);
          }
          return encodeRgbaToPng(w, h, rgbaBuf);
        }

        return null;
      }

      async function resolvePdfImageBytes(pageRef, imgRecord) {
        if (!pageRef) return null;
        if (imgRecord.inlineObj) {
          return await extractImageBytesFromObj(imgRecord.inlineObj);
        }
        const imgName = imgRecord.name || imgRecord.imgName;
        if (!imgName) return null;

        const imgObj = await new Promise((resolve) => {
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) { resolved = true; resolve(null); }
          }, 1500);

          const cb = (res) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(res);
            }
          };

          try {
            if (pageRef.objs && pageRef.objs.has && pageRef.objs.has(imgName)) {
              pageRef.objs.get(imgName, cb);
            } else if (pageRef.commonObjs && pageRef.commonObjs.has && pageRef.commonObjs.has(imgName)) {
              pageRef.commonObjs.get(imgName, cb);
            } else if (pageRef.objs && pageRef.objs.get) {
              pageRef.objs.get(imgName, (res) => {
                if (res) cb(res);
                else if (pageRef.commonObjs && pageRef.commonObjs.get) {
                  pageRef.commonObjs.get(imgName, cb);
                } else {
                  cb(null);
                }
              });
            } else if (pageRef.commonObjs && pageRef.commonObjs.get) {
              pageRef.commonObjs.get(imgName, cb);
            } else {
              cb(null);
            }
          } catch (e) {
            cb(null);
          }
        });

        if (imgObj) {
          return await extractImageBytesFromObj(imgObj);
        }
        return null;
      }

      for (let pIdx = 0; pIdx < pagesData.length; pIdx++) {
        const page = pagesData[pIdx];
        const layout = analyzePageLayout(page);

        // Extract and embed images (logos, diagrams, photos)
        for (const el of layout.elements) {
          if (el.type === 'header_with_photo' && el.photo) {
            try {
              const imgBytes = await resolvePdfImageBytes(page.pageRef, el.photo);
              if (imgBytes) {
                const filename = `photo_${pIdx + 1}_${mediaFiles.length + 1}.png`;
                const mediaRelId = `rIdMedia${mediaFiles.length + 1}`;
                mediaFiles.push({ filename, bytes: imgBytes });
                el.photo.mediaRelId = mediaRelId;
              }
            } catch (err) {
              console.warn(`[PDF->DOCX] Failed to extract header photo:`, err);
            }
          } else if (el.type === 'image' && (el.imgName || el.inlineObj)) {
            try {
              const imgBytes = await resolvePdfImageBytes(page.pageRef, el);
              if (imgBytes) {
                const filename = `img_${pIdx + 1}_${mediaFiles.length + 1}.png`;
                const mediaRelId = `rIdMedia${mediaFiles.length + 1}`;
                mediaFiles.push({ filename, bytes: imgBytes });
                el.mediaRelId = mediaRelId;
              }
            } catch (imgErr) {
              console.warn(`[PDF->DOCX] Failed to extract image ${el.imgName}:`, imgErr);
            }
          }
        }

        // If scanned page, render image canvas if renderer provided
        if (page.isScanned && options.renderPageToPng) {
          try {
            const pngBytes = await options.renderPageToPng(page.pageRef, 150);
            if (pngBytes) {
              const filename = `page_${page.pageNum}.png`;
              const mediaRelId = `rIdMedia${mediaFiles.length + 1}`;
              mediaFiles.push({ filename, bytes: pngBytes });
              page.mediaRelId = mediaRelId;
            }
          } catch (e) {
            console.warn(`[PDF->DOCX] Failed to render scanned page ${page.pageNum}:`, e);
          }
        }

        structure.push({
          pageNum: page.pageNum,
          width: page.width,
          height: page.height,
          orientation: page.orientation,
          isScanned: page.isScanned,
          mediaRelId: page.mediaRelId,
          elements: layout.elements
        });
      }

      return await generateDocxBlob(structure, { mediaFiles });
    },

    // One-step PDF to XLSX converter (Deterministic 2D Table Extractor)
    convertPdfToXlsx: async function (pdfDoc, options = {}) {
      const pagesData = await extractPdfPagesData(pdfDoc, options);
      const allTables = [];

      for (const page of pagesData) {
        const layout = analyzePageLayout(page);
        if (layout.tables && layout.tables.length) {
          allTables.push(...layout.tables);
        }
      }

      if (!allTables.length) {
        // Fallback: extract aligned lines across the entire document
        const fallbackRows = [];
        for (const page of pagesData) {
          const layout = analyzePageLayout(page);
          for (const el of layout.elements) {
            if (el.text) {
              fallbackRows.push([el.text]);
            }
          }
        }
        if (fallbackRows.length) {
          allTables.push({ rows: fallbackRows });
        }
      }

      return await generateXlsxBlob(allTables);
    },

    // -------------------------------------------------------------------------
    // High-Fidelity DOCX to PDF Conversion Engine
    // -------------------------------------------------------------------------
    convertDocxToPdf: async function (docxData, options = {}) {
      if (!PDFLib) throw new Error('PDFLib is required for PDF generation.');
      const zip = await JSZip.loadAsync(docxData);
      const docXml = await zip.file('word/document.xml').async('text');

      const pdf = await PDFLib.PDFDocument.create();
      const fontRegular = await safeEmbedFont(pdf, PDFLib.StandardFonts.Helvetica);
      const fontBold = await safeEmbedFont(pdf, PDFLib.StandardFonts.HelveticaBold);

      const margin = 50;
      const pageWidth = 595.28; // A4
      const pageHeight = 841.89;
      const contentWidth = pageWidth - margin * 2;

      let currentPage = pdf.addPage([pageWidth, pageHeight]);
      let cursorY = pageHeight - margin;

      function checkPageBreak(requiredHeight) {
        if (cursorY - requiredHeight < margin) {
          currentPage = pdf.addPage([pageWidth, pageHeight]);
          cursorY = pageHeight - margin;
        }
      }

      // Simple regex parser for OpenXML paragraphs and tables
      const blockRegex = /<(w:p|w:tbl)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let blockMatch;

      while ((blockMatch = blockRegex.exec(docXml)) !== null) {
        const tag = blockMatch[1];
        const content = blockMatch[2];

        if (tag === 'w:p') {
          // Check if heading
          const isHeading = /w:val="Heading[12]"/i.test(content);
          const isBullet = /<w:numPr>/i.test(content) || /•/.test(content);
          const isBold = isHeading || /<w:b\b/i.test(content);

          // Extract text runs
          const textMatches = content.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi) || [];
          const text = textMatches.map(t => t.replace(/<[^>]+>/g, '')).join('').trim();
          if (!text) {
            cursorY -= 8;
            continue;
          }

          const fontSize = isHeading ? 15 : 10;
          const font = isBold ? fontBold : fontRegular;
          const fontColor = isHeading ? PDFLib.rgb(0.08, 0.2, 0.45) : PDFLib.rgb(0.15, 0.18, 0.22);
          const lineHeight = fontSize * 1.35;

          // Word wrap text
          const words = text.split(/\s+/);
          let currentLine = '';
          const lines = [];

          for (const w of words) {
            const candidate = currentLine ? currentLine + ' ' + w : w;
            const wWidth = font.widthOfTextAtSize(candidate, fontSize);
            if (wWidth <= contentWidth - (isBullet ? 20 : 0)) {
              currentLine = candidate;
            } else {
              if (currentLine) lines.push(currentLine);
              currentLine = w;
            }
          }
          if (currentLine) lines.push(currentLine);

          checkPageBreak(lines.length * lineHeight + 12);

          for (let li = 0; li < lines.length; li++) {
            const lineStr = lines[li];
            const x = margin + (isBullet && li === 0 ? 15 : (isBullet ? 25 : 0));
            if (isBullet && li === 0) {
              currentPage.drawText('•', { x: margin + 3, y: cursorY, size: fontSize, font: fontBold, color: fontColor });
            }
            currentPage.drawText(lineStr, {
              x,
              y: cursorY,
              size: fontSize,
              font,
              color: fontColor
            });
            cursorY -= lineHeight;
          }
          cursorY -= isHeading ? 10 : 6;

        } else if (tag === 'w:tbl') {
          // Extract table rows and cells
          const rowMatches = content.match(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi) || [];
          const tableRows = [];

          for (const rXml of rowMatches) {
            const cellMatches = rXml.match(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi) || [];
            const cells = cellMatches.map(cXml => {
              const tMatches = cXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi) || [];
              return tMatches.map(t => t.replace(/<[^>]+>/g, '')).join(' ').trim();
            });
            if (cells.length) tableRows.push(cells);
          }

          if (tableRows.length) {
            const colCount = Math.max(...tableRows.map(r => r.length));
            const colWidth = contentWidth / colCount;
            const rowHeight = 22;

            checkPageBreak(tableRows.length * rowHeight + 20);

            for (let rIdx = 0; rIdx < tableRows.length; rIdx++) {
              checkPageBreak(rowHeight + 10);
              const row = tableRows[rIdx];
              const isHeader = rIdx === 0;

              // Row background
              if (isHeader) {
                currentPage.drawRectangle({
                  x: margin,
                  y: cursorY - rowHeight + 6,
                  width: contentWidth,
                  height: rowHeight,
                  color: PDFLib.rgb(0.95, 0.97, 0.99)
                });
              }

              for (let cIdx = 0; cIdx < colCount; cIdx++) {
                const cellText = row[cIdx] || '';
                const font = isHeader ? fontBold : fontRegular;
                const fontSize = 9;
                const cellX = margin + cIdx * colWidth + 6;

                // Truncate if too long for column
                let displayText = cellText;
                while (displayText.length > 0 && font.widthOfTextAtSize(displayText, fontSize) > colWidth - 12) {
                  displayText = displayText.slice(0, -1);
                }

                currentPage.drawText(displayText, {
                  x: cellX,
                  y: cursorY - 10,
                  size: fontSize,
                  font,
                  color: isHeader ? PDFLib.rgb(0.1, 0.15, 0.3) : PDFLib.rgb(0.2, 0.25, 0.3)
                });
              }

              // Row bottom border
              currentPage.drawLine({
                start: { x: margin, y: cursorY - rowHeight + 6 },
                end: { x: margin + contentWidth, y: cursorY - rowHeight + 6 },
                thickness: isHeader ? 1 : 0.5,
                color: PDFLib.rgb(0.85, 0.88, 0.92)
              });

              cursorY -= rowHeight;
            }
            cursorY -= 12;
          }
        }
      }

      // Add footers with page numbers
      const totalPages = pdf.getPageCount();
      for (let i = 0; i < totalPages; i++) {
        const pg = pdf.getPage(i);
        pg.drawText(`Page ${i + 1} of ${totalPages}  |  Fileora Verified Document`, {
          x: margin,
          y: 25,
          size: 8,
          font: fontRegular,
          color: PDFLib.rgb(0.55, 0.6, 0.65)
        });
      }

      const zipType = typeof window === 'undefined' ? 'nodebuffer' : 'blob';
      const pdfBytes = await pdf.save();
      return zipType === 'nodebuffer' ? Buffer.from(pdfBytes) : new Blob([pdfBytes], { type: 'application/pdf' });
    },

    // -------------------------------------------------------------------------
    // High-Fidelity XLSX to PDF Conversion Engine
    // -------------------------------------------------------------------------
    convertXlsxToPdf: async function (xlsxData, options = {}) {
      if (!PDFLib) throw new Error('PDFLib is required for PDF generation.');
      const zip = await JSZip.loadAsync(xlsxData);

      // Extract shared strings
      const sharedStrings = [];
      const sstFile = zip.file('xl/sharedStrings.xml');
      if (sstFile) {
        const sstXml = await sstFile.async('text');
        const siMatches = sstXml.match(/<si\b[^>]*>([\s\S]*?)<\/si>/gi) || [];
        for (const si of siMatches) {
          const tMatches = si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) || [];
          sharedStrings.push(tMatches.map(t => t.replace(/<[^>]+>/g, '')).join(''));
        }
      }

      // Extract sheet1
      const sheetFile = zip.file('xl/worksheets/sheet1.xml');
      if (!sheetFile) throw new Error('No worksheets found in this workbook.');
      const sheetXml = await sheetFile.async('text');

      const rowMatches = sheetXml.match(/<row\b[^>]*>([\s\S]*?)<\/row>/gi) || [];
      const rows = [];

      for (const rXml of rowMatches) {
        const cellMatches = rXml.match(/<c\b[^>]*>([\s\S]*?)<\/c>/gi) || [];
        const row = [];
        for (const cXml of cellMatches) {
          const isShared = /t="s"/i.test(cXml);
          const vMatch = cXml.match(/<v>([\s\S]*?)<\/v>/i);
          let val = vMatch ? vMatch[1].trim() : '';
          if (isShared && sharedStrings[parseInt(val, 10)] !== undefined) {
            val = sharedStrings[parseInt(val, 10)];
          }
          row.push(val);
        }
        if (row.length) rows.push(row);
      }

      const colCount = Math.max(...rows.map(r => r.length), 1);
      // If table is wide (> 5 columns), automatically use Landscape!
      const isLandscape = colCount > 5;
      const pageWidth = isLandscape ? 841.89 : 595.28;
      const pageHeight = isLandscape ? 595.28 : 841.89;
      const margin = 40;
      const contentWidth = pageWidth - margin * 2;

      const pdf = await PDFLib.PDFDocument.create();
      const fontRegular = await safeEmbedFont(pdf, PDFLib.StandardFonts.Helvetica);
      const fontBold = await safeEmbedFont(pdf, PDFLib.StandardFonts.HelveticaBold);

      let currentPage = pdf.addPage([pageWidth, pageHeight]);
      let cursorY = pageHeight - margin;

      // Title
      currentPage.drawText('Spreadsheet Report  |  Sheet 1', {
        x: margin,
        y: cursorY,
        size: 14,
        font: fontBold,
        color: PDFLib.rgb(0.08, 0.2, 0.45)
      });
      cursorY -= 25;

      const colWidth = contentWidth / colCount;
      const rowHeight = 20;

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        if (cursorY - rowHeight < margin + 25) {
          currentPage = pdf.addPage([pageWidth, pageHeight]);
          cursorY = pageHeight - margin;
        }

        const row = rows[rIdx];
        const isHeader = rIdx === 0;

        if (isHeader) {
          currentPage.drawRectangle({
            x: margin,
            y: cursorY - rowHeight + 5,
            width: contentWidth,
            height: rowHeight,
            color: PDFLib.rgb(0.93, 0.96, 0.99)
          });
        }

        for (let cIdx = 0; cIdx < colCount; cIdx++) {
          const val = row[cIdx] || '';
          const font = isHeader ? fontBold : fontRegular;
          const fontSize = 8.5;
          let text = String(val);

          while (text.length > 0 && font.widthOfTextAtSize(text, fontSize) > colWidth - 8) {
            text = text.slice(0, -1);
          }

          currentPage.drawText(text, {
            x: margin + cIdx * colWidth + 4,
            y: cursorY - 10,
            size: fontSize,
            font,
            color: isHeader ? PDFLib.rgb(0.08, 0.15, 0.3) : PDFLib.rgb(0.2, 0.25, 0.3)
          });
        }

        currentPage.drawLine({
          start: { x: margin, y: cursorY - rowHeight + 5 },
          end: { x: margin + contentWidth, y: cursorY - rowHeight + 5 },
          thickness: isHeader ? 1 : 0.5,
          color: PDFLib.rgb(0.85, 0.88, 0.92)
        });

        cursorY -= rowHeight;
      }

      // Add footers
      const totalPages = pdf.getPageCount();
      for (let i = 0; i < totalPages; i++) {
        const pg = pdf.getPage(i);
        pg.drawText(`Page ${i + 1} of ${totalPages}  |  Fileora Verified Document`, {
          x: margin,
          y: 20,
          size: 8,
          font: fontRegular,
          color: PDFLib.rgb(0.55, 0.6, 0.65)
        });
      }

      const zipType = typeof window === 'undefined' ? 'nodebuffer' : 'blob';
      const pdfBytes = await pdf.save();
      return zipType === 'nodebuffer' ? Buffer.from(pdfBytes) : new Blob([pdfBytes], { type: 'application/pdf' });
    },

    // -------------------------------------------------------------------------
    // High-Fidelity PPTX to PDF Conversion Engine
    // -------------------------------------------------------------------------
    convertPptxToPdf: async function (pptxData, options = {}) {
      if (!PDFLib) throw new Error('PDFLib is required for PDF generation.');
      const zip = await JSZip.loadAsync(pptxData);

      const slideFiles = Object.keys(zip.files)
        .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
        .sort((a, b) => {
          const numA = parseInt(a.match(/\d+/)[0], 10);
          const numB = parseInt(b.match(/\d+/)[0], 10);
          return numA - numB;
        });

      if (!slideFiles.length) throw new Error('No presentation slides found in this file.');

      // Extract original slide dimensions from ppt/presentation.xml (EMU to points: 1 pt = 12700 EMU)
      let slideWidth = 720;
      let slideHeight = 540;
      const presXmlFile = zip.file('ppt/presentation.xml');
      if (presXmlFile) {
        try {
          const presXml = await presXmlFile.async('text');
          const sldSzMatch = presXml.match(/<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/i) ||
                             presXml.match(/<p:sldSz\b[^>]*cy="(\d+)"[^>]*cx="(\d+)"/i);
          if (sldSzMatch) {
            const cx = parseInt(sldSzMatch[1], 10);
            const cy = parseInt(sldSzMatch[2], 10);
            if (cx > 0 && cy > 0) {
              slideWidth = Math.round(cx / 12700);
              slideHeight = Math.round(cy / 12700);
            }
          }
        } catch (e) {}
      }

      const pdf = await PDFLib.PDFDocument.create();
      const fontRegular = await safeEmbedFont(pdf, PDFLib.StandardFonts.Helvetica);
      const fontBold = await safeEmbedFont(pdf, PDFLib.StandardFonts.HelveticaBold);
      const margin = Math.round(slideWidth * 0.06);

      for (let sIdx = 0; sIdx < slideFiles.length; sIdx++) {
        const slidePath = slideFiles[sIdx];
        const slideXml = await zip.file(slidePath).async('text');
        const page = pdf.addPage([slideWidth, slideHeight]);

        // Parse slide relationships to locate embedded images
        const slideNum = slidePath.match(/\d+/)[0];
        const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
        const relsFile = zip.file(relsPath);
        const relsMap = {};
        if (relsFile) {
          try {
            const relsXml = await relsFile.async('text');
            const relMatches = relsXml.match(/<Relationship\b[^>]*\/>/gi) || [];
            for (const rm of relMatches) {
              const idM = rm.match(/Id="([^"]+)"/i);
              const targetM = rm.match(/Target="([^"]+)"/i);
              if (idM && targetM) {
                let target = targetM[1];
                if (target.startsWith('../')) target = 'ppt/' + target.slice(3);
                else if (!target.startsWith('ppt/')) target = 'ppt/slides/' + target;
                relsMap[idM[1]] = target;
              }
            }
          } catch (e) {}
        }

        // Embed slide images at exact coordinates
        const picMatches = slideXml.match(/<p:pic\b[\s\S]*?<\/p:pic>/gi) || [];
        for (const picXml of picMatches) {
          try {
            const blipMatch = picXml.match(/<a:blip\b[^>]*r:embed="([^"]+)"/i);
            if (!blipMatch) continue;
            const rId = blipMatch[1];
            const imgPath = relsMap[rId];
            if (!imgPath || !zip.file(imgPath)) continue;

            const offMatch = picXml.match(/<a:off\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/i);
            const extMatch = picXml.match(/<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/i);
            if (!offMatch || !extMatch) continue;

            const x = Math.round(parseInt(offMatch[1], 10) / 12700);
            const y = Math.round(parseInt(offMatch[2], 10) / 12700);
            const w = Math.round(parseInt(extMatch[1], 10) / 12700);
            const h = Math.round(parseInt(extMatch[2], 10) / 12700);

            const imgBytes = await zip.file(imgPath).async('uint8array');
            let embeddedImg = null;
            if (/\.jpe?g$/i.test(imgPath)) {
              embeddedImg = await pdf.embedJpg(imgBytes).catch(() => null);
            } else if (/\.png$/i.test(imgPath)) {
              embeddedImg = await pdf.embedPng(imgBytes).catch(() => null);
            }

            if (embeddedImg && w > 0 && h > 0) {
              page.drawImage(embeddedImg, {
                x: Math.max(0, x),
                y: Math.max(0, slideHeight - y - h),
                width: Math.min(slideWidth, w),
                height: Math.min(slideHeight, h)
              });
            }
          } catch (imgErr) {}
        }

        // Extract text frames <a:p>
        const paraMatches = slideXml.match(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi) || [];
        let cursorY = slideHeight - margin - 20;

        for (let pIdx = 0; pIdx < paraMatches.length; pIdx++) {
          const pXml = paraMatches[pIdx];
          const tMatches = pXml.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi) || [];
          const text = tMatches.map(t => t.replace(/<[^>]+>/g, '')).join(' ').trim();
          if (!text) continue;

          const isTitle = pIdx === 0 || text.length < 50 && pIdx < 2;
          const fontSize = isTitle ? 18 : 12;
          const font = isTitle ? fontBold : fontRegular;
          const color = isTitle ? PDFLib.rgb(0.08, 0.2, 0.45) : PDFLib.rgb(0.2, 0.25, 0.3);

          page.drawText(text, {
            x: margin + (isTitle ? 0 : 20),
            y: cursorY,
            size: fontSize,
            font,
            color,
            maxWidth: slideWidth - margin * 2 - 40
          });

          cursorY -= isTitle ? 32 : 22;
          if (cursorY < margin + 30) break;
        }
      }

      const zipType = typeof window === 'undefined' ? 'nodebuffer' : 'blob';
      const pdfBytes = await pdf.save();
      return zipType === 'nodebuffer' ? Buffer.from(pdfBytes) : new Blob([pdfBytes], { type: 'application/pdf' });
    },

    // -------------------------------------------------------------------------
    // Word to PowerPoint (DOCX to PPTX) Conversion Engine
    // -------------------------------------------------------------------------
    convertDocxToPptx: async function (docxData, options = {}) {
      const PptxGen = (typeof window !== 'undefined' && window.PptxGenJS)
        ? window.PptxGenJS
        : (typeof PptxGenJS !== 'undefined')
          ? PptxGenJS
          : require('pptxgenjs');
      if (!PptxGen) throw new Error('PptxGenJS is required for PowerPoint generation.');

      const zip = await JSZip.loadAsync(docxData);
      const docXmlEntry = zip.file('word/document.xml');
      if (!docXmlEntry) throw new Error('Invalid DOCX file: word/document.xml not found.');
      const docXml = await docXmlEntry.async('string');

      // Extract images if any
      const mediaMap = {};
      const relsEntry = zip.file('word/_rels/document.xml.rels');
      if (relsEntry) {
        const relsXml = await relsEntry.async('string');
        const relMatches = relsXml.match(/<Relationship\b[^>]*>/gi) || [];
        for (const rm of relMatches) {
          const id = (rm.match(/Id="([^"]+)"/) || [])[1];
          const target = (rm.match(/Target="([^"]+)"/) || [])[1];
          if (id && target && target.startsWith('media/')) {
            const imgFile = zip.file(`word/${target}`);
            if (imgFile) {
              const b64 = await imgFile.async('base64');
              const ext = target.split('.').pop().toLowerCase();
              const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
              mediaMap[id] = `data:${mime};base64,${b64}`;
            }
          }
        }
      }

      // Detect document page dimensions and orientation from docXml
      const pgSzMatch = docXml.match(/<w:pgSz\b[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/i) ||
                        docXml.match(/<w:pgSz\b[^>]*w:h="(\d+)"[^>]*w:w="(\d+)"/i);
      let isPortrait = false;
      let slideW = 13.333;
      let slideH = 7.5;
      if (pgSzMatch) {
        const wTwips = parseInt(pgSzMatch[1], 10);
        const hTwips = parseInt(pgSzMatch[2], 10);
        if (hTwips > wTwips) {
          isPortrait = true;
          slideW = +(wTwips / 1440).toFixed(2);
          slideH = +(hTwips / 1440).toFixed(2);
        } else {
          slideW = +(wTwips / 1440).toFixed(2);
          slideH = +(hTwips / 1440).toFixed(2);
        }
      }

      // Check if document contains explicit page breaks
      const hasPageBreaks = /<w:br\b[^>]*w:type="page"/i.test(docXml) || /<w:lastRenderedPageBreak\b/i.test(docXml);

      // Parse document elements (<w:p> and <w:tbl>)
      const elemMatches = docXml.match(/<(?:w:p|w:tbl)\b[\s\S]*?<\/(?:w:p|w:tbl)>/gi) || [];
      const slidesData = [];
      let currentSlide = { title: '', subtitle: '', items: [], tables: [], images: [] };

      function finishSlide() {
        if (currentSlide.title || currentSlide.items.length || currentSlide.tables.length || currentSlide.images.length) {
          if (!currentSlide.title && currentSlide.items.length) {
            // Pick first non-bullet item as title if available
            const nonBulletIdx = currentSlide.items.findIndex(it => !it.isBullet);
            if (nonBulletIdx >= 0) {
              currentSlide.title = currentSlide.items.splice(nonBulletIdx, 1)[0].text;
            } else {
              currentSlide.title = currentSlide.items.shift().text;
            }
          }
          slidesData.push(currentSlide);
          currentSlide = { title: '', subtitle: '', items: [], tables: [], images: [] };
        }
      }

      for (const elemXml of elemMatches) {
        if (elemXml.startsWith('<w:tbl')) {
          const trMatches = elemXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/gi) || [];
          const tableRows = [];
          for (const trXml of trMatches) {
            const tcMatches = trXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/gi) || [];
            const cells = tcMatches.map(tcXml => {
              const tMatches = tcXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi) || [];
              return tMatches.map(t => t.replace(/<[^>]+>/g, '')).join(' ').trim();
            });
            if (cells.length) tableRows.push(cells);
          }
          if (tableRows.length) {
            if (!hasPageBreaks && currentSlide.items.length >= 3) finishSlide();
            currentSlide.tables.push(tableRows);
          }
        } else {
          // Page breaks: explicit page break, rendered page break, or section break
          const isPageBreak = /<w:br\b[^>]*w:type="page"/i.test(elemXml) ||
                              /<w:lastRenderedPageBreak\b/i.test(elemXml) ||
                              /<w:sectPr\b/i.test(elemXml);

          const tMatches = elemXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi) || [];
          const text = tMatches.map(t => t.replace(/<[^>]+>/g, '')).join(' ').trim();

          // Image blip extraction
          const blipMatch = elemXml.match(/<(?:a:blip|v:imagedata)\b[^>]*(?:r:embed|r:id)="([^"]+)"/i);
          if (blipMatch && mediaMap[blipMatch[1]]) {
            currentSlide.images.push(mediaMap[blipMatch[1]]);
          }

          if (isPageBreak && (currentSlide.title || currentSlide.items.length || currentSlide.images.length)) {
            finishSlide();
          }

          // FIXED: Removed "if (!text) continue;" to preserve ALL content elements
          // This was silently skipping content without transferring to PPTX
          // Now: Process all elements, only skip adding to slides if truly empty AND not images

          // Heading and Numbering detection
          const isExplicitHeading = /<w:pStyle\b[^>]*w:val="(?:Heading[1-4]|Title|Subtitle)"/i.test(elemXml);
          const isNumberedHeading = /^\s*(?:\d+[\.\)]|[A-Z][\.\)]|[IVXLCDM]+[\.\)])\s+[A-Za-z]/.test(text) && text.length < 80;
          const szMatch = elemXml.match(/<w:sz\b[^>]*w:val="(\d+)"/i);
          const fontSizePt = szMatch ? parseInt(szMatch[1], 10) / 2 : 11;
          const isLargeText = fontSizePt >= 16 && text.length < 80;
          const isBold = /<w:b\b/i.test(elemXml);

          const isCoverTitle = (slidesData.length === 0 && !currentSlide.title && (isLargeText || (isBold && text.length < 60)));
          const isHeading = isExplicitHeading || isNumberedHeading || isCoverTitle;

          // List item detection
          const hasNumPr = /<w:numPr\b/i.test(elemXml) || /<w:ilvl\b/i.test(elemXml);
          const startsWithBullet = /^([•\u2022\u25CF\u25AA\-*]|\d+[.)])\s/.test(text);
          const isBullet = hasNumPr || startsWithBullet;

          if (!hasPageBreaks && isHeading) {
            if (currentSlide.title && (currentSlide.items.length || currentSlide.tables.length || currentSlide.images.length)) {
              finishSlide();
            }
            if (!currentSlide.title) {
              currentSlide.title = text;
            } else {
              currentSlide.items.push({ text, isBullet: false });
            }
          } else if (slidesData.length === 0 && currentSlide.title && !currentSlide.subtitle && text.length < 60) {
            currentSlide.subtitle = text;
          } else {
            if (!currentSlide.title && (isHeading || !slidesData.length)) {
              currentSlide.title = text;
            } else {
              if (!hasPageBreaks && currentSlide.items.length >= 8) {
                const prevTitle = currentSlide.title;
                finishSlide();
                currentSlide.title = prevTitle ? `${prevTitle} (Cont.)` : '';
              }
              currentSlide.items.push({ text, isBullet });
            }
          }
        }
      }
      finishSlide();

      if (!slidesData.length) {
        slidesData.push({ title: 'Document Summary', items: [{ text: 'Document converted with Fileora' }], tables: [], images: [] });
      }

      const pres = new PptxGen();
      pres.defineLayout({ name: 'DOCPAGE', width: slideW, height: slideH });
      pres.layout = 'DOCPAGE';

      const marginX = isPortrait ? 0.6 : 0.8;
      const contentW = +(slideW - marginX * 2).toFixed(2);

      slidesData.forEach((sData, sIdx) => {
        const slide = pres.addSlide();
        slide.background = { color: 'FFFFFF' };

        // 1. Cover Slide (Slide 1)
        if (sIdx === 0 && (!sData.items.length || sData.items.every(it => !it.isBullet))) {
          const coverTitle = sData.title || 'Document Presentation';
          const sub = sData.subtitle || sData.items.map(it => it.text).join('\n');

          if (isPortrait) {
            slide.addText(coverTitle, {
              x: marginX,
              y: 2.0,
              w: contentW,
              h: 1.8,
              fontSize: 26,
              bold: true,
              color: '0F172A',
              align: 'center',
              fontFace: 'Arial'
            });
            if (sub) {
              slide.addText(sub, {
                x: marginX,
                y: 4.0,
                w: contentW,
                h: 2.0,
                fontSize: 15,
                color: '475569',
                align: 'center',
                fontFace: 'Arial'
              });
            }
            if (sData.images && sData.images.length) {
              const imgW = Math.min(contentW, 4.5);
              slide.addImage({
                data: sData.images[0],
                x: +(marginX + (contentW - imgW) / 2).toFixed(2),
                y: 6.2,
                w: imgW,
                h: 3.5,
                sizing: { type: 'contain', w: imgW, h: 3.5 }
              });
            }
          } else {
            if (sData.images && sData.images.length) {
              slide.addText(coverTitle, {
                x: marginX,
                y: 1.8,
                w: 5.8,
                h: 1.8,
                fontSize: 32,
                bold: true,
                color: '0F172A',
                fontFace: 'Arial'
              });
              if (sub) {
                slide.addText(sub, {
                  x: marginX,
                  y: 3.8,
                  w: 5.8,
                  h: 1.5,
                  fontSize: 18,
                  color: '475569',
                  fontFace: 'Arial'
                });
              }
              if (sData.images.length === 1) {
                slide.addImage({ data: sData.images[0], x: 7.0, y: 1.4, w: 5.5, h: 4.8, sizing: { type: 'contain', w: 5.5, h: 4.8 } });
              } else {
                slide.addImage({ data: sData.images[0], x: 6.8, y: 1.4, w: 2.8, h: 4.5, sizing: { type: 'contain', w: 2.8, h: 4.5 } });
                slide.addImage({ data: sData.images[1], x: 9.8, y: 1.4, w: 2.8, h: 4.5, sizing: { type: 'contain', w: 2.8, h: 4.5 } });
              }
            } else {
              slide.addText(coverTitle, {
                x: marginX,
                y: 2.0,
                w: contentW,
                h: 1.8,
                fontSize: 34,
                bold: true,
                color: '0F172A',
                align: 'center',
                fontFace: 'Arial'
              });
              if (sub) {
                slide.addText(sub, {
                  x: marginX,
                  y: 4.0,
                  w: contentW,
                  h: 1.5,
                  fontSize: 18,
                  color: '475569',
                  align: 'center',
                  fontFace: 'Arial'
                });
              }
            }
          }
          return;
        }

        // 2. Content Slides
        slide.addShape(pres.ShapeType.rect, {
          x: 0,
          y: 0,
          w: slideW,
          h: 0.9,
          fill: { color: 'F8FAFC' },
          line: { color: 'E2E8F0', width: 1 }
        });

        slide.addText(sData.title || 'Section Overview', {
          x: marginX,
          y: 0.15,
          w: contentW,
          h: 0.6,
          fontSize: isPortrait ? 18 : 22,
          bold: true,
          color: '0F172A',
          fontFace: 'Arial'
        });

        let cursorY = 1.2;

        if (sData.tables && sData.tables.length) {
          for (const tableRows of sData.tables) {
            const formattedRows = tableRows.map((r, rIdx) => {
              return r.map(cell => ({
                text: cell,
                options: {
                  bold: rIdx === 0,
                  fill: rIdx === 0 ? { color: 'F1F5F9' } : { color: 'FFFFFF' },
                  color: rIdx === 0 ? '0F172A' : '334155',
                  fontSize: 11,
                  fontFace: 'Arial'
                }
              }));
            });
            slide.addTable(formattedRows, {
              x: marginX,
              y: cursorY,
              w: (sData.images.length && !isPortrait) ? 6.0 : contentW,
              border: { pt: 1, color: 'CBD5E1' }
            });
            cursorY += Math.min(3.5, tableRows.length * 0.35 + 0.4);
          }
        }

        if (sData.items && sData.items.length) {
          const textObjects = sData.items.map(it => {
            const cleanText = it.text.replace(/^([•\u2022\u25CF\u25AA\-*]|\d+[.)])\s*/, '').trim();
            return {
              text: cleanText,
              options: {
                bullet: Boolean(it.isBullet),
                fontSize: it.isBullet ? 14 : 15,
                color: '334155',
                fontFace: 'Arial',
                breakLine: true,
                paraSpaceAfter: it.isBullet ? 6 : 10
              }
            };
          });

          const textWidth = (sData.images.length && !isPortrait) ? 5.8 : contentW;
          slide.addText(textObjects, {
            x: marginX,
            y: cursorY,
            w: textWidth,
            h: Math.max(1.8, (slideH - 0.8) - cursorY),
            valign: 'top'
          });
        }

        if (sData.images && sData.images.length) {
          if (isPortrait) {
            const imgW = Math.min(contentW, 5.5);
            slide.addImage({
              data: sData.images[0],
              x: +(marginX + (contentW - imgW) / 2).toFixed(2),
              y: Math.min(cursorY + 2.5, slideH - 4.5),
              w: imgW,
              h: 3.5,
              sizing: { type: 'contain', w: imgW, h: 3.5 }
            });
          } else {
            if (sData.images.length === 1) {
              slide.addImage({
                data: sData.images[0],
                x: 7.2,
                y: 1.4,
                w: 5.3,
                h: 5.0,
                sizing: { type: 'contain', w: 5.3, h: 5.0 }
              });
            } else {
              slide.addImage({
                data: sData.images[0],
                x: 7.0,
                y: 1.4,
                w: 2.7,
                h: 4.8,
                sizing: { type: 'contain', w: 2.7, h: 4.8 }
              });
              slide.addImage({
                data: sData.images[1],
                x: 9.9,
                y: 1.4,
                w: 2.7,
                h: 4.8,
                sizing: { type: 'contain', w: 2.7, h: 4.8 }
              });
            }
          }
        }

        slide.addText(`Slide ${sIdx + 1} of ${slidesData.length}`, {
          x: marginX,
          y: slideH - 0.4,
          w: contentW,
          h: 0.3,
          fontSize: 9,
          color: '94A3B8',
          fontFace: 'Arial'
        });
      });

      const zipType = typeof window === 'undefined' ? 'nodebuffer' : 'blob';
      return await pres.write({ outputType: zipType });
    },

    // -------------------------------------------------------------------------
    // PowerPoint to Word (PPTX to DOCX) Conversion Engine
    // -------------------------------------------------------------------------
    convertPptxToDocx: async function (pptxData, options = {}) {
      const zip = await JSZip.loadAsync(pptxData);
      const slideFiles = Object.keys(zip.files)
        .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
        .sort((a, b) => {
          const numA = parseInt(a.match(/\d+/)[0], 10);
          const numB = parseInt(b.match(/\d+/)[0], 10);
          return numA - numB;
        });

      if (!slideFiles.length) throw new Error('No presentation slides found in this file.');

      // Parse actual slide dimensions from ppt/presentation.xml
      let slideSizeW = 9144000;  // Default: 10 inches in EMUs
      let slideSizeH = 6858000;  // Default: 7.5 inches in EMUs
      const presEntry = zip.file('ppt/presentation.xml');
      if (presEntry) {
        try {
          const presXml = await presEntry.async('string');
          const sldSzMatch = presXml.match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/i);
          if (sldSzMatch) {
            slideSizeW = parseInt(sldSzMatch[1], 10);
            slideSizeH = parseInt(sldSzMatch[2], 10);
          }
        } catch (e) {
          // Use defaults if parsing fails
        }
      }
      // Convert EMUs to points: 1 EMU = 1/914400 inch, 1 inch = 72 points
      let slideWidthPts = Math.round((slideSizeW / 914400) * 72);
      let slideHeightPts = Math.round((slideSizeH / 914400) * 72);
      const maxDim = 1548;
      if (Math.max(slideWidthPts, slideHeightPts) > maxDim) {
        const scale = maxDim / Math.max(slideWidthPts, slideHeightPts);
        slideWidthPts = Math.round(slideWidthPts * scale);
        slideHeightPts = Math.round(slideHeightPts * scale);
      }
      const isPortrait = slideHeightPts > slideWidthPts;

      const structure = [];
      const mediaFiles = [];

      for (let sIdx = 0; sIdx < slideFiles.length; sIdx++) {
        const slidePath = slideFiles[sIdx];
        const slideXml = await zip.file(slidePath).async('string');
        const elements = [];

        // Check slide relationships for images
        const relsPath = `ppt/slides/_rels/${slidePath.split('/').pop()}.rels`;
        const relsEntry = zip.file(relsPath);
        const relMap = {};
        if (relsEntry) {
          const relsXml = await relsEntry.async('string');
          const relMatches = relsXml.match(/<Relationship\b[^>]*>/gi) || [];
          for (const rm of relMatches) {
            const id = (rm.match(/Id="([^"]+)"/) || [])[1];
            const target = (rm.match(/Target="([^"]+)"/) || [])[1];
            if (id && target) {
              let cleanTarget = target.replace(/^\.\.\//, '');
              if (!cleanTarget.startsWith('ppt/')) cleanTarget = 'ppt/' + cleanTarget;
              relMap[id] = cleanTarget;
            }
          }
        }

        // 1. Extract ALL Images across the slide (both <p:pic> and any shape <a:blipFill>)
        const blipMatches = slideXml.match(/<a:blip\b[^>]*r:embed="([^"]+)"/gi) || [];
        const seenBlips = new Set();
        for (const blipTag of blipMatches) {
          const embedId = (blipTag.match(/r:embed="([^"]+)"/) || [])[1];
          if (embedId && relMap[embedId] && !seenBlips.has(embedId)) {
            seenBlips.add(embedId);
            const mediaPath = relMap[embedId];
            const mediaFile = zip.file(mediaPath) || zip.file(mediaPath.replace(/^ppt\//, ''));
            if (mediaFile) {
              const bytes = await mediaFile.async('uint8array');
              // Detect actual image format from media path extension
              const ext = mediaPath.split('.').pop().toLowerCase();
              const supportedExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg'];
              const actualExt = supportedExts.includes(ext) ? ext : 'png';
              const filename = `img_slide_${sIdx + 1}_${mediaFiles.length + 1}.${actualExt}`;
              const mediaRelId = `rIdMedia${mediaFiles.length + 1}`;
              mediaFiles.push({ filename, bytes });
              elements.push({
                type: 'image',
                mediaRelId,
                width: 500,
                height: 300,
                top: 200
              });
            }
          }
        }

        // 2. Extract Tables <a:tbl>
        const tblMatches = slideXml.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/gi) || [];
        for (const tblXml of tblMatches) {
          const trMatches = tblXml.match(/<a:tr\b[\s\S]*?<\/a:tr>/gi) || [];
          const tableRows = [];
          for (const trXml of trMatches) {
            const tcMatches = trXml.match(/<a:tc\b[\s\S]*?<\/a:tc>/gi) || [];
            const cells = tcMatches.map(tcXml => {
              const tMatches = tcXml.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi) || [];
              return tMatches.map(t => t.replace(/<[^>]+>/g, '')).join('').trim();
            });
            if (cells.length) tableRows.push(cells);
          }
          if (tableRows.length) {
            elements.push({
              type: 'table',
              rows: tableRows,
              colCount: Math.max(...tableRows.map(r => r.length)),
              borderless: true,
              top: 150
            });
          }
        }

        // 3. Extract Text Shapes <p:sp>
        const shapeMatches = slideXml.match(/<p:sp\b[\s\S]*?<\/p:sp>/gi) || [];
        let hasHeading = false;
        for (let spIdx = 0; spIdx < shapeMatches.length; spIdx++) {
          const spXml = shapeMatches[spIdx];
          const isExplicitTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/i.test(spXml);

          const pMatches = spXml.match(/<a:p\b[\s\S]*?<\/a:p>/gi) || [];
          for (const pXml of pMatches) {
            const tMatches = pXml.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi) || [];
            const text = tMatches.map(t => t.replace(/<[^>]+>/g, '')).join('').trim();
            if (!text) continue;

            const isSlideNumber = /^Slide \d+(\s+of\s+\d+)?$/i.test(text);
            const isBold = /<a:rPr\b[^>]*b="1"/i.test(pXml);
            const isItalic = /<a:rPr\b[^>]*i="1"/i.test(pXml);
            const fontMatch = pXml.match(/<a:(?:latin|ea|cs)\b[^>]*typeface="([^"]+)"/i);
            let rawFont = fontMatch ? fontMatch[1] : 'Calibri';
            if (rawFont.startsWith('+')) rawFont = 'Calibri';
            const fontFamily = normalizeFontFamily(rawFont);
            const isBullet = /<a:pPr\b[^>]*lvl="[1-9]"/i.test(pXml) || /<a:buChar\b/i.test(pXml) || /^([•\u2022\u25CF\u25AA\-*]|\d+[.)])\s/.test(text);

            let role = 'paragraph';
            const canBeTitle = !hasHeading && !isSlideNumber && text.length < 100 && (isExplicitTitle || isBold || text.length < 50);
            if (canBeTitle) {
              role = 'heading1';
              hasHeading = true;
            } else if (isSlideNumber) {
              role = 'footer';
            } else if (isBullet) {
              role = 'list';
            }

            elements.push({
              type: role === 'footer' ? 'paragraph' : role,
              text,
              fontSize: role === 'heading1' ? 20 : (role === 'footer' ? 9 : (isBold ? 14 : 12)),
              isBold: isBold || role === 'heading1',
              isItalic,
              fontFamily,
              align: role === 'heading1' ? (sIdx === 0 ? 'center' : 'left') : (role === 'footer' ? 'right' : 'left'),
              top: role === 'heading1' ? 0 : 100
            });
          }
        }

        if (!hasHeading) {
          elements.unshift({
            type: 'heading1',
            text: `Slide ${sIdx + 1}`,
            fontSize: 18,
            isBold: true,
            fontFamily: 'Calibri',
            align: 'left',
            top: 0
          });
        }

        structure.push({
          pageNum: sIdx + 1,
          width: slideWidthPts,
          height: slideHeightPts,
          orientation: isPortrait ? 'portrait' : 'landscape',
          isScanned: false,
          elements
        });
      }

      return await generateDocxBlob(structure, { mediaFiles });
    }
  };
});
