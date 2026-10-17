/**
 * Complexity guard for uploads. File size says little about the cost of a conversion: 250 KB of table-heavy Word is 175 pages and
 * 13 s of LibreOffice, 250 KB of table-and-shape slides is 159 slides and 22 s plus over 1 GB of memory, 1 MB of spreadsheet rows
 * is 15 000 rows and 11 s. On a 512 MB server such files do not finish, or finish only after the machine starts swapping and
 * killing processes. They are refused up front, with the reason, before any conversion work starts.
 *
 * The limits come from tests/bench5s/RESULTS.md (pages/slides/rows versus time and memory) and can be changed with environment
 * variables; they are deliberately a little below the point where the measurements left the safe range.
 * (PDF page limits are enforced inside tools_converter.py, where the PDF is opened anyway.)
 */
const int = (name, dflt) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const LIMITS = {
  DOCX_MAX_TABLES: int('MAX_DOCX_TABLES', 100),
  DOCX_MAX_XML_BYTES: int('MAX_DOCX_XML_BYTES', 1200 * 1000),
  PPTX_MAX_SLIDES: int('MAX_PPTX_SLIDES', 50),
  PPTX_MAX_XML_BYTES: int('MAX_PPTX_XML_BYTES', 1500 * 1000),
  XLSX_MAX_SHEETS: int('MAX_XLSX_SHEETS', 40),
  XLSX_MAX_ROWS: int('MAX_XLSX_ROWS', 3000),
  XLSX_MAX_CELLS: int('MAX_XLSX_CELLS', 25000),
  XLSX_MAX_XML_BYTES: int('MAX_XLSX_XML_BYTES', 12 * 1000 * 1000),
  CSV_MAX_ROWS: int('MAX_CSV_ROWS', 2500),
  CSV_MAX_CELLS: int('MAX_CSV_CELLS', 25000),
  PDF_MAX_PAGES: int('MAX_PDF_PAGES', 40),
  PDF_MAX_IMAGES: int('MAX_PDF_IMAGES', 12)
};

const tooComplex = (what, detail) => ({
  error: 'TOO_COMPLEX',
  message: `This ${what} is too large or complex for the free server (${detail}). Please split it into smaller parts and convert them one at a time.`
});

// Size of a zip entry once unpacked, taken from the archive directory so nothing is decompressed to find out (zip bombs)
const usize = (zip, name) => { const f = zip.file(name); return f && f._data && Number.isFinite(f._data.uncompressedSize) ? f._data.uncompressedSize : 0; };
const count = (s, re) => { let n = 0; re.lastIndex = 0; while (re.exec(s)) n++; return n; };

/** Returns null when the document is fine, otherwise { error, message } to send with HTTP 422. `zip` is a loaded JSZip. */
async function assessZip(zip) {
  const names = Object.keys(zip.files);
  if (zip.file('word/document.xml')) {
    const size = usize(zip, 'word/document.xml');
    if (size > LIMITS.DOCX_MAX_XML_BYTES) return tooComplex('Word document', `about ${Math.round(size / 1e6)} MB of text and formatting, the limit is ${LIMITS.DOCX_MAX_XML_BYTES / 1e6} MB`);
    const xml = await zip.file('word/document.xml').async('string');
    const tables = count(xml, /<w:tbl>/g);
    if (tables > LIMITS.DOCX_MAX_TABLES) return tooComplex('Word document', `${tables} tables, the limit is ${LIMITS.DOCX_MAX_TABLES}`);
    return null;
  }
  if (zip.file('ppt/presentation.xml')) {
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    if (slides.length > LIMITS.PPTX_MAX_SLIDES) return tooComplex('presentation', `${slides.length} slides, the limit is ${LIMITS.PPTX_MAX_SLIDES}`);
    let bytes = 0;
    for (const n of slides) bytes += usize(zip, n);
    if (bytes > LIMITS.PPTX_MAX_XML_BYTES) return tooComplex('presentation', `slide content of about ${Math.round(bytes / 1e6)} MB, the limit is ${LIMITS.PPTX_MAX_XML_BYTES / 1e6} MB`);
    return null;
  }
  if (zip.file('xl/workbook.xml')) {
    const wb = await zip.file('xl/workbook.xml').async('string');
    const sheets = count(wb, /<sheet\b/g);
    if (sheets > LIMITS.XLSX_MAX_SHEETS) return tooComplex('spreadsheet', `${sheets} worksheets, the limit is ${LIMITS.XLSX_MAX_SHEETS}`);
    let rows = 0;
    let cells = 0;
    const sheetParts = names.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x));
    const xmlBytes = sheetParts.reduce((a, n) => a + usize(zip, n), 0);
    if (xmlBytes > LIMITS.XLSX_MAX_XML_BYTES) return tooComplex('spreadsheet', `about ${Math.round(xmlBytes / 1e6)} MB of cell data, the limit is ${LIMITS.XLSX_MAX_XML_BYTES / 1e6} MB`);
    for (const n of sheetParts) {
      rows += count(await zip.file(n).async('string'), /<row\b/g);
      if (rows > LIMITS.XLSX_MAX_ROWS) return tooComplex('spreadsheet', `more than ${LIMITS.XLSX_MAX_ROWS} rows, the limit is ${LIMITS.XLSX_MAX_ROWS}`);
    }
    return null;
  }
  return null;
}

/** CSV: counts line breaks without parsing. */
function assessCsv(buf) {
  let rows = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) rows++;
  if (rows > LIMITS.CSV_MAX_ROWS) return tooComplex('CSV file', `${rows} rows, the limit is ${LIMITS.CSV_MAX_ROWS}`);
  let cols = 1;
  for (let i = 0; i < buf.length && buf[i] !== 10; i++) if (buf[i] === 44 || buf[i] === 59 || buf[i] === 9) cols++;   // , ; tab in the first line
  if (rows * cols > LIMITS.CSV_MAX_CELLS) return tooComplex('CSV file', `about ${rows * cols} cells, the limit is ${LIMITS.CSV_MAX_CELLS}`);
  return null;
}

module.exports = { LIMITS, assessZip, assessCsv };
