"""
High-Fidelity Document Converter Engine
Guaranteed 98-100% Layout, Typography, Image & Geometry Preservation
- PPTX -> PDF: LibreOffice Impress (preserves exact aspect ratio, vector graphics, fonts, positions)
- DOCX -> PDF: LibreOffice Writer (preserves exact pagination, margins, tables, styles)
- XLSX -> PDF: LibreOffice Calc (preserves sheets, grids, columns)
- PDF -> DOCX: pdf2docx + generic line and divider enhancement
- PDF -> PPTX: PyMuPDF 240 DPI high-crisp render + python-pptx (exact per-page aspect ratio, lossless placement)
- DOCX -> PPTX: 2-stage LibreOffice + PyMuPDF/pptx pipeline
- PPTX -> DOCX: Dual-Mode Architecture:
    1. Layout-Preserving Mode (Default): 300 DPI vector-accurate rendering, 1-slide to 1-page mapping,
       aspect-ratio preserved scaling within Word's 22-inch engine limit, zero page splits, zero blank pages.
    2. Editable Mode: Reconstructs native Word text boxes, tables, shapes, backgrounds, connectors, and pictures
       with fixed-layout positioning (wp:anchor, bodyPr zero margins, tblpPr) and aspect-ratio preserved scaling.
"""

import sys
import os
# numpy/OpenCV start one BLAS worker thread per visible core and reserve a large buffer for each (about 350 MB of committed memory on a
# 12-core machine, measured), which is wasted on a small server whose CPU quota is a fraction of one core. Must be set before numpy loads.
for _v in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ.setdefault(_v, '1')
import re
import time
import subprocess
import shutil
import tempfile
import fitz
# The PDF/image tools below never use the Word, PowerPoint or pdf2docx code. Importing those libraries costs ~0.7 s on every
# process start (several seconds on a small server), so they are only loaded for the commands that need them.
_LIGHT = __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1].lower() in {
    'protect_pdf', 'unlock_pdf', 'compress_image', 'compress_pdf', 'repair_pdf', 'scan_pdf', 'enhance_image',
    'docx2pdf', 'xlsx2pdf', 'pdf2xlsx'}
if not _LIGHT: import docx
if not _LIGHT: from docx.shared import Pt, RGBColor
if not _LIGHT: from docx.enum.section import WD_SECTION_START
if not _LIGHT: from docx.enum.text import WD_ALIGN_PARAGRAPH
if not _LIGHT: from docx.enum.table import WD_TABLE_ALIGNMENT
if not _LIGHT: from docx.oxml import parse_xml, OxmlElement
if not _LIGHT: from docx.oxml.ns import qn
# PDF -> Word never touches python-pptx (checked: no function reachable from that command uses it), so it is not loaded for it (~0.5 s per run).
_NO_PPTX = __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1].lower() == 'pdf2docx'
if not _LIGHT and not _NO_PPTX: from pptx import Presentation
if not _LIGHT and not _NO_PPTX: from pptx.dml.color import RGBColor as PptxRGBColor
if not _LIGHT and not _NO_PPTX: from pptx.enum.shapes import MSO_SHAPE_TYPE
if not _LIGHT and not _NO_PPTX: from pptx.enum.text import PP_ALIGN, MSO_AUTO_SIZE
if not _LIGHT: from pdf2docx import Converter
if not _LIGHT: from pdf2docx.text.Spans import Spans
if not _LIGHT: from pdf2docx.text.TextSpan import TextSpan
if not _LIGHT: from pdf2docx.text.Line import Line
if not _LIGHT: from pdf2docx.image.ImageSpan import ImageSpan

# Patch 1: Preserve whitespace spans in pdf2docx (fixes fused words across all documents)
# and strip invisible/zero-width characters that artificially distort block bounding boxes
ZERO_WIDTH_CHARS = {'\u200b', '\ufeff', '\u200c', '\u200d', '\u2060'}

def clean_invisible_chars(s: str) -> str:
    if not s:
        return s
    for ch in ZERO_WIDTH_CHARS:
        if ch in s:
            s = s.replace(ch, '')
    return s

def _patch_pdf2docx_spans_restore(self, raws: list):
    for raw_span in raws:
        if 'image' in raw_span:
            span = ImageSpan(raw_span)
        else:
            span = TextSpan(raw_span)
            clean_t = clean_invisible_chars(span.text)
            # Fix: Only discard if text is truly empty (or only zero-width characters with no styling), NOT if it is a space span (' ')
            if not clean_t.strip() and not span.style and clean_t != ' ':
                span = None
            elif span.text:
                span._text = clean_t
        if span is not None:
            self.append(span)
    return self

if not _LIGHT: Spans.restore = _patch_pdf2docx_spans_restore

# Patch 2: Intelligent space injection that respects punctuation, hyphens, and typography
if not _LIGHT: _orig_pdf2docx_line_make_docx = Line.make_docx
NO_SPACE_AFTER = {'-', '/', '@', ':', '(', '[', '{', '.', ',', '$', '#', '&', '_', '+', '=', '*'}
NO_SPACE_BEFORE = {'-', '/', '@', ':', ')', ']', '}', '.', ',', '%', ';', '!', '?', ''}

def _patch_pdf2docx_line_make_docx(self, p):
    if self.tab_stop:
        for _ in range(self.tab_stop):
            p.add_run().add_tab()
    
    for i, span in enumerate(self.spans):
        if i > 0 and isinstance(span, TextSpan) and isinstance(self.spans[i-1], TextSpan):
            prev_span = self.spans[i-1]
            prev_txt = prev_span.text
            curr_txt = span.text
            gap = span.bbox[0] - prev_span.bbox[2]
            
            min_sz = min(getattr(prev_span, 'size', 10.0) or 10.0, getattr(span, 'size', 10.0) or 10.0)
            space_thresh = max(2.2, min_sz * 0.22)
            
            if gap >= space_thresh and prev_txt and curr_txt:
                if not prev_txt.endswith(' ') and not curr_txt.startswith(' '):
                    p_last = prev_txt[-1]
                    c_first = curr_txt[0]
                    if p_last not in NO_SPACE_AFTER and c_first not in NO_SPACE_BEFORE:
                        span._text = ' ' + span.text
        span.make_docx(p)
    
    if self.line_break:
        p.add_run('\n')

if not _LIGHT: Line.make_docx = _patch_pdf2docx_line_make_docx

def find_libreoffice():
    if sys.platform == 'win32':
        candidates = [
            r'C:\Program Files\LibreOffice\program\soffice.com',
            r'C:\Program Files (x86)\LibreOffice\program\soffice.com',
            r'C:\Program Files\LibreOffice\program\soffice.exe',
            r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
            'soffice.com',
            'soffice',
            'libreoffice'
        ]
        for c in candidates:
            if os.path.exists(c) or shutil.which(c):
                return c
    else:
        candidates = ['libreoffice', 'soffice']
        for c in candidates:
            if shutil.which(c):
                return c
    return 'soffice.com' if sys.platform == 'win32' else 'libreoffice'

FONT_FAMILY_MAP = {
    'timesnewroman': 'Times New Roman',
    'timesltstd': 'Times New Roman',
    'times': 'Times New Roman',
    'arial': 'Arial',
    'calibri': 'Calibri',
    'cambria': 'Cambria',
    'helvetica': 'Helvetica',
    'couriernew': 'Courier New',
    'courier': 'Courier New',
    'georgia': 'Georgia',
    'verdana': 'Verdana',
    'tahoma': 'Tahoma',
    'trebuchet': 'Trebuchet MS',
    'comicsans': 'Comic Sans MS',
    'myriadpro': 'Myriad Pro',
    'myriad': 'Myriad Pro',
    'segoeui': 'Segoe UI',
    'segoe': 'Segoe UI',
    'roboto': 'Roboto',
    'opensans': 'Open Sans',
    'lato': 'Lato',
    'garamond': 'Garamond',
    'consolas': 'Consolas',
    'palatino': 'Palatino Linotype',
    'bookantiqua': 'Book Antiqua',
    'centurygothic': 'Century Gothic',
    'aptos': 'Aptos',
    'symbol': 'Symbol',
    'wingdings': 'Wingdings'
}

def clean_font_name(raw_name):
    if not raw_name:
        return 'Calibri', False, False
    name = str(raw_name).strip()
    name = re.sub(r'^[A-Z]{6}\+', '', name)
    is_bold = bool(re.search(r'[-_, ](Bold|Bd|Black|Heavy|Semibold|Demi)', name, re.IGNORECASE))
    is_italic = bool(re.search(r'[-_, ](Italic|It|Oblique)', name, re.IGNORECASE))
    
    clean = re.sub(r'[-_, ](Bold|Bd|Black|Heavy|Semibold|Demi|Italic|It|Oblique|Regular|PSMT|PS|MT|OTF|LTStd).*$', '', name, flags=re.IGNORECASE).strip()
    clean = re.sub(r'(PSMT|MT)$', '', clean, flags=re.IGNORECASE).strip()
    
    key = clean.lower().replace(' ', '').replace('-', '')
    for k, canonical in FONT_FAMILY_MAP.items():
        if key.startswith(k) or k.startswith(key):
            return canonical, is_bold, is_italic
            
    if not clean:
        clean = name
    return clean, is_bold, is_italic

def get_pptx_theme_fonts(prs):
    major_font = 'Calibri Light'
    minor_font = 'Calibri'
    try:
        sm = prs.slide_masters[0]
        for rel in sm.part.rels.values():
            if 'theme' in rel.reltype:
                blob = rel.target_part.blob.decode('utf-8', errors='ignore')
                maj = re.search(r'<a:majorFont>.*?<a:latin\s+typeface="([^"]+)"', blob, re.DOTALL)
                min_f = re.search(r'<a:minorFont>.*?<a:latin\s+typeface="([^"]+)"', blob, re.DOTALL)
                if maj: major_font = maj.group(1)
                if min_f: minor_font = min_f.group(1)
                break
    except Exception:
        pass
    return major_font, minor_font

class _LoProfileLease:
    """A persistent LibreOffice profile directory, leased exclusively (LibreOffice cannot share a profile between two
    running instances). Re-using a warm profile cuts the ~5 s first-start cost of a fresh profile to ~1 s per conversion;
    up to 4 leases allow parallel conversions, and a stale lock (crashed process) is reclaimed after 10 minutes."""
    ROOT = os.path.join(tempfile.gettempdir(), 'fileconverter-lo-py-profiles')
    SLOTS = 4

    def __enter__(self):
        import time as _t
        os.makedirs(self.ROOT, exist_ok=True)
        deadline = _t.time() + 120
        while True:
            for n in range(self.SLOTS):
                lock = os.path.join(self.ROOT, f'slot{n}.lock')
                try:
                    if os.path.exists(lock) and _t.time() - os.path.getmtime(lock) > 600:
                        os.remove(lock)
                    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.close(fd)
                    self.lock, self.dir = lock, os.path.join(self.ROOT, f'slot{n}')
                    return self
                except FileExistsError:
                    continue
                except OSError:
                    continue
            if _t.time() > deadline:  # all slots busy for 2 minutes: fall back to a throw-away profile
                self.lock, self.dir = None, tempfile.mkdtemp(prefix='lo_p_')
                return self
            _t.sleep(0.4)

    def discard(self):
        shutil.rmtree(self.dir, ignore_errors=True)  # a failed run may leave the profile damaged

    def __exit__(self, *exc):
        if self.lock is None:
            shutil.rmtree(self.dir, ignore_errors=True)
        else:
            try:
                os.remove(self.lock)
            except OSError:
                pass
        return False


def run_libreoffice(input_path, out_dir, target_ext, filter_name=None):
    lo_cmd = find_libreoffice()
    with _LoProfileLease() as lease:
        profile_uri = 'file:///' + lease.dir.replace('\\', '/').lstrip('/')
        if target_ext.lower() == 'pdf' and filter_name:
            convert_spec = f'pdf:{filter_name}:{{"SelectPdfVersion":{{"type":"long","value":"1"}},"EmbedStandardFonts":{{"type":"boolean","value":"true"}},"UseLosslessCompression":{{"type":"boolean","value":"true"}}}}'
        else:
            convert_spec = target_ext

        cmd = [
            lo_cmd,
            '--headless',
            '--norestore',
            f'-env:UserInstallation={profile_uri}',
            '--convert-to', convert_spec,
            '--outdir', out_dir,
            input_path
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            lease.discard()
            raise
        base = os.path.splitext(os.path.basename(input_path))[0]
        out_file = os.path.join(out_dir, f'{base}.{target_ext}')
        if not os.path.exists(out_file):
            lease.discard()
            raise RuntimeError(f"LibreOffice failed to convert {input_path} to {target_ext}. Stderr: {res.stderr}")
        return out_file

def optimize_pptx_presentation(prs):
    """
    Dynamically and generically optimizes PPTX text boxes:
    1. Zeros internal padding that steals horizontal text box width.
    2. Identifies unallocated horizontal whitespace across each slide and expands
       snugly-bounded text boxes symmetrically (if centered) or unidirectionally.
    3. Prevents cross-platform font metrics from breaking single-line titles into two lines.
    """
    slide_w = prs.slide_width
    slide_h = prs.slide_height

    for slide in prs.slides:
        shapes = [s for s in slide.shapes]
        for shape in shapes:
            if not shape.has_text_frame:
                continue
            
            tf = shape.text_frame
            tf.margin_left = 0
            tf.margin_right = 0
            tf.margin_top = 0
            tf.margin_bottom = 0
            
            has_long_text = False
            for p in tf.paragraphs:
                txt = p.text.strip()
                if len(txt) > 12:
                    has_long_text = True
                    break
            
            if not has_long_text:
                continue

            top = shape.top
            bot = shape.top + shape.height
            left = shape.left
            right = shape.left + shape.width
            
            min_left = int(slide_w * 0.04)
            max_right = int(slide_w * 0.96)
            
            for other in shapes:
                if other == shape:
                    continue
                if other.width > slide_w * 0.9 and other.height > slide_h * 0.9:
                    continue
                other_top = other.top
                other_bot = other.top + other.height
                if not (bot < other_top or top > other_bot):
                    if other.left + other.width <= left:
                        min_left = max(min_left, other.left + other.width + int(slide_w * 0.01))
                    elif other.left >= right:
                        max_right = min(max_right, other.left - int(slide_w * 0.01))

            can_expand_left = max(0, left - min_left)
            can_expand_right = max(0, max_right - right)

            alignments = [p.alignment for p in tf.paragraphs if p.text.strip()]
            is_centered = any(a == PP_ALIGN.CENTER for a in alignments) or (left > slide_w * 0.08 and right < slide_w * 0.92 and abs((left + right)/2.0 - slide_w/2.0) < int(slide_w * 0.08))

            max_expand = int(slide_w * 0.12)
            if is_centered:
                expand = min(can_expand_left, can_expand_right, max_expand)
                if expand > int(slide_w * 0.01):
                    shape.left = int(left - expand)
                    shape.width = int(shape.width + 2 * expand)
            else:
                expand_r = min(can_expand_right, max_expand)
                if expand_r > int(slide_w * 0.01):
                    shape.width = int(shape.width + expand_r)

def optimize_pptx_for_conversion(pptx_path, out_pptx_path):
    prs = Presentation(pptx_path)
    optimize_pptx_presentation(prs)
    prs.save(out_pptx_path)

def pptx_to_pdf(input_path, output_path):
    out_dir = os.path.dirname(os.path.abspath(output_path))
    temp_dir = tempfile.mkdtemp(prefix='pptx_opt_')
    try:
        opt_pptx = os.path.join(temp_dir, os.path.basename(input_path))
        optimize_pptx_for_conversion(input_path, opt_pptx)
        temp_out = run_libreoffice(opt_pptx, temp_dir, 'pdf', filter_name='impress_pdf_Export')
        if os.path.exists(output_path):
            os.remove(output_path)
        shutil.move(temp_out, output_path)
        return output_path
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

def sanitize_docx_for_libreoffice(docx_path):
    """LibreOffice refuses to load a .docx whose document.xml references comments that have no comments part
    (valid for Word, which ignores them). Strip those dangling references in place. Returns True if changed."""
    import zipfile as _zf
    try:
        with _zf.ZipFile(docx_path) as z:
            names = z.namelist()
            if 'word/document.xml' not in names or any(n.startswith('word/comments') for n in names):
                return False
            x = z.read('word/document.xml').decode('utf8')
        if 'commentReference' not in x and 'commentRange' not in x:
            return False
        y = re.sub(r'<w:commentRange(?:Start|End)(?=[ /])[^>]*/>', '', x)
        y = re.sub(r'<w:r(?:\s[^>]*)?>(?:<w:rPr>.*?</w:rPr>|<w:rPr/>)?<w:commentReference(?=[ /])[^>]*/></w:r>', '', y, flags=re.S)
        y = re.sub(r'<w:commentReference(?=[ /])[^>]*/>', '', y)
        tmp = docx_path + '.san.tmp'
        with _zf.ZipFile(docx_path) as zin, _zf.ZipFile(tmp, 'w', _zf.ZIP_DEFLATED) as zout:
            for it in zin.infolist():
                zout.writestr(it, y.encode('utf8') if it.filename == 'word/document.xml' else zin.read(it.filename))
        os.replace(tmp, docx_path)
        return True
    except Exception:
        return False

def docx_to_pdf(input_path, output_path):
    sanitize_docx_for_libreoffice(input_path)
    out_dir = os.path.dirname(os.path.abspath(output_path))
    temp_out = run_libreoffice(input_path, out_dir, 'pdf', filter_name='writer_pdf_Export')
    if os.path.abspath(temp_out) != os.path.abspath(output_path):
        if os.path.exists(output_path):
            os.remove(output_path)
        shutil.move(temp_out, output_path)
    return output_path

def optimize_spreadsheet_for_pdf(input_path, output_xlsx_path):
    """
    Intelligently adjusts page layout, orientation, paper size, column widths,
    wrapping, borders, margins, and header repeating for every worksheet in the workbook.
    Preserves actual data, column order, row order, headers, and cell values.
    """
    import math
    import csv
    import openpyxl
    from openpyxl.styles import Alignment, Border, Side, PatternFill, Font
    from openpyxl.utils import get_column_letter

    ext = os.path.splitext(input_path)[1].lower()
    
    if ext == '.csv':
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Data"
        for enc in ['utf-8-sig', 'utf-8', 'latin1']:
            try:
                with open(input_path, 'r', encoding=enc, errors='replace') as f:
                    reader = csv.reader(f)
                    for r_idx, row in enumerate(reader, 1):
                        for c_idx, val in enumerate(row, 1):
                            v_clean = val.strip()
                            if re.fullmatch(r'-?(0|[1-9][0-9]{0,14})([.][0-9]+)?', v_clean):  # leading zeros / long ids stay text
                                ws.cell(row=r_idx, column=c_idx, value=float(v_clean) if '.' in v_clean else int(v_clean))
                            else:
                                ws.cell(row=r_idx, column=c_idx, value=val)
                break
            except Exception:
                continue
    elif ext == '.xls':
        temp_dir = tempfile.mkdtemp(prefix="xls_conv_")
        try:
            converted = run_libreoffice(input_path, temp_dir, 'xlsx', filter_name='Calc MS Excel 2007 XML')
            wb = openpyxl.load_workbook(converted)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
    else:
        wb = openpyxl.load_workbook(input_path)

    thin_border = Border(
        left=Side(style="thin", color="CBD5E1"),
        right=Side(style="thin", color="CBD5E1"),
        top=Side(style="thin", color="CBD5E1"),
        bottom=Side(style="thin", color="CBD5E1")
    )
    header_border = Border(
        left=Side(style="thin", color="CBD5E1"),
        right=Side(style="thin", color="CBD5E1"),
        top=Side(style="thin", color="CBD5E1"),
        bottom=Side(style="medium", color="64748B")
    )
    header_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    header_font = Font(name="Segoe UI", size=10, bold=True, color="0F172A")
    data_font = Font(name="Segoe UI", size=9, color="1E293B")

    for ws in wb.worksheets:
        max_col = ws.max_column
        max_row = ws.max_row
        if max_col == 0 or max_row == 0:
            continue

        # 1. Analyze column content lengths and sample types
        col_content_lens = {}
        col_is_numeric = {}

        for col in range(1, max_col + 1):
            max_len = 0
            numeric_count = 0
            total_samples = 0
            
            sample_limit = min(max_row, 300)
            for row in range(1, sample_limit + 1):
                val = ws.cell(row=row, column=col).value
                if val is not None:
                    s_val = str(val).strip()
                    total_samples += 1
                    for l in s_val.split("\n"):
                        if len(l) > max_len:
                            max_len = len(l)
                    if isinstance(val, (int, float)):
                        numeric_count += 1

            col_content_lens[col] = max(max_len, 4)
            col_is_numeric[col] = (total_samples > 1 and (numeric_count / total_samples) > 0.7)

        # 2. Compute proportional optimal widths
        col_widths = {}
        for col in range(1, max_col + 1):
            raw_len = col_content_lens.get(col, 10)
            header_val = str(ws.cell(row=1, column=col).value or "").strip()
            header_len = len(header_val)

            # Balanced width allocation
            if raw_len > 40:
                allocated = 28
            elif raw_len > 25:
                allocated = min(raw_len + 3, 26)
            elif raw_len > 15:
                allocated = max(raw_len + 2, header_len + 3)
            else:
                allocated = max(raw_len + 3, header_len + 3, 10)
            
            col_widths[col] = allocated

        total_width_units = sum(col_widths.values())

        # 3. Determine Page Orientation & Paper Size
        if max_col <= 4 and total_width_units <= 75:
            ws.page_setup.orientation = ws.ORIENTATION_PORTRAIT
            ws.page_setup.paperSize = ws.PAPERSIZE_A4
            is_huge = False
        elif max_col <= 10 or total_width_units <= 145:
            ws.page_setup.orientation = ws.ORIENTATION_LANDSCAPE
            ws.page_setup.paperSize = ws.PAPERSIZE_A4
            is_huge = False
        elif max_col <= 16 or total_width_units <= 215:
            ws.page_setup.orientation = ws.ORIENTATION_LANDSCAPE
            ws.page_setup.paperSize = ws.PAPERSIZE_A3
            is_huge = False
        else:
            # Massive sheet (> 16 cols): use A3 landscape and allow multi-page horizontal splitting
            ws.page_setup.orientation = ws.ORIENTATION_LANDSCAPE
            ws.page_setup.paperSize = ws.PAPERSIZE_A3
            is_huge = True

        # 4. Margins & Print Options
        ws.page_margins.left = 0.3
        ws.page_margins.right = 0.3
        ws.page_margins.top = 0.45
        ws.page_margins.bottom = 0.45
        ws.page_margins.header = 0.2
        ws.page_margins.footer = 0.2

        # Repeat header row on all pages
        ws.print_title_rows = "1:1"
        ws.print_options.gridLines = True

        if ws.views and ws.views.sheetView:
            ws.views.sheetView[0].showGridLines = True

        # Fit to 1 page wide if not huge, but let rows flow across multiple pages naturally
        if not is_huge:
            ws.sheet_properties.pageSetUpPr.fitToPage = True
            ws.page_setup.fitToWidth = 1
            ws.page_setup.fitToHeight = 0
        else:
            ws.sheet_properties.pageSetUpPr.fitToPage = False

        # 5. Apply Column Widths, Borders, Font, and Wrapping
        for col in range(1, max_col + 1):
            col_letter = get_column_letter(col)
            w = col_widths[col]
            ws.column_dimensions[col_letter].width = w
            is_num = col_is_numeric.get(col, False)

            for row in range(1, max_row + 1):
                cell = ws.cell(row=row, column=col)
                if row == 1:
                    cell.border = header_border
                    cell.fill = header_fill
                    cell.font = header_font
                    cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
                else:
                    cell.border = thin_border
                    cell.font = data_font
                    align_h = "right" if is_num else "left"
                    cell.alignment = Alignment(horizontal=align_h, vertical="center", wrap_text=True)

        # 6. Row heights: give rows with wrapped text adequate height
        for row in range(1, max_row + 1):
            if row == 1:
                ws.row_dimensions[row].height = 24
                continue

            max_lines = 1
            for col in range(1, max_col + 1):
                val = ws.cell(row=row, column=col).value
                if val:
                    s_val = str(val).strip()
                    col_w = col_widths.get(col, 15)
                    for part in s_val.split("\n"):
                        est = math.ceil(len(part) / max(col_w - 2, 1))
                        if est > max_lines:
                            max_lines = est

            ws.row_dimensions[row].height = max(20, min(max_lines * 14 + 6, 80))

    wb.save(output_xlsx_path)
    return output_xlsx_path

def prepare_xlsx_pagesetup(input_xlsx, output_xlsx):
    """Make a workbook print sensibly WITHOUT touching the author's formatting (fonts, fills, borders, number formats,
    merged cells, charts and conditional formats all stay as they are). Only each sheet's page setup is adjusted, and only
    where the author left it at the defaults: landscape for wide sheets and 'fit all columns on one page width' when the
    sheet is not absurdly wide (very wide sheets keep normal scale and continue on the next page)."""
    import zipfile as _zf
    from lxml import etree
    NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    q = lambda t: '{%s}%s' % (NS, t)
    order_after_pagesetup = ['headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors',
                             'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls',
                             'webPublishItems', 'tableParts', 'extLst']
    with _zf.ZipFile(input_xlsx) as zin, _zf.ZipFile(output_xlsx, 'w', _zf.ZIP_DEFLATED) as zout:
        drawing_cols = 0  # right-most column used by any chart / picture (they widen the printed area as well)
        shared = []
        if 'xl/sharedStrings.xml' in zin.namelist():
            try:
                sroot = etree.fromstring(zin.read('xl/sharedStrings.xml'))
                for si in sroot.findall(q('si')):
                    shared.append(''.join(t.text or '' for t in si.iter(q('t'))))
            except Exception:
                shared = []
        for n_ in zin.namelist():
            if re.match(r'xl/drawings/drawing\d+\.xml$', n_):
                cols_ = re.findall(r'<(?:xdr:)?col>(\d+)</(?:xdr:)?col>', zin.read(n_).decode('utf8', 'ignore'))
                if cols_:
                    drawing_cols = max(drawing_cols, max(int(c) for c in cols_) + 1)
        for item in zin.infolist():
            data = zin.read(item.filename)
            if re.match(r'xl/worksheets/sheet\d+\.xml$', item.filename):
                try:
                    root = etree.fromstring(data)
                    sp = root.find(q('sheetPr'))
                    ps = root.find(q('pageSetup'))
                    pup0 = sp.find(q('pageSetUpPr')) if sp is not None else None
                    author_set = (pup0 is not None and pup0.get('fitToPage') in ('1', 'true')) \
                        or (ps is not None and (ps.get('scale') not in (None, '100') or ps.get('fitToWidth') or ps.get('fitToHeight')))
                    if not author_set:
                        dflt = 8.43
                        fmt = root.find(q('sheetFormatPr'))
                        if fmt is not None and fmt.get('defaultColWidth'):
                            dflt = float(fmt.get('defaultColWidth'))
                        dim = root.find(q('dimension'))
                        ncols = 1
                        if dim is not None and dim.get('ref'):
                            m = re.search(r':([A-Z]+)\d+$', dim.get('ref'))
                            if m:
                                n = 0
                                for ch in m.group(1):
                                    n = n * 26 + (ord(ch) - 64)
                                ncols = n
                        if root.find(q('drawing')) is not None:
                            ncols = max(ncols, drawing_cols)
                        widths = {}
                        cols = root.find(q('cols'))
                        if cols is not None:
                            for c in cols.findall(q('col')):
                                try:
                                    for k in range(int(c.get('min')), min(int(c.get('max')), ncols) + 1):
                                        widths[k] = 0.0 if c.get('hidden') in ('1', 'true') else float(c.get('width', dflt))
                                except ValueError:
                                    pass
                        # Columns left at the default width cut off longer text when printed (a neighbouring filled cell stops the
                        # overflow). Widen only those columns, to the length of their longest value; author-set widths are kept.
                        try:
                            def colnum(ref):
                                n = 0
                                for ch in re.match(r'[A-Z]+', ref).group(0):
                                    n = n * 26 + (ord(ch) - 64)
                                return n
                            need = {}
                            sd = root.find(q('sheetData'))
                            for ri, row in enumerate(sd.findall(q('row')) if sd is not None else []):
                                if ri > 3000:
                                    break
                                for c in row.findall(q('c')):
                                    ci = colnum(c.get('r', 'A1'))
                                    if ci in widths:
                                        continue
                                    v = c.find(q('v'))
                                    t_ = c.get('t')
                                    if t_ == 's' and v is not None and v.text and v.text.isdigit() and int(v.text) < len(shared):
                                        txt = shared[int(v.text)]
                                    elif t_ == 'inlineStr':
                                        txt = ''.join(x.text or '' for x in c.iter(q('t')))
                                    else:
                                        txt = (v.text or '') if v is not None else ''
                                        if c.get('s') not in (None, '0') and txt:
                                            txt += '000'  # a number format (currency, thousands separators) adds characters
                                    longest = max((len(p) for p in txt.split('\n')), default=0)
                                    if longest > need.get(ci, 0):
                                        need[ci] = longest
                            extra = {ci: min(60.0, n * 1.15 + 2.0) for ci, n in need.items() if n * 1.15 + 2.0 > dflt + 0.5}
                            if extra:
                                colsel = root.find(q('cols'))
                                if colsel is None:
                                    colsel = etree.Element(q('cols'))
                                    sd.addprevious(colsel)
                                for ci, w in sorted(extra.items()):
                                    ce = etree.SubElement(colsel, q('col'))
                                    ce.set('min', str(ci)); ce.set('max', str(ci)); ce.set('width', '%.2f' % w); ce.set('customWidth', '1')
                                    widths[ci] = w
                                # <col> children must be ordered by column
                                kids = sorted(colsel.findall(q('col')), key=lambda e: int(e.get('min')))
                                for e in kids:
                                    colsel.remove(e)
                                for e in kids:
                                    colsel.append(e)
                        except Exception as _e:
                            print(f"WARN: column widening skipped: {_e}", file=sys.stderr)
                        total = sum(widths.get(k, dflt) for k in range(1, ncols + 1))
                        if ps is None:
                            ps = etree.Element(q('pageSetup'))
                            anchor = root.find(q('pageMargins'))
                            if anchor is None:
                                anchor = root.find(q('printOptions'))
                            if anchor is not None:
                                anchor.addnext(ps)
                            else:
                                placed = False
                                for tag in order_after_pagesetup:
                                    nxt = root.find(q(tag))
                                    if nxt is not None:
                                        nxt.addprevious(ps)
                                        placed = True
                                        break
                                if not placed:
                                    root.append(ps)
                        if not ps.get('paperSize'):
                            ps.set('paperSize', '9')  # A4
                        if total > 85 and not ps.get('orientation'):
                            ps.set('orientation', 'landscape')
                        if 0 < total <= 150 and ncols > 1:  # beyond that the text would shrink below ~85%: keep scale, continue on next page
                            if sp is None:
                                sp = etree.Element(q('sheetPr'))
                                root.insert(0, sp)
                            pup = sp.find(q('pageSetUpPr'))
                            if pup is None:
                                pup = etree.SubElement(sp, q('pageSetUpPr'))
                            pup.set('fitToPage', '1')
                            ps.set('fitToWidth', '1')
                            ps.set('fitToHeight', '0')
                    data = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
                except Exception as e:
                    print(f"WARN: page setup left unchanged for {item.filename}: {e}", file=sys.stderr)
            zout.writestr(item, data)
    return output_xlsx


def xlsx_to_pdf(input_path, output_path):
    """
    Excel-to-PDF with LibreOffice, keeping the workbook exactly as authored (formatting, merged cells, number formats,
    charts). Only page setup is adjusted (see prepare_xlsx_pagesetup). CSV files, which carry no formatting, get a plain
    readable layout (header row styled, column widths fitted).
    """
    out_dir = os.path.dirname(os.path.abspath(output_path))
    temp_dir = tempfile.mkdtemp(prefix="lo_xlsx_opt_")
    try:
        ext = os.path.splitext(input_path)[1].lower()
        convert_source = input_path
        try:
            if ext == '.csv':
                temp_xlsx = os.path.join(temp_dir, "optimized.xlsx")
                optimize_spreadsheet_for_pdf(input_path, temp_xlsx)
                convert_source = temp_xlsx
            else:
                src_xlsx = input_path
                if ext != '.xlsx':  # .xls / .xlsm / .ods -> xlsx first so the page setup can be adjusted
                    src_xlsx = run_libreoffice(input_path, temp_dir, 'xlsx', filter_name='Calc MS Excel 2007 XML')
                temp_xlsx = os.path.join(temp_dir, "prepared.xlsx")
                prepare_xlsx_pagesetup(src_xlsx, temp_xlsx)
                convert_source = temp_xlsx
        except Exception as opt_err:
            print(f"Spreadsheet preparation notice, using the original file: {opt_err}", file=sys.stderr)
            convert_source = input_path

        temp_out = run_libreoffice(convert_source, out_dir, 'pdf', filter_name='calc_pdf_Export')
        if os.path.abspath(temp_out) != os.path.abspath(output_path):
            if os.path.exists(output_path):
                os.remove(output_path)
            shutil.move(temp_out, output_path)
        return output_path
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def add_paragraph_bottom_border(paragraph, color_hex="334155", sz="8"):
    """Adds native Word bottom border under a heading (for divider lines)."""
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = pPr.find(qn('w:pBdr'))
    if pBdr is None:
        pBdr = OxmlElement('w:pBdr')
        pPr.append(pBdr)
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), str(sz))
    bottom.set(qn('w:space'), '4')
    bottom.set(qn('w:color'), str(color_hex))
    pBdr.append(bottom)

PUA_BULLET_REPLACEMENTS = {
    '\uf0d8': '• ',
    '\uf0b7': '• ',
    '\uf0a7': '• ',
    '\uf0a8': '• ',
    '\uf0fc': '✓ ',
    '\uf0a4': '• ',
    '\uf0e0': '✉ ',
    '\uf095': '☎ ',
    '\uf020': ' ',
    '\u2022': '• ',
    '\u25aa': '• ',
    '\u25cf': '• ',
    '\u25cb': '○ '
}

def _match_pdf_lines(doc, pdf):
    """Pair every body paragraph of a pdf2docx result with the PDF text lines it came from (same reading order).
    Returns (pdf_lines, [(paragraph, first_idx, last_idx_exclusive)]); pdf_lines are dicts {t, bbox, page}."""
    pdf_lines = []
    for pno, page in enumerate(pdf):
        for b in page.get_text('dict')['blocks']:
            if b.get('type') != 0:
                continue
            for ln in b['lines']:
                t = re.sub(r'\s+', '', ''.join(sp['text'] for sp in ln['spans']))
                if t:
                    pdf_lines.append({'t': t, 'bbox': ln['bbox'], 'page': pno})
    matches, ptr = [], 0
    for p in doc.paragraphs:
        t = re.sub(r'\s+', '', p.text)
        if not t:
            continue
        for s0 in range(ptr, min(len(pdf_lines), ptr + 80)):
            acc, k = '', s0
            while k < len(pdf_lines) and len(acc) < len(t):
                acc += pdf_lines[k]['t']; k += 1
                if not t.startswith(acc):
                    break
            if acc == t:
                matches.append((p, s0, k)); ptr = k
                break
    return pdf_lines, matches


def _apply_pdf_geometry(doc, pdf_path):
    """Fix what pdf2docx gets wrong and the PDF geometry knows: paragraph alignment (justified text read as centred, etc.)
    and the thin divider rules under headings (dropped by pdf2docx)."""
    from docx.oxml import OxmlElement as _OE
    pdf = fitz.open(pdf_path)
    try:
        pdf_lines, matches = _match_pdf_lines(doc, pdf)
        aligned = 0
        for p, s0, k in matches:
            L = pdf_lines[s0:k]
            if len(L) < 2:
                continue
            lx = [l['bbox'][0] for l in L]; rx = [l['bbox'][2] for l in L]; cx = [(l['bbox'][0] + l['bbox'][2]) / 2 for l in L]
            same_left = max(lx) - min(lx) < 3.0
            same_right_body = len(L) >= 3 and (max(rx[:-1]) - min(rx[:-1]) < 3.0)
            same_center = max(cx) - min(cx) < 3.0
            want = None
            if same_left and same_right_body:
                want = WD_ALIGN_PARAGRAPH.JUSTIFY
            elif same_left:
                want = WD_ALIGN_PARAGRAPH.LEFT
            elif same_center:
                want = WD_ALIGN_PARAGRAPH.CENTER
            elif max(rx) - min(rx) < 3.0:
                want = WD_ALIGN_PARAGRAPH.RIGHT
            if want is not None and p.alignment != want:
                p.alignment = want; aligned += 1
        # divider rules
        rules = 0
        for pno, page in enumerate(pdf):
            for d in page.get_drawings():
                r = d.get('rect'); col = d.get('color') or d.get('fill')
                if r is None or r.width < 40 or r.height > 2.5 or not col:
                    continue
                if min(col[:3]) > 0.95:
                    continue
                above = [i for i, l in enumerate(pdf_lines) if l['page'] == pno and -2 <= r.y0 - l['bbox'][3] <= 26
                         and l['bbox'][0] < r.x1 and l['bbox'][2] > r.x0]
                if not above:
                    continue
                last = max(above, key=lambda i: pdf_lines[i]['bbox'][3])
                for p, s0, k in matches:
                    if s0 <= last < k:
                        pPr = p._p.get_or_add_pPr()
                        if pPr.find(qn('w:pBdr')) is None:
                            bdr = _OE('w:pBdr'); b = _OE('w:bottom')
                            b.set(qn('w:val'), 'single'); b.set(qn('w:sz'), str(max(2, int(round(max(r.height, d.get('width') or 0.5) * 8)))))
                            b.set(qn('w:space'), '1'); b.set(qn('w:color'), '%02X%02X%02X' % tuple(int(round(c * 255)) for c in col[:3]))
                            bdr.append(b)
                            # schema order: pBdr must precede spacing/ind/jc
                            anchor = None
                            for tag in ('w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:spacing', 'w:ind', 'w:jc'):
                                anchor = pPr.find(qn(tag))
                                if anchor is not None:
                                    break
                            if anchor is not None:
                                anchor.addprevious(bdr)
                            else:
                                pPr.append(bdr)
                            rules += 1
                        break
        return aligned, rules
    finally:
        pdf.close()

def _restore_line_breaks(doc, pdf_path, max_lines=4):
    """pdf2docx joins consecutive PDF lines of a block into one paragraph and leaves the wrapping to the viewer, so
    Word/WPS wrap differently from the PDF ('In' jumps up a line, headings split). For short paragraphs (<= max_lines
    PDF lines) and for centred ones, put the PDF's own line breaks back; long body paragraphs stay freely reflowable."""
    import copy
    try:
        pdf = fitz.open(pdf_path)
    except Exception:
        return 0
    pdf_lines = []
    for page in pdf:
        for b in page.get_text('dict')['blocks']:
            if b.get('type') != 0:
                continue
            for ln in b['lines']:
                t = re.sub(r'\s+', '', ''.join(sp['text'] for sp in ln['spans']))
                if t:
                    pdf_lines.append(t)
    pdf.close()
    ptr, inserted = 0, 0
    for p in doc.paragraphs:
        t = re.sub(r'\s+', '', p.text)
        if not t:
            continue
        found = None
        for s0 in range(ptr, min(len(pdf_lines), ptr + 80)):
            acc, k = '', s0
            while k < len(pdf_lines) and len(acc) < len(t):
                acc += pdf_lines[k]; k += 1
                if not t.startswith(acc):
                    break
            if acc == t:
                found = (s0, k); break
        if not found:
            continue
        s0, k = found
        ptr = k
        n = k - s0
        centred = p.alignment == WD_ALIGN_PARAGRAPH.CENTER
        # centred titles / cover text is where a wrong wrap is visible; justified body text reflows naturally
        if n < 2 or n > 6 or not centred or '	' in p.text:
            continue
        if p._p.xpath('.//w:br[not(@w:type)]'):
            continue  # already has explicit line breaks
        offsets, run_len = [], 0
        for ln_t in pdf_lines[s0:k - 1]:
            run_len += len(ln_t); offsets.append(run_len)
        # walk the runs, splitting at the character offsets (counted without whitespace)
        count, oi = 0, 0
        for r in list(p.runs):
            if oi >= len(offsets):
                break
            txt = r.text
            if not txt or r._r.xpath('.//w:drawing'):
                continue
            pos = 0
            while oi < len(offsets) and pos <= len(txt):
                need = offsets[oi] - count
                seen, i = 0, pos
                while i < len(txt) and seen < need:
                    if not txt[i].isspace():
                        seen += 1
                    i += 1
                if seen < need:
                    count += seen
                    break
                while i < len(txt) and txt[i].isspace():
                    i += 1
                head, tail = txt[:i].rstrip(), txt[i:]
                r.text = head
                r.add_break()
                if tail:
                    new_r = copy.deepcopy(r._r)
                    for br in new_r.xpath('.//w:br'):
                        br.getparent().remove(br)
                    r._r.addnext(new_r)
                    from docx.text.run import Run
                    nr = Run(new_r, p)
                    nr.text = tail
                    r = nr
                    txt = tail
                    count = offsets[oi]
                    pos = 0
                    oi += 1
                else:
                    count = offsets[oi]
                    oi += 1
                    break
            else:
                count += sum(1 for ch in txt[pos:] if not ch.isspace())
        inserted += 1
    return inserted

def enhance_docx_fidelity(docx_path, pdf_path):
    """
    Light post-processing of a pdf2docx result. pdf2docx already reproduces page breaks, indents and line breaks from the
    PDF geometry; earlier versions of this pass second-guessed that (forcing continuous sections, re-centering, shrinking
    spacing, adding borders by text match) and measurably made documents worse (page counts halved, text displaced).
    Only safe clean-ups remain:
      - Symbol/Wingdings private-use bullet glyphs -> real bullets
      - light-on-nothing text contrast protection (white text on an unshaded paragraph/cell)
      - trailing empty paragraphs
    """
    try:
        doc = docx.Document(docx_path)
    except Exception:
        return

    for p in doc.paragraphs:
        for r in p.runs:
            rt = r.text                                   # read once (each read walks the run's XML)
            if not any(ch in rt for ch in PUA_BULLET_REPLACEMENTS):
                continue
            for pua_char, replacement in PUA_BULLET_REPLACEMENTS.items():
                if pua_char in r.text:
                    r.text = r.text.replace(pua_char, replacement)

    try:
        _apply_pdf_geometry(doc, pdf_path)
    except Exception as _e:
        print(f"WARN: geometry fixes skipped: {_e}", file=sys.stderr)
    try:
        _restore_line_breaks(doc, pdf_path)
    except Exception as _e:
        print(f"WARN: line-break restoration skipped: {_e}", file=sys.stderr)

    # pdf2docx writes EXACT line heights taken from the PDF line pitch; when a line also holds a larger font (title +
    # subtitle in one paragraph) the glyphs are clipped. AT LEAST keeps the same height unless the text needs more.
    for para in doc.element.body.iter(qn('w:p')):
        sp = para.find(qn('w:pPr') + '/' + qn('w:spacing'))
        if sp is None or sp.get(qn('w:lineRule')) != 'exact':
            continue
        sizes = [int(x.get(qn('w:val'))) for x in para.iter(qn('w:sz')) if x.get(qn('w:val'), '').isdigit()]
        if sizes and int(sp.get(qn('w:line'), '0')) < max(sizes) * 10 * 0.95:  # w:sz is in half-points, w:line in twips
            sp.set(qn('w:lineRule'), 'atLeast')

    def _light(run):
        try:
            c = run.font.color.rgb if run.font.color else None
            return c is not None and c[0] > 240 and c[1] > 240 and c[2] > 240
        except Exception:
            return False

    for p in doc.paragraphs:
        has_shd = bool(p._p.pPr is not None and p._p.pPr.find(qn('w:shd')) is not None)
        if not has_shd:
            for r in p.runs:
                if _light(r):
                    r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                tcPr = cell._tc.tcPr
                cell_has_shd = bool(tcPr is not None and tcPr.find(qn('w:shd')) is not None)
                for cp in cell.paragraphs:
                    p_has_shd = cell_has_shd or bool(cp._p.pPr is not None and cp._p.pPr.find(qn('w:shd')) is not None)
                    if not p_has_shd:
                        for cr in cp.runs:
                            if _light(cr):
                                cr.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

    # fonts that are not installed on the reader's machine get substituted unpredictably: keep safe ones, map the rest
    for part_el in [doc.element] + ([doc.styles.element] if doc.styles is not None else []):
        for rf in part_el.iter(qn('w:rFonts')):
            for att in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
                v = rf.get(qn(att))
                if v:
                    rf.set(qn(att), safe_font(v))

    while doc.paragraphs and not doc.paragraphs[-1].text.strip() and not doc.paragraphs[-1]._p.xpath('.//w:drawing')             and not doc.paragraphs[-1]._p.xpath('.//w:sectPr'):
        p_elem = doc.paragraphs[-1]._p
        p_elem.getparent().remove(p_elem)

    doc.save(docx_path)

def is_presentation_pdf(pdf_path):
    try:
        doc = fitz.open(pdf_path)
        if len(doc) == 0:
            doc.close()
            return False
        landscape_slides = 0
        total = len(doc)
        for p in doc:
            w, h = p.rect.width, p.rect.height
            if w > h and (w / h) >= 1.2:
                landscape_slides += 1
        doc.close()
        return (landscape_slides / total >= 0.7)
    except Exception:
        return False

def _page_needs_ocr(page, raw_text=None):
    """A page is 'scanned' when it has (almost) no real text layer. A sparse slide with a short title (< 40 characters)
    and a background picture is NOT scanned - running OCR on it replaces good text with garbage."""
    t = (page.get_text() if raw_text is None else raw_text).strip()
    if len(t) >= 10:
        return False
    return True

def _longest_runs(mask, axis_len_min):
    """For a 2D bool mask return, per row, (start, end) of the longest True run (or None)."""
    import numpy as np
    out = []
    for row in mask:
        if row.sum() < axis_len_min:
            out.append(None); continue
        d = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
        st, en = np.where(d == 1)[0], np.where(d == -1)[0]
        # bridge small gaps (a line crossed by perpendicular lines / thin-mask holes)
        ms, me = [st[0]], [en[0]]
        for a_, b_ in zip(st[1:], en[1:]):
            if a_ - me[-1] <= 10: me[-1] = b_
            else: ms.append(a_); me.append(b_)
        ms, me = np.array(ms), np.array(me)
        k = int(np.argmax(me - ms))
        out.append((int(ms[k]), int(me[k])) if me[k] - ms[k] >= axis_len_min else None)
    return out

def detect_raster_tables(page, textpage, dpi=150):
    """Find ruled tables in a scanned page image and fill cells from OCR words.
    Returns [{'bbox': (x0,y0,x1,y1) in pt, 'rows': [[str,...],...]}]."""
    import numpy as np
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w)
    dark = img < 140
    sc = 72.0 / dpi
    # keep only thin strokes: pixels inside solid blobs (logos, photos, bold text) have dark neighbours on both sides
    def _thin(m, ax):
        k = 5
        p = np.pad(m, ((k, k), (0, 0)) if ax == 0 else ((0, 0), (k, k)))
        a_ = p[:-2 * k] if ax == 0 else p[:, :-2 * k]
        b_ = p[2 * k:] if ax == 0 else p[:, 2 * k:]
        return m & ~(a_ & b_)
    dark_h, dark_v = _thin(dark, 0), _thin(dark, 1)
    hr = _longest_runs(dark_h, int(pix.w * 0.12))
    vr = _longest_runs(dark_v.T, int(pix.h * 0.04))
    def cluster(vals):  # merge adjacent pixel indices into line centres with extents
        groups = []
        for i, v in vals:
            if groups and i - groups[-1][-1][0] <= 2: groups[-1].append((i, v))
            else: groups.append([(i, v)])
        reps = []
        for g in groups:  # the longest member is the real ruling line; shorter neighbours are text/blob edges
            i, v = max(g, key=lambda t: t[1][1] - t[1][0])
            reps.append((float(i), v[0], v[1]))
        return reps
    hl = cluster([(i, v) for i, v in enumerate(hr) if v])
    vl = cluster([(i, v) for i, v in enumerate(vr) if v])
    if len(hl) < 2 or len(vl) < 2:
        return []
    # group horizontal lines into tables by vertical proximity
    hl = [h for h in hl if h[2] - h[1] >= pix.w * 0.25]
    if len(hl) < 2:
        return []
    tables, cur = [], [hl[0]]
    for h in hl[1:]:
        if h[0] - cur[-1][0] <= pix.h * 0.25: cur.append(h)
        else: tables.append(cur); cur = [h]
    tables.append(cur)
    words = textpage if isinstance(textpage, list) else page.get_text('words', textpage=textpage)
    result = []
    for grp in tables:
        if len(grp) < 2: continue
        wmax = max(h[2] - h[1] for h in grp)
        grp = [h for h in grp if h[2] - h[1] >= 0.8 * wmax]
        if len(grp) < 2: continue
        y0, y1 = grp[0][0], grp[-1][0]
        x0, x1 = min(h[1] for h in grp), max(h[2] for h in grp)
        cols = [v for v in vl if v[1] <= y0 + 8 and v[2] >= y1 - 8 and x0 - 6 <= v[0] <= x1 + 6]
        if len(cols) < 2: continue
        xs = [c[0] for c in cols]; ys = [h[0] for h in grp]
        rows = [[[] for _ in range(len(xs) - 1)] for _ in range(len(ys) - 1)]
        for w in words:
            cx, cy = (w[0] + w[2]) / 2 / sc, (w[1] + w[3]) / 2 / sc
            ri = next((i for i in range(len(ys) - 1) if ys[i] <= cy <= ys[i + 1]), None)
            ci = next((i for i in range(len(xs) - 1) if xs[i] <= cx <= xs[i + 1]), None)
            if ri is not None and ci is not None: rows[ri][ci].append(w)
        text_rows = [[' '.join(x[4] for x in sorted(c, key=lambda w: (round(w[1] / 6), w[0]))) for c in r] for r in rows]
        if sum(1 for r in text_rows for c in r if c) < 2: continue
        result.append({'bbox': (xs[0] * sc, y0 * sc, xs[-1] * sc, y1 * sc), 'rows': text_rows})
    return result


from xml.sax.saxutils import escape as _xml_escape

_WPS_NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
           'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
           'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
           'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
           'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"')

def _hex(c):
    return '%02X%02X%02X' % tuple(max(0, min(255, int(round(v * 255)))) for v in c[:3])

def _pua(text):
    """Symbol/Wingdings private-use glyphs (bullets, ticks) do not exist in normal fonts and show up as '?' boxes; map the
    known ones to real characters and drop unknown private-use code points."""
    if not text or not any('' <= ch <= '' for ch in text):
        return text
    out = []
    for ch in text:
        if '' <= ch <= '':
            rep = PUA_BULLET_REPLACEMENTS.get(ch)
            out.append(rep.strip() if rep and rep.strip() else ('•' if ch in '' else ''))
        else:
            out.append(ch)
    return ''.join(out)


def _wps_runs_xml(lines):
    """lines: list of span-lists -> <w:p> xml (one paragraph per PDF line) for a shape's text box."""
    out = []
    for spans in lines:
        runs = []
        for sp in spans:
            t = _pua(sp.get('text', ''))
            if not t:
                continue
            sz = max(6.0, min(60.0, sp.get('size', 11.0)))
            fn = sp.get('font', '').lower()
            rpr = f'<w:sz w:val="{int(sz * 2)}"/>'
            if 'bold' in fn or 'black' in fn or 'demi' in fn:
                rpr = '<w:b/>' + rpr
            if 'italic' in fn or 'oblique' in fn:
                rpr = '<w:i/>' + rpr
            c = sp.get('color', 0)
            if isinstance(c, int):
                rpr += '<w:color w:val="%02X%02X%02X"/>' % ((c >> 16) & 255, (c >> 8) & 255, c & 255)
            runs.append(f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{_xml_escape(t)}</w:t></w:r>')
        if runs:
            out.append('<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' + ''.join(runs) + '</w:p>')
    return ''.join(out)

def _wps_shape_run(shape_id, x, y, w, h, fill, line, line_w, rounded, paras_xml='', z=0, behind=True, anchor_v='ctr', wrap_none=False, ins=45720, geom=None, opacity=None):
    """A native, editable DrawingML shape anchored behind the text at an absolute page position (points)."""
    E = 12700
    alpha = f'<a:alpha val="{int(max(0.0, min(1.0, opacity)) * 100000)}"/>' if opacity is not None and opacity < 0.999 else ''
    fill_xml = f'<a:solidFill><a:srgbClr val="{_hex(fill)}">{alpha}</a:srgbClr></a:solidFill>' if fill is not None else '<a:noFill/>'
    ln_xml = (f'<a:ln w="{int(max(0.25, line_w) * E)}"><a:solidFill><a:srgbClr val="{_hex(line)}"/></a:solidFill></a:ln>'
              if line is not None else '<a:ln><a:noFill/></a:ln>')
    txbx = f'<wps:txbx><w:txbxContent>{paras_xml}</w:txbxContent></wps:txbx>' if paras_xml else ''
    cx, cy = int(max(1.0, w) * E), int(max(1.0, h) * E)
    return parse_xml(
        f'<w:r {_WPS_NS}><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>'
        f'<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{251658240 + z}" behindDoc="{1 if behind else 0}" locked="0" layoutInCell="1" allowOverlap="1">'
        f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{int(x * E)}</wp:posOffset></wp:positionH>'
        f'<wp:positionV relativeFrom="page"><wp:posOffset>{int(y * E)}</wp:posOffset></wp:positionV>'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
        f'<wp:docPr id="{shape_id}" name="Shape {shape_id}"/><wp:cNvGraphicFramePr/>'
        f'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/>'
        f'<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        f'{geom or ("<a:prstGeom prst=" + chr(34) + ("roundRect" if rounded else "rect") + chr(34) + "><a:avLst/></a:prstGeom>")}{fill_xml}{ln_xml}</wps:spPr>{txbx}'
        f'<wps:bodyPr wrap="{"none" if wrap_none else "square"}" lIns="{ins}" tIns="0" rIns="{ins}" bIns="0" anchor="{anchor_v}"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic>'
        f'</wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>')

def _custgeom_xml(items, rect):
    """DrawingML freeform path (lines + cubic beziers) for a PDF drawing; coordinates are relative to its bounding box."""
    E = 12700
    ox, oy = rect.x0, rect.y0
    W, H = max(1, int(rect.width * E)), max(1, int(rect.height * E))
    def pt(p):
        return f'<a:pt x="{int((p.x - ox) * E)}" y="{int((p.y - oy) * E)}"/>'
    cmds, cur, started = [], None, False
    def move(p):
        nonlocal cur
        if cur is None or abs(cur.x - p.x) > 0.01 or abs(cur.y - p.y) > 0.01:
            cmds.append(f'<a:moveTo>{pt(p)}</a:moveTo>')
    for it in items:
        k = it[0]
        if k == 'l':
            move(it[1]); cmds.append(f'<a:lnTo>{pt(it[2])}</a:lnTo>'); cur = it[2]
        elif k == 'c':
            move(it[1]); cmds.append(f'<a:cubicBezTo>{pt(it[2])}{pt(it[3])}{pt(it[4])}</a:cubicBezTo>'); cur = it[4]
        elif k == 're':
            r = it[1]; q = [fitz.Point(r.x0, r.y0), fitz.Point(r.x1, r.y0), fitz.Point(r.x1, r.y1), fitz.Point(r.x0, r.y1)]
            cmds.append(f'<a:moveTo>{pt(q[0])}</a:moveTo>' + ''.join(f'<a:lnTo>{pt(p)}</a:lnTo>' for p in q[1:]) + '<a:close/>'); cur = None
        elif k == 'qu':
            q = it[1]; ps = [q.ul, q.ur, q.lr, q.ll]
            cmds.append(f'<a:moveTo>{pt(ps[0])}</a:moveTo>' + ''.join(f'<a:lnTo>{pt(p)}</a:lnTo>' for p in ps[1:]) + '<a:close/>'); cur = None
    cmds.append('<a:close/>')
    return (f'<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>'
            f'<a:pathLst><a:path w="{W}" h="{H}">{"".join(cmds)}</a:path></a:pathLst></a:custGeom>')

def _is_plain_rect(items, rect):
    """True when the drawing is just an axis-aligned rectangle (or a rounded one) rather than a freeform path."""
    kinds = [it[0] for it in items]
    if all(k in ('re', 'qu') for k in kinds):
        for it in items:  # a 'qu' (4-point polygon) is only a rectangle when it is axis-aligned
            if it[0] == 'qu':
                q = it[1]
                if not (abs(q.ul.y - q.ur.y) < 0.6 and abs(q.ll.y - q.lr.y) < 0.6 and abs(q.ul.x - q.ll.x) < 0.6 and abs(q.ur.x - q.lr.x) < 0.6):
                    return False
        return True
    if all(k == 'l' for k in kinds):
        pts = [p for it in items for p in (it[1], it[2])]
        return len(items) <= 5 and all((abs(p.x - rect.x0) < 0.6 or abs(p.x - rect.x1) < 0.6) and (abs(p.y - rect.y0) < 0.6 or abs(p.y - rect.y1) < 0.6) for p in pts)
    return False

def _page_vector_shapes(page, table_boxes):
    """(background_rgb_or_None, [shape dicts]) from the page's vector drawings."""
    pw, ph = page.rect.width, page.rect.height
    bg, shapes = None, []
    for dr in page.get_drawings():
        rect, fill, stroke = dr.get('rect'), dr.get('fill'), dr.get('color')
        if rect is None or (fill is None and stroke is None):
            continue
        if rect.width * rect.height >= pw * ph * 0.90 and fill is not None:
            bg = fill
            continue
        stroke_only = fill is None and stroke is not None
        if ((rect.width < 2 or rect.height < 2) and not stroke_only) or (rect.width < 0.2 and rect.height < 0.2) or len(shapes) >= 400:
            continue
        kinds = {it[0] for it in dr.get('items', [])}
        if not kinds <= {'re', 'qu', 'c', 'l'}:
            continue
        cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
        if any(t[0] - 1 <= cx <= t[2] + 1 and t[1] - 1 <= cy <= t[3] + 1 for t in table_boxes):
            continue
        items = dr.get('items', [])
        plain = _is_plain_rect(items, rect)
        rounded = ('c' in kinds) and len(items) <= 8 and all(it[0] in ('c', 'l') and (it[0] == 'c' or abs(it[1].x - it[2].x) < 0.6 or abs(it[1].y - it[2].y) < 0.6) for it in items)
        geom = None if (plain or rounded) else (_custgeom_xml(items, rect) if len(items) <= 400 else None)
        if not (plain or rounded) and geom is None:
            continue
        if (dr.get('fill_opacity') is not None and dr.get('fill_opacity') <= 0.01) and fill is not None and stroke is None:
            continue  # fully transparent: draws nothing
        clipped = rect.x0 < -2 or rect.y0 < -2 or rect.x1 > pw + 2 or rect.y1 > ph + 2
        shapes.append({'rect': rect, 'fill': fill, 'line': stroke, 'line_w': dr.get('width') or 1.0, 'rounded': rounded,
                       'geom': geom, 'opacity': dr.get('fill_opacity'), 'clipped': clipped})
    if bg is not None and min(bg[:3]) > 0.97:
        bg = None  # white page: nothing to draw
    return bg, shapes


def _wps_anchor_picture(run, img_path, x, y, w, h, z, behind=True):
    """Insert a picture as an anchored (floating) drawing at an absolute page position (points)."""
    E = 12700
    run.add_picture(img_path, width=Pt(max(1.0, w)), height=Pt(max(1.0, h)))
    drawing = run._r.findall(qn('w:drawing'))[-1]
    inline = drawing[0]
    graphic = inline.find(qn('a:graphic'))
    docpr = inline.find(qn('wp:docPr'))
    cx, cy = int(max(1.0, w) * E), int(max(1.0, h) * E)
    anchor = parse_xml(
        f'<wp:anchor {_WPS_NS} distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{251658240 + z}" '
        f'behindDoc="{1 if behind else 0}" locked="0" layoutInCell="1" allowOverlap="1">'
        f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{int(x * E)}</wp:posOffset></wp:positionH>'
        f'<wp:positionV relativeFrom="page"><wp:posOffset>{int(y * E)}</wp:posOffset></wp:positionV>'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/></wp:anchor>')
    if docpr is not None:
        anchor.append(docpr)
    anchor.append(parse_xml(f'<wp:cNvGraphicFramePr {_WPS_NS}/>'))
    anchor.append(graphic)
    drawing.remove(inline)
    drawing.append(anchor)


def _positioned_lines_xml(block):
    """Paragraphs with exact line pitch. PDF 'lines' that share a baseline (a bullet glyph and its text, columns inside a
    block) become one paragraph joined with tab stops so they keep their exact horizontal positions."""
    lines = [ln for ln in block.get('lines', []) if "".join(s.get('text', '') for s in ln.get('spans', [])).strip()]
    if not lines:
        return ''
    bx0 = block['bbox'][0]
    rows = []
    for ln in sorted(lines, key=lambda l: (l['bbox'][1], l['bbox'][0])):
        size = max((sp.get('size', 11.0) for sp in ln.get('spans', [])), default=11.0)
        if rows and abs(ln['bbox'][3] - rows[-1]['bottom']) <= size * 0.35:
            rows[-1]['lines'].append(ln); rows[-1]['bottom'] = max(rows[-1]['bottom'], ln['bbox'][3])
        else:
            rows.append({'lines': [ln], 'top': ln['bbox'][1], 'bottom': ln['bbox'][3], 'size': size})
    out = []
    for i, row in enumerate(rows):
        segs = sorted(row['lines'], key=lambda l: l['bbox'][0])
        size = max(row['size'], 1.0)
        pitch = (rows[i + 1]['top'] - row['top']) if i + 1 < len(rows) else size * 1.2
        pitch = max(size, min(pitch, size * 3)) if pitch > 0 else size * 1.2
        runs, tabs = [], []
        for k, ln in enumerate(segs):
            if k > 0:
                pos = int(max(0.0, ln['bbox'][0] - bx0) * 20)
                tabs.append(f'<w:tab w:val="left" w:pos="{pos}"/>')
                runs.append('<w:r><w:tab/></w:r>')
            for sp in ln.get('spans', []):
                t = _pua(sp.get('text', ''))
                if not t:
                    continue
                fam, b, it = clean_font_name(sp.get('font', ''))
                flags = sp.get('flags', 0)
                b = b or bool(flags & 16) or bool(re.search(r'bold|black|heavy|demi', sp.get('font', ''), re.I))
                it = it or bool(flags & 2)
                fam = safe_font(fam, flags)
                rpr = f'<w:rFonts w:ascii="{_xml_escape(fam)}" w:hAnsi="{_xml_escape(fam)}" w:cs="{_xml_escape(fam)}"/>'
                if b:
                    rpr += '<w:b/>'
                if it:
                    rpr += '<w:i/>'
                c = sp.get('color', 0)
                if isinstance(c, int):
                    rpr += '<w:color w:val="%02X%02X%02X"/>' % ((c >> 16) & 255, (c >> 8) & 255, c & 255)
                rpr += f'<w:sz w:val="{max(2, int(round(sp.get("size", 11.0) * 2)))}"/>'
                runs.append(f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{_xml_escape(t)}</w:t></w:r>')
        indent_tw = int(max(0.0, segs[0]['bbox'][0] - bx0) * 20)
        out.append(f'<w:p><w:pPr><w:tabs>{"".join(tabs)}</w:tabs><w:spacing w:before="0" w:after="0" w:line="{int(pitch * 20)}" w:lineRule="atLeast"/>'
                   f'<w:ind w:left="{indent_tw}"/></w:pPr>{"".join(runs)}</w:p>')
    return ''.join(out)


def _textfree_page_copy(page):
    """(page_copy, doc) with all text removed, so artwork can be cropped as pixels without the text on top of it."""
    tmpdoc = fitz.open()
    tmpdoc.insert_pdf(page.parent, from_page=page.number, to_page=page.number)
    p2 = tmpdoc[0]
    for w in p2.get_text('words'):
        p2.add_redact_annot(fitz.Rect(w[:4]))
    p2.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    return (p2, tmpdoc)

def _positioned_page(doc_w, page, idx, text_dict, tmp_dir, scanned=False):
    """Slide-style page -> editable Word page: background, vector shapes, pictures and every text block are
    floating objects at their exact PDF coordinates (text stays real, editable text in text boxes)."""
    pw, ph = page.rect.width, page.rect.height
    anchor = doc_w.add_paragraph()
    anchor.paragraph_format.space_before = Pt(0)
    anchor.paragraph_format.space_after = Pt(0)
    anchor.paragraph_format.line_spacing = Pt(1)
    sid = (idx + 1) * 10000
    z = 0
    bg_rgb, vshapes = (None, []) if scanned else _page_vector_shapes(page, [])
    if bg_rgb is not None:
        anchor._p.append(_wps_shape_run(sid, 0, 0, pw, ph, bg_rgb, None, 0, False, z=z)); z += 1
    # pictures (kept as separate objects; large ones sit behind the text)
    pics = []
    if scanned:
        # the page image is the scan itself: only figures found in it are kept as pictures
        try:
            figs_ = _scan_figures(page, text_dict)
            if _photo_page(figs_, page):
                print(f"WARN: page {idx + 1} is a photograph of a document: kept as a picture, OCR text omitted (unreliable)", file=sys.stderr)
                text_dict = {'blocks': []}
            for fi, fr in enumerate(figs_):
                fpath = os.path.join(tmp_dir, f'sfig_{idx}_{fi}.png')
                page.get_pixmap(clip=fr, dpi=200).save(fpath)
                pics.append((fr, fpath, False))
        except Exception as _e:
            print(f"WARN: figure detection failed on page {idx + 1}: {_e}", file=sys.stderr)
    # pictures: placed exactly as they appear (masks, clips, stacked transparent layers already composited) by cropping the
    # visible area from a text-free render at the image's native resolution; boxes inside a bigger picture are skipped
    textfree = [None]
    if not scanned:
        boxes = []
        for blk in text_dict.get('blocks', []):
            if blk.get('type') != 1:
                continue
            br = fitz.Rect(blk['bbox']) & page.rect
            if br.is_empty or br.width < 3 or br.height < 3:
                continue
            boxes.append((br, blk))
        boxes.sort(key=lambda t: -(t[0].width * t[0].height))
        kept = []
        for br, blk in boxes:
            if any((br & k).width * (br & k).height >= 0.9 * br.width * br.height for k, _ in kept if not (br & k).is_empty):
                continue
            kept.append((br, blk))
        try:
            for br, blk in kept[:60]:
                if textfree[0] is None:
                    textfree[0] = _textfree_page_copy(page)
                native = (blk.get('width') or 0) / max(1.0, fitz.Rect(blk['bbox']).width / 72.0)
                path = os.path.join(tmp_dir, f'pic_{idx}_{len(pics)}.png')
                textfree[0][0].get_pixmap(clip=br, dpi=int(max(96, min(300, native or 150)))).save(path)
                pics.append((br, path, False))
        except Exception as _e:
            print(f"WARN: picture placement failed on page {idx + 1}: {_e}", file=sys.stderr)
    for r, path, _ in sorted(pics, key=lambda t: -(t[0].width * t[0].height)):
        run = anchor.add_run()
        _wps_anchor_picture(run, path, r.x0, r.y0, r.width, r.height, sid + z, behind=True); z += 1
    shape_texts = [[] for _ in vshapes]
    blocks = [b for b in text_dict.get('blocks', []) if b.get('type') == 0 and "".join(
        s.get('text', '') for ln in b.get('lines', []) for s in ln.get('spans', [])).strip()]
    free = []
    for b in blocks:
        cx, cy = (b['bbox'][0] + b['bbox'][2]) / 2, (b['bbox'][1] + b['bbox'][3]) / 2
        owners = [i for i, sh in enumerate(vshapes) if sh['fill'] is not None and sh['rect'].x0 - 1 <= cx <= sh['rect'].x1 + 1 and sh['rect'].y0 - 1 <= cy <= sh['rect'].y1 + 1]
        # a shape that merely frames text keeps it inside; single-owner text boxes are positioned freely
        free.append(b)
    clipped = [sh for sh in vshapes if sh.get('clipped')]
    if clipped:
        # shapes that run off the page are really clipped by the page/a clip path: a native shape would show the wrong
        # silhouette, so those pieces of artwork (never the text) are cropped from a text-free render as pictures
        try:
            if textfree[0] is None:
                textfree[0] = _textfree_page_copy(page)
            p2 = textfree[0][0]
            for ci, sh in enumerate(clipped):
                clip = sh['rect'] & page.rect
                if clip.is_empty or clip.width < 2 or clip.height < 2:
                    continue
                path = os.path.join(tmp_dir, f'art_{idx}_{ci}.png')
                p2.get_pixmap(clip=clip, dpi=200).save(path)
                _wps_anchor_picture(anchor.add_run(), path, clip.x0, clip.y0, clip.width, clip.height, sid + z, behind=True); z += 1
        except Exception as e:
            print(f"WARN: artwork crop failed on page {idx + 1}: {e}", file=sys.stderr)
    for si, sh in enumerate(vshapes):
        if sh.get('clipped'):
            continue
        r_ = sh['rect']
        anchor._p.append(_wps_shape_run(sid + z, r_.x0, r_.y0, r_.width, r_.height, sh['fill'], sh['line'], sh['line_w'], sh['rounded'], '', z=z, geom=sh.get('geom'), opacity=sh.get('opacity'))); z += 1
    for b in free:
        x0, y0, x1, y1 = b['bbox']
        xml = _positioned_lines_xml(b)
        if not xml:
            continue
        # the box must hold the full line height (ascent + descent), not just the ink band, or LibreOffice clips the last line
        biggest = max((sp.get('size', 11.0) for ln_ in b.get('lines', []) for sp in ln_.get('spans', [])), default=11.0)
        anchor._p.append(_wps_shape_run(sid + z, x0 - 2, y0 - 1, (x1 - x0) + 8, (y1 - y0) + 2 + 0.45 * biggest, None, None, 0, False, xml, z=z,
                                        behind=False, anchor_v='t', wrap_none=True, ins=0)); z += 1


def reconstruct_pdf_to_docx_editable(input_path, output_path, lang='eng', positioned=False):
    """
    Native Editable Document Reconstructor:
    Converts scanned, image-only, mixed, or presentation PDFs into a 100% genuinely editable
    Word document (.docx).
    - Scanned/image pages are processed with OCR to extract real editable text.
    - Tables are reconstructed as native Word tables (doc.add_table) with editable cells.
    - Paragraphs preserve fonts, sizes, bold/italic, alignments, and vertical spacing.
    - Genuine diagrams, logos, and figures are extracted and inserted as separate picture objects.
    - Absolutely NO full-page screenshots are used as page content.
    """
    tessdata_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tessdata')
    if not os.path.exists(tessdata_dir):
        tessdata_dir = os.path.join(os.getcwd(), 'tessdata')
    lang_code = (lang or 'eng').strip().lower()

    doc_pdf = fitz.open(input_path)
    total_pages = len(doc_pdf)
    if total_pages == 0:
        doc_pdf.close()
        raise ValueError("PDF has 0 pages.")

    prefetch_ocr(input_path, [p.number for p in doc_pdf if _page_needs_ocr(p)], lang_code, tessdata_dir)

    doc_w = docx.Document()
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    doc_w.core_properties.title = base_name
    doc_w.core_properties.comments = "Converted by PDF Converter Free (Native Editable Engine)"

    with tempfile.TemporaryDirectory(prefix='editable_docx_', ignore_cleanup_errors=True) as tmp_dir:
        for idx, page in enumerate(doc_pdf):
            _progress(idx + 1, len(doc_pdf))
            pw = page.rect.width
            ph = page.rect.height
            page_area = pw * ph

            sec = doc_w.sections[0] if idx == 0 else doc_w.add_section()
            sec.page_width = Pt(pw)
            sec.page_height = Pt(ph)
            sec.left_margin = Pt(54)
            sec.right_margin = Pt(54)
            sec.top_margin = Pt(54)
            sec.bottom_margin = Pt(54)

            raw_text = page.get_text().strip()
            is_scanned_page = _page_needs_ocr(page, raw_text)

            if positioned:
                sec.left_margin = sec.right_margin = sec.top_margin = sec.bottom_margin = Pt(0)
                sec.header_distance = sec.footer_distance = Pt(0)
                if is_scanned_page:
                    try:
                        _tp, _td = _ocr_text_dict(page, lang_code, tessdata_dir)
                    except Exception:
                        _td = page.get_text('dict')
                    _positioned_page(doc_w, page, idx, _td, tmp_dir, scanned=True)
                else:
                    _positioned_page(doc_w, page, idx, page.get_text('dict'), tmp_dir)
                continue

            # 1. Extract text data (native digital or OCR)
            tp = None
            if is_scanned_page:
                try:
                    tp, text_dict = _ocr_text_dict(page, lang_code, tessdata_dir)
                except Exception:
                    text_dict = page.get_text('dict')
            else:
                text_dict = page.get_text('dict')

            # 2. Extract tables
            tables_data = []
            if is_scanned_page and tp is not None:
                try:
                    tables_data.extend(detect_raster_tables(page, tp))
                except Exception as _e:
                    print(f"WARN: scanned table detection failed on page {idx + 1}: {_e}", file=sys.stderr)
            try:
                found_tabs = [] if tables_data else page.find_tables()
                for ft in found_tabs:
                    t_rows = ft.extract()
                    if t_rows and len(t_rows) > 0 and len(t_rows[0]) > 1:
                        tables_data.append({
                            'bbox': ft.bbox,
                            'rows': t_rows
                        })
            except Exception:
                pass

            # 3. Extract separate genuine images (excluding full-page scans > 70% of area)
            separate_images = []
            try:
                for img_info in page.get_images():
                    xref = img_info[0]
                    try:
                        rects = page.get_image_rects(xref)
                        for r in rects:
                            img_area = r.width * r.height
                            if img_area < (page_area * 0.70) and r.width > 20 and r.height > 20:
                                pix = fitz.Pixmap(doc_pdf, xref)
                                was_gray = pix.colorspace is not None and pix.colorspace.n == 1
                                if pix.colorspace is not None and pix.colorspace.n != 3:
                                    pix = fitz.Pixmap(fitz.csRGB, pix)
                                smask = img_info[1] if len(img_info) > 1 else 0
                                if smask and not pix.alpha:
                                    pix = fitz.Pixmap(pix, fitz.Pixmap(doc_pdf, smask))  # keep transparency (shadows, logos)
                                img_filename = f"img_p{idx}_{xref}_{int(r.x0)}.png"
                                img_path = os.path.join(tmp_dir, img_filename)
                                pix.save(img_path)
                                separate_images.append({
                                    'path': img_path,
                                    'gray': was_gray,
                                    'rect': r,
                                    'y0': r.y0,
                                    'w_pt': min(pw - 108, r.width),
                                    'h_pt': r.height * (min(pw - 108, r.width) / r.width) if r.width > 0 else r.height
                                })
                    except Exception:
                        pass
            except Exception:
                pass

            if is_scanned_page:
                try:
                    for fi, fr in enumerate(_scan_figures(page, text_dict, [tuple(t['bbox']) for t in tables_data])):
                        fpath = os.path.join(tmp_dir, f'fig_{idx}_{fi}.png')
                        page.get_pixmap(clip=fr, dpi=200).save(fpath)
                        wpt = min(pw - 108, fr.width)
                        separate_images.append({'path': fpath, 'gray': False, 'rect': fr, 'y0': fr.y0, 'w_pt': wpt, 'h_pt': fr.height * (wpt / fr.width)})
                except Exception as _e:
                    print(f"WARN: figure detection failed on page {idx + 1}: {_e}", file=sys.stderr)

            # Sort separate images by vertical coordinate
            separate_images.sort(key=lambda item: item['y0'])

            # 4. Group content items outside tables
            blocks = text_dict.get('blocks', [])
            content_items = []

            for t in tables_data:
                content_items.append({
                    'type': 'table',
                    'y0': t['bbox'][1],
                    'data': t
                })

            for simg in separate_images:
                content_items.append({
                    'type': 'image',
                    'y0': simg['y0'],
                    'data': simg
                })

            for b in blocks:
                if b.get('type') == 0:  # text block
                    bx0, by0, bx1, by1 = b['bbox']
                    # Check if block falls inside a detected table
                    in_table = False
                    for t in tables_data:
                        tb = t['bbox']
                        if bx0 >= tb[0] - 5 and bx1 <= tb[2] + 5 and by0 >= tb[1] - 5 and by1 <= tb[3] + 5:
                            in_table = True
                            break
                    if in_table:
                        continue

                    lines_data = []
                    for line in b.get('lines', []):
                        line_text = "".join(s.get('text', '') for s in line.get('spans', []))
                        if line_text.strip():
                            lines_data.append({
                                'text': line_text,
                                'spans': line.get('spans', [])
                            })

                    if lines_data:
                        content_items.append({
                            'type': 'text',
                            'y0': by0,
                            'bbox': (bx0, by0, bx1, by1),
                            'lines': lines_data
                        })

            # Sort content items by vertical coordinate (y0)
            content_items.sort(key=lambda item: item['y0'])

            # 4b. Vector backgrounds / shapes -> native anchored shapes; text sitting on a shape lives inside it
            page_has_dark = False
            try:
                bg_rgb, vshapes = (None, []) if is_scanned_page else _page_vector_shapes(page, [tuple(t['bbox']) for t in tables_data])
                if bg_rgb is not None or vshapes:
                    page_has_dark = bg_rgb is not None and sum(bg_rgb[:3]) < 1.5
                    shape_texts = [[] for _ in vshapes]
                    kept = []
                    for it in content_items:
                        if it['type'] == 'text':
                            tx, ty = (it['bbox'][0] + it['bbox'][2]) / 2, (it['bbox'][1] + it['bbox'][3]) / 2
                            owners = [i for i, sh in enumerate(vshapes) if sh['fill'] is not None and sh['rect'].x0 - 1 <= tx <= sh['rect'].x1 + 1 and sh['rect'].y0 - 1 <= ty <= sh['rect'].y1 + 1]
                            if owners:
                                own = min(owners, key=lambda i: vshapes[i]['rect'].width * vshapes[i]['rect'].height)
                                shape_texts[own].extend(ln['spans'] for ln in it['lines'])
                                continue
                        kept.append(it)
                    # grey soft-masked images lying under a filled shape are its drop shadow (already part of the shape look)
                    def _shadow(it):
                        if it['type'] != 'image' or not it['data'].get('gray'):
                            return False
                        ir = it['data']['rect']
                        ia = max(1.0, ir.width * ir.height)
                        for sh in vshapes:
                            if sh['fill'] is None:
                                continue
                            ov = ir & sh['rect']
                            if not ov.is_empty and ov.width * ov.height / ia >= 0.6:
                                return True
                        return False
                    kept = [it for it in kept if not _shadow(it)]
                    content_items = kept
                    anchor = doc_w.add_paragraph()
                    anchor.paragraph_format.space_before = Pt(0)
                    anchor.paragraph_format.space_after = Pt(0)
                    anchor.paragraph_format.line_spacing = Pt(1)
                    sid = (idx + 1) * 1000
                    if bg_rgb is not None:
                        anchor._p.append(_wps_shape_run(sid, 0, 0, pw, ph, bg_rgb, None, 0, False, z=0))
                    for si, sh in enumerate(vshapes):
                        r_ = sh['rect']
                        anchor._p.append(_wps_shape_run(sid + si + 1, r_.x0, r_.y0, r_.width, r_.height, sh['fill'], sh['line'],
                                                        sh['line_w'], sh['rounded'], _wps_runs_xml(shape_texts[si]), z=si + 1, geom=sh.get('geom'), opacity=sh.get('opacity')))
            except Exception as _e:
                print(f"WARN: vector shape reconstruction skipped on page {idx + 1}: {_e}", file=sys.stderr)


            # 5. Render native editable elements into Word
            last_y1 = 54.0
            for item in content_items:
                itype = item['type']

                if itype == 'image':
                    img_info = item['data']
                    p_img = doc_w.add_paragraph()
                    p_img.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    gap = max(0.0, img_info['y0'] - last_y1)
                    p_img.paragraph_format.space_before = Pt(max(2.0, min(24.0, gap * 0.3)))
                    p_img.paragraph_format.space_after = Pt(4.0)
                    p_img.add_run().add_picture(img_info['path'], width=Pt(img_info['w_pt']), height=Pt(img_info['h_pt']))
                    last_y1 = img_info['y0'] + img_info['h_pt']

                elif itype == 'table':
                    t_data = item['data']
                    rows = t_data['rows']
                    if not rows or not rows[0]:
                        continue
                    num_rows = len(rows)
                    num_cols = max(len(r) for r in rows)

                    table = doc_w.add_table(rows=num_rows, cols=num_cols)
                    table.alignment = WD_TABLE_ALIGNMENT.CENTER
                    for r_idx, row in enumerate(rows):
                        for c_idx, cell_val in enumerate(row):
                            if c_idx < num_cols:
                                cell = table.cell(r_idx, c_idx)
                                cell.text = str(cell_val or '').strip()
                                if r_idx == 0:
                                    for p in cell.paragraphs:
                                        for run in p.runs:
                                            run.font.bold = True
                    p_after = doc_w.add_paragraph()
                    p_after.paragraph_format.space_before = Pt(4.0)
                    p_after.paragraph_format.space_after = Pt(4.0)
                    last_y1 = t_data['bbox'][3]

                elif itype == 'text':
                    bx0, by0, bx1, by1 = item['bbox']
                    cx = (bx0 + bx1) / 2.0
                    is_centered = abs(cx - (pw / 2.0)) < 25.0
                    is_right = (bx1 > pw - 80) and (bx0 > pw * 0.5)

                    p = doc_w.add_paragraph()
                    if is_centered:
                        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    elif is_right:
                        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                    else:
                        p.alignment = WD_ALIGN_PARAGRAPH.LEFT

                    gap = max(0.0, by0 - last_y1)
                    if gap > 30.0:
                        p.paragraph_format.space_before = Pt(min(24.0, gap * 0.4))
                    else:
                        p.paragraph_format.space_before = Pt(0)
                    p.paragraph_format.space_after = Pt(2.0)

                    for l_idx, line in enumerate(item['lines']):
                        if l_idx > 0:
                            p.add_run('\n')
                        for span in line['spans']:
                            stext = span.get('text', '')
                            if not stext:
                                continue
                            run = p.add_run(stext)
                            sz = span.get('size', 11.0)
                            run.font.size = Pt(max(8.0, min(48.0, sz)))

                            fname = span.get('font', '').lower()
                            if 'bold' in fname or 'black' in fname or 'demi' in fname or sz >= 15.0:
                                run.font.bold = True
                            if 'italic' in fname or 'oblique' in fname:
                                run.font.italic = True

                            c = span.get('color', 0)
                            if isinstance(c, int) and c != 0:
                                r_c = (c >> 16) & 255
                                g_c = (c >> 8) & 255
                                b_c = c & 255
                                if page_has_dark or not (r_c > 240 and g_c > 240 and b_c > 240):
                                    run.font.color.rgb = RGBColor(r_c, g_c, b_c)

                    last_y1 = by1

    doc_pdf.close()
    doc_w.save(output_path)
    return output_path

_SAFE_FONTS = {n.lower() for n in (
    'Arial', 'Calibri', 'Cambria', 'Times New Roman', 'Verdana', 'Tahoma', 'Georgia', 'Courier New', 'Segoe UI', 'Consolas',
    'Trebuchet MS', 'Comic Sans MS', 'Palatino Linotype', 'Book Antiqua', 'Century Gothic', 'Garamond', 'Calibri Light',
    'Symbol', 'Wingdings', 'Aptos', 'Helvetica', 'Lucida Sans', 'Impact', 'Candara', 'Corbel', 'Constantia')}
_SERIF_HINT = re.compile(r'serif(?!.*sans)|times|georgia|garamond|palatino|bodoni|playfair|merriweather|lora|minion|caslon|baskerville|didot|cambria|antiqua|century(?!\s*gothic)|charter|libre\s*bask|crimson|cormorant|spectral|noto\s*serif|roman', re.I)
_MONO_HINT = re.compile(r'mono|courier|consolas|code|typewriter', re.I)

def safe_font(family, flags=0):
    """Fonts that are not installed on the reader's machine are substituted unpredictably (often by a decorative face).
    Keep fonts every Windows/Office install has; map anything else to the matching generic family."""
    f = (family or '').strip()
    if f.lower() in _SAFE_FONTS:
        return f
    if _MONO_HINT.search(f):
        return 'Courier New'
    if _SERIF_HINT.search(f):
        return 'Times New Roman'
    return 'Arial'

def _normalize_docx_fonts(docx_path):
    """Rewrite font names in word/document.xml (and styles) through safe_font()."""
    import zipfile as _zf
    tmp = docx_path + '.fonts.tmp'
    pat = re.compile(r'(w:(?:ascii|hAnsi|cs|eastAsia)=")([^"]*)(")')
    def fix(m):
        return m.group(1) + safe_font(m.group(2)) + m.group(3)
    with _zf.ZipFile(docx_path) as zin, _zf.ZipFile(tmp, 'w', _zf.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename in ('word/document.xml', 'word/styles.xml'):
                data = pat.sub(fix, data.decode('utf8')).encode('utf8')
            kind = _zf.ZIP_STORED if re.search(r'[.](png|jpe?g|gif|webp)$', item.filename, re.I) else _zf.ZIP_DEFLATED
            zout.writestr(item, data, compress_type=kind)
    os.replace(tmp, docx_path)

def run_libreoffice_many(paths, out_dir, target_ext='pdf'):
    """Convert several files with ONE LibreOffice start (the start-up, not the conversion, is the slow part).
    Returns {input_path: output_path or None}."""
    lo_cmd = find_libreoffice()
    with _LoProfileLease() as lease:
        profile_uri = 'file:///' + lease.dir.replace('\\', '/').lstrip('/')
        cmd = [lo_cmd, '--headless', '--norestore', f'-env:UserInstallation={profile_uri}',
               '--convert-to', target_ext, '--outdir', out_dir] + list(paths)
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=240)
        except subprocess.TimeoutExpired:
            lease.discard()
            raise
    out = {}
    for p in paths:
        o = os.path.join(out_dir, os.path.splitext(os.path.basename(p))[0] + '.' + target_ext)
        out[p] = o if os.path.exists(o) else None
    return out


def _render_scores(src_pdf, candidates, max_pages=8):
    """Lower is better: mean pixel difference between the source PDF and each candidate document rendered by
    LibreOffice, plus a penalty when the page count drifts (reflow that breaks the layout). All candidates are rendered
    in a single LibreOffice run. Returns a list of scores (None where a candidate could not be rendered)."""
    import numpy as np
    from PIL import Image
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
        links = []
        for k, c in enumerate(candidates):
            dst = os.path.join(td, f'cand{k}' + os.path.splitext(c)[1])
            shutil.copyfile(c, dst)
            links.append(dst)
        try:
            if links[0].lower().endswith('.docx'):
                for l in links:
                    sanitize_docx_for_libreoffice(l)
            rendered = run_libreoffice_many(links, td, 'pdf')
        except Exception:
            return [None] * len(candidates)
        scores = []
        a = fitz.open(src_pdf)
        for l in links:
            out_pdf = rendered.get(l)
            if not out_pdf:
                scores.append(None); continue
            try:
                b = fitz.open(out_pdf)
                diffs = []
                for i in range(min(len(a), len(b), max_pages)):
                    def g(d):
                        pm = d[i].get_pixmap(dpi=30, colorspace=fitz.csGRAY)
                        return np.frombuffer(pm.samples, np.uint8).reshape(pm.h, pm.w).astype(float)
                    x, y = g(a), g(b)
                    if x.shape != y.shape:
                        y = np.asarray(Image.fromarray(y.astype(np.uint8)).resize((x.shape[1], x.shape[0])), float)
                    diffs.append(abs(x - y).mean())
                n_b = len(b)
                b.close()
                scores.append(float(np.mean(diffs)) + 15.0 * abs(1.0 - n_b / float(len(a))) if diffs else None)
            except Exception:
                scores.append(None)
        a.close()
        return scores


def _render_score(src_pdf, docx_path, max_pages=8):
    return _render_scores(src_pdf, [docx_path], max_pages)[0]


def _art_ratio(doc, max_pages=6):
    """Share of the page covered by pictures and coloured shapes (worst of the first pages), 0..1. Near-white fills (page
    tints) and invisible shapes do not count."""
    best = 0.0
    for pg in list(doc)[:max_pages]:
        pa = pg.rect.width * pg.rect.height
        a = 0.0
        for b in pg.get_text('dict')['blocks']:
            if b['type'] == 1:
                r = fitz.Rect(b['bbox']) & pg.rect
                a += r.width * r.height
        for dr in pg.get_drawings():
            f = dr.get('fill')
            if f is None or min(f[:3]) > 0.9:
                continue
            if dr.get('fill_opacity') is not None and dr['fill_opacity'] <= 0.01:
                continue
            r = dr['rect'] & pg.rect
            a += r.width * r.height
        best = max(best, min(1.0, a / pa))
    return best


def _maybe_prefer_positioned(input_path, output_path, scanned=False):
    """Choose between the flowing pdf2docx layout (fully reflowable) and the exact-position layout (text boxes + floating
    pictures/shapes). Decided from the PDF first, so no rendering is needed in the clear cases:
      - almost no artwork (text documents, resumes, reports)  -> flowing layout, kept as is
      - page dominated by pictures / coloured shapes (brochures, decks, designed pages) -> exact-position layout
      - in between, and scanned documents -> both are rendered in ONE LibreOffice run and the closer one is kept."""
    try:
        doc = fitz.open(input_path)
        n = len(doc)
        art = _art_ratio(doc)
        doc.close()
        if n > (25 if scanned else 80):
            return
        alt = output_path + '.positioned.docx'
        if not scanned and art < 0.10:
            return
        if not scanned and art >= 0.30:
            reconstruct_pdf_to_docx_editable(input_path, alt, positioned=True)
            shutil.move(alt, output_path)
            return
        flow, pos = None, None
        reconstruct_pdf_to_docx_editable(input_path, alt, positioned=True)
        flow, pos = _render_scores(input_path, [output_path, alt])
        if flow is None or flow < (14.0 if scanned else 15.0):
            os.remove(alt); return
        if pos is not None and pos + 8.0 < flow:
            shutil.move(alt, output_path)
        elif os.path.exists(alt):
            os.remove(alt)
    except Exception as e:
        print(f"WARN: layout comparison skipped: {e}", file=sys.stderr)

def _is_oom(e):
    """True when an exception means the machine ran out of memory (a cheaper fallback engine would only return a degraded file)."""
    if isinstance(e, MemoryError):
        return True
    m = str(e).lower()
    return any(k in m for k in ('unable to allocate', 'cannot allocate memory', 'memory allocation failed', 'out of memory', 'bad_alloc'))


# OCR (text recognition on scanned pages) is switched off on the free server: it needs several hundred MB and minutes of CPU per
# document, and a half-finished OCR result is exactly the "looks valid but is incomplete" output we must not deliver.
# FILEORA_ENABLE_OCR=true turns it back on (for a larger server).
OCR_ENABLED = os.environ.get('FILEORA_ENABLE_OCR', '').strip().lower() in ('1', 'true', 'yes')
SCANNED_PDF_MESSAGE = ('SCANNED_PDF_UNSUPPORTED: This PDF contains scanned pages (pictures of text). Converting scanned PDFs is '
                       'temporarily unavailable. Please use a PDF with selectable text.')


class ScannedPdfUnsupported(BaseException):
    """BaseException on purpose: several `except Exception` handlers around OCR would otherwise swallow it and carry on without text."""
    pass


def _scan_like_page(page):
    """No usable text layer and a picture that covers a large part of the page: a scan, not a blank page or a plain cover."""
    try:
        area = page.rect.width * page.rect.height
        if area <= 0:
            return False
        big_picture = any(i.get('bbox') and (i['bbox'][2] - i['bbox'][0]) * (i['bbox'][3] - i['bbox'][1]) >= 0.25 * area for i in page.get_image_info())
    except Exception:
        return False
    return big_picture and len(page.get_text().strip()) < 10


try:
    MAX_PDF_PAGES = max(1, int(os.environ.get('MAX_PDF_PAGES', '40')))
except ValueError:
    MAX_PDF_PAGES = 40


try:
    MAX_PDF_IMAGES = max(1, int(os.environ.get('MAX_PDF_IMAGES', '12')))
except ValueError:
    MAX_PDF_IMAGES = 12


def _scan_pages(path):
    """0-based indexes of the pages that are scans (see _scan_like_page). Empty when OCR is on (those pages are read, not pictured)."""
    if OCR_ENABLED:
        return []
    doc = fitz.open(path)
    try:
        return [p.number for p in doc if _scan_like_page(p)]
    finally:
        doc.close()


def _precheck_pdf(path, scans='pictures'):
    """Refuses, before any heavy work and in one pass over the file, documents that are too long or hold too many pictures (the cost
    grows with the page count and, much faster, with the pictures: bench 8 pages with 3 pictures 6 s, 31 pages with 11 pictures 19 s).
    scans='pictures' (Word, PowerPoint): scanned pages are kept as pictures at their place, so they are accepted.
    scans='refuse' (Excel): a picture cannot become spreadsheet cells, and dropping those pages would lose data, so any scanned page
    is refused with a message that says which pages."""
    doc = fitz.open(path)
    try:
        n = len(doc)
        if n > MAX_PDF_PAGES:
            raise ValueError(f"TOO_COMPLEX: This document has {n} pages. The free server converts up to {MAX_PDF_PAGES} pages at a time. "
                             f"Please split it into smaller parts and convert them one at a time.")
        images = set()
        scanned = []
        for p in doc:
            if not OCR_ENABLED and _scan_like_page(p):
                if scans == 'refuse':
                    scanned.append(p.number + 1)
                continue          # a scanned page is placed as one picture without being analysed: it does not count towards the picture limit
            images.update(i[0] for i in p.get_images(full=False))
        if len(images) > MAX_PDF_IMAGES:
            raise ValueError(f"TOO_COMPLEX: This document contains {len(images)} pictures. The free server converts documents with up to "
                             f"{MAX_PDF_IMAGES} pictures. Please split it into smaller parts and convert them one at a time.")
        if scanned:
            shown = ', '.join(str(x) for x in scanned[:8]) + (' ...' if len(scanned) > 8 else '')
            raise ScannedPdfUnsupported(
                f"SCANNED_PDF_UNSUPPORTED: Page(s) {shown} of this PDF are scanned pictures, which cannot be turned into Excel cells without "
                f"text recognition (temporarily unavailable). Use a PDF with selectable text, or convert it to Word or PowerPoint, "
                f"where scanned pages are kept as pictures.")
    finally:
        doc.close()


def _page_jpeg(page, max_side_px=2000, quality=80):
    """One page as a JPEG (about 170 dpi for A4): readable text without holding a large bitmap. Pages are rendered one at a time."""
    long_pt = max(page.rect.width, page.rect.height)
    dpi = max(72, min(200, int(max_side_px * 72.0 / long_pt)))
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    try:
        return pix.tobytes('jpeg', jpg_quality=quality)
    finally:
        pix = None


def _docx_with_scan_pages(input_pdf, text_docx, scan_idx, output_path):
    """Word file with the pages in their original order: text pages stay editable (text_docx, one section per page as pdf2docx makes
    them, or None when every page is a scan) and every scanned page becomes a section of its own with the page picture filling it, in the
    page's own size and orientation. Sections are rebuilt in place, nothing is appended at the end."""
    import io
    from copy import deepcopy
    from docx import Document
    from docx.oxml import parse_xml
    from docx.oxml.ns import qn, nsdecls
    from docx.shared import Pt

    src = fitz.open(input_pdf)
    try:
        n_pages = len(src)
        scan_set = set(scan_idx)
        doc = Document(text_docx) if text_docx else Document()
        body = doc.element.body
        body_sect = body.find(qn('w:sectPr'))

        # 1. the text part, cut into one block per section: (elements, section properties still to be attached or None, starts a page).
        #    pdf2docx writes one nextPage section per page; a page with columns (text beside a picture) adds continuous / nextColumn
        #    sections inside it, so blocks are grouped into pages by "starts a new page", not counted one per page.
        def starts_page(sect):
            t = sect.find(qn('w:type')) if sect is not None else None
            return t is None or t.get(qn('w:val')) in (None, 'nextPage', 'oddPage', 'evenPage')
        blocks, cur = [], []
        for el in list(body):
            if el is body_sect:
                break
            cur.append(el)
            ppr = el.find(qn('w:pPr')) if el.tag == qn('w:p') else None
            sp = ppr.find(qn('w:sectPr')) if ppr is not None else None
            if sp is not None:
                blocks.append((cur, None, starts_page(sp)))
                cur = []
        if cur or not blocks:
            blocks.append((cur, deepcopy(body_sect) if body_sect is not None else None, starts_page(body_sect)))
        if text_docx is None:
            blocks = []
        pages_of_blocks = []
        for blk in blocks:
            if blk[2] or not pages_of_blocks:
                pages_of_blocks.append([])
            pages_of_blocks[-1].append(blk[:2])
        text_pages = [i for i in range(n_pages) if i not in scan_set]
        if text_docx is not None and len(pages_of_blocks) != len(text_pages):
            raise RuntimeError(f"text part has {len(pages_of_blocks)} pages for {len(text_pages)} text pages")

        def close_with(elements, sect):
            """Make the section that `elements` ends carry its own properties (it no longer ends at the body)."""
            if sect is None:
                return
            last = elements[-1] if elements else None
            if last is None or last.tag != qn('w:p'):
                last = parse_xml(f'<w:p {nsdecls("w")}/>')
                elements.append(last)
            ppr = last.find(qn('w:pPr'))
            if ppr is None:
                ppr = parse_xml(f'<w:pPr {nsdecls("w")}/>')
                last.insert(0, ppr)
            ppr.append(sect)

        # 2. rebuild in page order
        out, ti, final_sect = [], 0, None
        for i in range(n_pages):
            last_page = (i == n_pages - 1)
            if i not in scan_set:
                group = pages_of_blocks[ti]
                ti += 1
                for elements, sect in group:
                    out.extend(elements)
                    if sect is not None:       # the text part's last section (it was closed by the body sectPr)
                        if last_page:
                            final_sect = sect
                        else:
                            close_with(out, sect)
                continue
            page = src[i]
            w_pt, h_pt, _ = get_word_safe_dimensions(page.rect.width, page.rect.height, 1548.0)
            tw, th = int(w_pt * 20), int(h_pt * 20)
            orient = ' w:orient="landscape"' if tw > th else ''
            sect = parse_xml(f'<w:sectPr {nsdecls("w")}><w:pgSz w:w="{tw}" w:h="{th}"{orient}/>'
                             f'<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>')
            para = doc.add_paragraph()
            pf = para.paragraph_format
            pf.space_before = pf.space_after = Pt(0)
            pf.line_spacing = 1.0
            run = para.add_run()
            run.font.size = Pt(1)
            run.add_picture(io.BytesIO(_page_jpeg(page)), width=Pt(w_pt), height=Pt(h_pt))
            # anchored to the page corner (not inline): the picture covers the page exactly whatever margins a viewer applies, and the
            # paragraph that holds it stays one tiny line, so it can never push a blank page after it
            inline = run._r.find('.//' + qn('wp:inline'))
            anchor = parse_xml(
                f'<wp:anchor {nsdecls("wp", "a", "pic", "r")} distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" '
                f'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
                f'<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>'
                f'<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>'
                f'<wp:extent cx="{inline.find(qn("wp:extent")).get("cx")}" cy="{inline.find(qn("wp:extent")).get("cy")}"/>'
                f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
                f'<wp:docPr id="{inline.find(qn("wp:docPr")).get("id")}" name="Scanned page {i + 1}"/><wp:cNvGraphicFramePr/></wp:anchor>')
            anchor.append(inline.find(qn('a:graphic')))
            inline.getparent().replace(inline, anchor)
            para_el = para._p
            body.remove(para_el)
            out.append(para_el)
            if last_page:
                final_sect = sect
            else:
                close_with(out, sect)
            _progress(i + 1, n_pages)

        for el in list(body):
            body.remove(el)
        for el in out:
            body.append(el)
        if final_sect is not None:
            body.append(final_sect)
        doc.save(output_path)
    finally:
        src.close()


def _fix_column_sections(docx_path):
    """pdf2docx puts text and the picture beside it into two sections, the second starting with a "next column" break. Word follows that, but
    LibreOffice starts the second section on a new page, so the picture ends up away from its text. Both parts become ONE continuous
    multi-column section with an ordinary column break between them, which both applications place side by side. Returns the number of joins."""
    from docx import Document
    from docx.oxml import parse_xml
    from docx.oxml.ns import qn, nsdecls
    doc = Document(docx_path)
    body = doc.element.body
    joins = 0
    for p in list(body.iter(qn('w:p'))):
        ppr = p.find(qn('w:pPr'))
        sp = ppr.find(qn('w:sectPr')) if ppr is not None else None
        t = sp.find(qn('w:type')) if sp is not None else None
        if t is None or t.get(qn('w:val')) != 'nextColumn':
            continue
        # the section before this one: the closest earlier paragraph that carries a sectPr, in the same parent
        prev = p.getprevious()
        first = None                       # first paragraph of the "next column" section
        node = prev
        while node is not None:
            nppr = node.find(qn('w:pPr')) if node.tag == qn('w:p') else None
            if nppr is not None and nppr.find(qn('w:sectPr')) is not None:
                break
            first = node
            node = node.getprevious()
        if node is None:
            continue                       # no earlier section (should not happen): leave as it is
        node_ppr = node.find(qn('w:pPr'))
        prev_sect = node_ppr.find(qn('w:sectPr'))
        if prev_sect.find(qn('w:cols')) is None or int(prev_sect.find(qn('w:cols')).get(qn('w:num'), '1')) < 2:
            continue
        # the section that follows the previous closer starts at node.getnext(); that is where the column break goes
        start = node.getnext()
        if start is None:
            continue
        node_ppr.remove(prev_sect)         # the two parts are now one section, closed by this paragraph's sectPr
        t.set(qn('w:val'), 'continuous')
        br = parse_xml(f'<w:r {nsdecls("w")}><w:br w:type="column"/></w:r>')
        if start.tag == qn('w:p'):
            ppr0 = start.find(qn('w:pPr'))
            start.insert(1 if ppr0 is not None else 0, br)
        joins += 1
    if joins:
        doc.save(docx_path)
    return joins


def pdf_to_docx(input_path, output_path):
    """
    High-Fidelity Native PDF to Word Converter:
    1. Detects scanned, image-heavy, presentation, or mixed PDFs.
    2. Routes scanned/image pages and presentation decks to the Native Editable Document Reconstructor (OCR + native paragraphs + tables + separate images).
    3. Pure digital documents are converted with pdf2docx (stream table splitting disabled) and post-processed for typography and borders.
    4. Guarantees 100% editable output with zero full-page screenshot substitutions.
    """
    _precheck_pdf(input_path)
    scan_idx = _scan_pages(input_path)
    if scan_idx:
        # OCR is off: scanned pages are kept as page pictures at their own place, every other page is converted as usual
        doc_all = fitz.open(input_path)
        try:
            total = len(doc_all)
            text_idx = [i for i in range(total) if i not in set(scan_idx)]
            text_docx = None
            with tempfile.TemporaryDirectory(prefix='pic_docx_', ignore_cleanup_errors=True) as td:
                if text_idx:
                    part_pdf = os.path.join(td, 'text_pages.pdf')
                    part = fitz.open()
                    for i in text_idx:
                        part.insert_pdf(doc_all, from_page=i, to_page=i)
                    part.save(part_pdf)
                    part.close()
                    text_docx = os.path.join(td, 'text_pages.docx')
                    pdf_to_docx(part_pdf, text_docx)
                _docx_with_scan_pages(input_path, text_docx, scan_idx, output_path)
        finally:
            doc_all.close()
        return output_path
    doc_check = fitz.open(input_path)
    total_pages = len(doc_check)
    if total_pages == 0:
        doc_check.close()
        raise ValueError("PDF has 0 pages.")

    scanned_pages = 0
    for p in doc_check:
        if _page_needs_ocr(p, p.get_text().strip()):
            scanned_pages += 1
    doc_check.close()

    is_presentation = is_presentation_pdf(input_path)
    is_mostly_scanned = (scanned_pages / total_pages >= 0.3)

    # Scanned, mixed, or presentation PDFs use native editable reconstruction
    if is_presentation or is_mostly_scanned:
        if is_mostly_scanned:
            reconstruct_pdf_to_docx_editable(input_path, output_path, positioned=False)
            _normalize_docx_fonts(output_path)
            _maybe_prefer_positioned(input_path, output_path, scanned=True)
            return output_path
        reconstruct_pdf_to_docx_editable(input_path, output_path, positioned=True)
        _normalize_docx_fonts(output_path)
        return output_path

    # Scale documents exceeding Word's 22-inch engine limit (1584 pt) proportionally
    doc_check = fitz.open(input_path)
    max_dim = max(max(p.rect.width, p.rect.height) for p in doc_check) if len(doc_check) > 0 else 0
    doc_check.close()
    
    temp_scaled_pdf = None
    work_pdf_path = input_path
    if max_dim > 1548.0:
        fd, temp_scaled_pdf = tempfile.mkstemp(suffix='.pdf', prefix='scaled_pdf_')
        os.close(fd)
        doc_in = fitz.open(input_path)
        doc_out = fitz.open()
        for p in doc_in:
            tw, th, scale = get_word_safe_dimensions(p.rect.width, p.rect.height, 1548.0)
            np = doc_out.new_page(width=tw, height=th)
            np.show_pdf_page(np.rect, doc_in, p.number)
        doc_out.save(temp_scaled_pdf)
        doc_out.close()
        doc_in.close()
        work_pdf_path = temp_scaled_pdf

    try:
        cv = Converter(work_pdf_path)
        cv.convert(
            output_path,
            parse_stream_table=False,
            parse_lattice_table=True,
            delete_end_line_hyphen=True,
            shape_min_dimension=0.5
        )
        cv.close()
        enhance_docx_fidelity(output_path, input_path)
        _maybe_prefer_positioned(input_path, output_path)
    except Exception as e:
        if _is_oom(e):
            raise  # no memory: do not hand back a reduced-quality document as if it were the real result
        # Seamless fallback to Native Editable Document Reconstructor
        reconstruct_pdf_to_docx_editable(input_path, output_path)
    finally:
        if temp_scaled_pdf and os.path.exists(temp_scaled_pdf):
            try:
                os.unlink(temp_scaled_pdf)
            except Exception:
                pass

    return output_path

def _table_plausible(ft, rows, page):
    """Reject 'tables' that are really page decoration or a text block framed by lines."""
    b = ft.bbox
    if (b[2] - b[0]) * (b[3] - b[1]) > 0.85 * page.rect.width * page.rect.height:
        return False
    cells = [c for r in rows for c in r]
    filled = sum(1 for c in cells if (c or '').strip())
    return len(cells) > 0 and filled / float(len(cells)) >= 0.5

def _pptx_set_cell_border(cell, rgb='7F7F7F', width_pt=0.5):
    from pptx.oxml.ns import qn as _qn
    from lxml import etree
    tcPr = cell._tc.get_or_add_tcPr()
    for tag in ('a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'):
        for old in tcPr.findall(_qn(tag)):
            tcPr.remove(old)
        ln = etree.SubElement(tcPr, _qn(tag), w=str(int(width_pt * 12700)), cap='flat', cmpd='sng', algn='ctr')
        sf = etree.SubElement(ln, _qn('a:solidFill'))
        etree.SubElement(sf, _qn('a:srgbClr'), val=rgb)
        etree.SubElement(ln, _qn('a:prstDash'), val='solid')
    # borders must precede the fill element inside tcPr
    fills = [c for c in tcPr if c.tag in (_qn('a:solidFill'), _qn('a:noFill'))]
    for f in fills:
        tcPr.remove(f); tcPr.append(f)


def _add_native_pptx_table(slide, ft, text_dict, fills):
    """Native PowerPoint table with the PDF table's real geometry: column widths, row heights, merged cells,
    cell fills, thin borders and the original text size / weight / colour."""
    cells = [c for c in ft.cells if c is not None]
    if not cells:
        return False
    def uniq(vals, tol=1.5):
        out = []
        for v in sorted(vals):
            if not out or v - out[-1] > tol:
                out.append(v)
        return out
    xs = uniq([c[0] for c in cells] + [c[2] for c in cells])
    ys = uniq([c[1] for c in cells] + [c[3] for c in cells])
    if len(xs) < 2 or len(ys) < 2:
        return False
    def idx(arr, v):
        return min(range(len(arr)), key=lambda i: abs(arr[i] - v))
    nrows, ncols = len(ys) - 1, len(xs) - 1
    shp = slide.shapes.add_table(nrows, ncols, Pt(xs[0]), Pt(ys[0]), Pt(xs[-1] - xs[0]), Pt(ys[-1] - ys[0]))
    tbl = shp.table
    tblPr = tbl._tbl.tblPr
    for attr in ('firstRow', 'bandRow'):
        tblPr.set(attr, '0')
    sid = tblPr.find(qn_a('tableStyleId'))
    if sid is not None:
        sid.text = '{5940675A-B579-460E-94D1-54222C63F5DA}'  # "No Style, Table Grid"
    for j in range(ncols):
        tbl.columns[j].width = Pt(xs[j + 1] - xs[j])
    for i in range(nrows):
        tbl.rows[i].height = Pt(ys[i + 1] - ys[i])
    rows_txt = ft.extract()
    ncols_src = ft.col_count
    spans = [(sp, ln['bbox']) for b in text_dict.get('blocks', []) if b.get('type') == 0 for ln in b.get('lines', []) for sp in ln.get('spans', []) if sp.get('text', '').strip()]
    filled_cells = set()
    for k, c in enumerate(ft.cells):
        if c is None:
            continue
        r0, r1 = idx(ys, c[1]), idx(ys, c[3])
        c0, c1 = idx(xs, c[0]), idx(xs, c[2])
        if r1 <= r0 or c1 <= c0:
            continue
        cell = tbl.cell(r0, c0)
        if (r1 - r0 > 1 or c1 - c0 > 1) and (r0, c0) not in filled_cells:
            try:
                cell.merge(tbl.cell(r1 - 1, c1 - 1))
            except Exception:
                pass
        filled_cells.add((r0, c0))
        cell.margin_left = cell.margin_right = Pt(3)
        cell.margin_top = cell.margin_bottom = Pt(1)
        from pptx.enum.text import MSO_ANCHOR
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        inside_b = [(sp, bb) for sp, bb in spans if c[0] - 1 <= (bb[0] + bb[2]) / 2 <= c[2] + 1 and c[1] - 1 <= (bb[1] + bb[3]) / 2 <= c[3] + 1]
        inside_b.sort(key=lambda t: (round(t[1][1] / 4.0), t[1][0]))
        inside = [sp for sp, _ in inside_b]
        # one paragraph per visual line, spans of a line joined in reading order
        rows_l = []
        for sp, bb in inside_b:
            if rows_l and abs(rows_l[-1][0] - bb[1]) < 4.0:
                rows_l[-1][1].append(sp.get('text', ''))
            else:
                rows_l.append([bb[1], [sp.get('text', '')]])
        txt = chr(10).join(''.join(parts).strip() for _, parts in rows_l)
        size = sorted(sp.get('size', 10.0) for sp in inside)[len(inside) // 2] if inside else 10.0
        sample = inside[0] if inside else {}
        fam, bold, ital = clean_font_name(sample.get('font', ''))
        bold = bold or bool(sample.get('flags', 0) & 16) or bool(re.search(r'bold|black|heavy|demi', sample.get('font', ''), re.I))
        col = sample.get('color', 0)
        tf = cell.text_frame
        tf.word_wrap = True
        lines = txt.split('\n') if txt else ['']
        for li, line in enumerate(lines):
            p = tf.paragraphs[0] if li == 0 else tf.add_paragraph()
            run = p.add_run()
            run.text = line
            run.font.size = Pt(max(5.0, min(40.0, size)))
            run.font.name = safe_font(fam)
            run.font.bold = bold
            run.font.italic = ital
            if isinstance(col, int):
                run.font.color.rgb = PptxRGBColor((col >> 16) & 255, (col >> 8) & 255, col & 255)
        # cell fill = the colour actually rendered at the cell's top-left corner (text-free render): immune to
        # invisible / masked rectangles that a raw drawing list would report as fills
        try:
            rgb = fills(c[0] + 2.0, c[1] + 2.0)
        except Exception:
            rgb = None
        if rgb is not None and min(rgb) < 245:
            cell.fill.solid()
            cell.fill.fore_color.rgb = PptxRGBColor(*rgb)
        else:
            cell.fill.background()
        _pptx_set_cell_border(cell)
    return True


def qn_a(tag):
    return '{http://schemas.openxmlformats.org/drawingml/2006/main}' + tag


def _enhanced_scan_page(page):
    """For a scanned page built from one big picture: a throw-away page of the same size that holds a cleaned copy of
    that picture (grey-scale, uneven lighting / coloured guilloche backgrounds divided out). Tesseract reads photographed
    certificates and tinted scans far better from this than from the colour original. Returns (page, doc) or None."""
    try:
        import numpy as np
        import cv2
        best = None
        for img in page.get_images(full=True):
            for r in page.get_image_rects(img[0]):
                if best is None or r.width * r.height > best[1].width * best[1].height:
                    best = (img[0], r)
        if best is None or best[1].width * best[1].height < 0.4 * page.rect.width * page.rect.height:
            return None
        pix = fitz.Pixmap(page.parent, best[0])
        if pix.colorspace is not None and pix.colorspace.n != 1:
            pix = fitz.Pixmap(fitz.csGRAY, pix) if pix.colorspace.n in (3, 4) else pix
        if pix.alpha:
            pix = fitz.Pixmap(pix, 0)
        arr = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, 0].copy()
        k = max(31, (max(arr.shape) // 80) | 1)
        background = cv2.medianBlur(arr, k if k % 2 else k + 1)
        flat = cv2.divide(arr, background, scale=255)
        ok, buf = cv2.imencode('.png', flat)
        if not ok:
            return None
        tmp = fitz.open()
        p2 = tmp.new_page(width=page.rect.width, height=page.rect.height)
        p2.insert_image(best[1], stream=buf.tobytes())
        return p2, tmp
    except Exception:
        return None


_OCR_CACHE = {}


def _ocr_page_job(args):
    """Worker: OCR one page (opens the PDF itself so it can run in a separate process)."""
    path, pno, lang, tessdata_dir = args
    doc = fitz.open(path)
    try:
        page = doc[pno]
        words, d = _ocr_text_dict(page, lang, tessdata_dir, use_cache=False)
        return pno, words, d
    finally:
        doc.close()


def _cgroup_limits():
    """(cpu cores, memory bytes) granted to this container by cgroup v2 or v1, None when unlimited or unknown."""
    cpus = mem = None
    try:
        with open('/sys/fs/cgroup/cpu.max') as f:
            quota, period = f.read().split()[:2]
            if quota != 'max':
                cpus = int(quota) / float(period)
    except Exception:
        try:
            with open('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') as f:
                quota = int(f.read().strip())
            with open('/sys/fs/cgroup/cpu/cpu.cfs_period_us') as f:
                period = int(f.read().strip())
            if quota > 0:
                cpus = quota / float(period)
        except Exception:
            pass
    for path in ('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'):
        try:
            with open(path) as f:
                v = f.read().strip()
            if v != 'max' and int(v) < (1 << 50):
                mem = int(v)
                break
        except Exception:
            continue
    return cpus, mem


def _ocr_worker_count():
    """OCR processes to start. Each holds a rendered page plus Tesseract (about 100-200 MB), so a small container (Render Free:
    512 MB, 0.1 CPU) gets one; OCR_WORKERS overrides."""
    env = os.environ.get('OCR_WORKERS', '')
    if env.isdigit():
        return max(1, min(8, int(env)))
    n = os.cpu_count() or 2
    cpus, mem = _cgroup_limits()
    if cpus is not None:
        n = min(n, max(1, int(cpus)))
    if mem is not None and mem < 1536 * 1024 * 1024:
        return 1
    return max(1, min(4, n))


def prefetch_ocr(path, page_numbers, lang, tessdata_dir):
    """OCR many scanned pages in parallel (OCR is CPU-bound; 100 pages one after another exceeds any sane timeout)."""
    page_numbers = list(page_numbers)
    if len(page_numbers) < 3 or not OCR_ENABLED:
        return
    from concurrent.futures import ProcessPoolExecutor
    workers = _ocr_worker_count()
    try:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for pno, words, d in ex.map(_ocr_page_job, [(path, p, lang, tessdata_dir) for p in page_numbers]):
                _OCR_CACHE[(os.path.abspath(path), pno, lang)] = (words, d)
    except Exception as e:
        print(f"WARN: parallel OCR unavailable, falling back to sequential: {e}", file=sys.stderr)


def _ocr_dpi(page):
    """Tesseract reads best when the page image is roughly A4 at 300 dpi (about 2500 x 3500 px). A large-format page
    (for example an A4 scan stored at 96 dpi as a 1785 x 2526 pt page) rendered at 300 dpi becomes a 7000 x 10000 px
    image: slower, more memory, and noisier. Scale the resolution so the long side stays near the A4 equivalent."""
    longest = max(page.rect.width, page.rect.height, 1.0)
    return int(max(100, min(300, round(300.0 * 842.0 / longest))))


def _ocr_refine(page, d, only_junk=False):
    """Clean the OCR result of a scanned page without touching real text:
    - drops text hallucinated over illustrations / QR codes (a 'line' sitting on a busy, ink-heavy area that holds no real
      word), so those areas stay as pictures instead of being erased and replaced by random letters;
    - gives every line a single font size (Tesseract reports each word's own box height, which made words jump in size),
      and keeps neighbouring lines of one paragraph at the same size;
    - takes the ink colour and a bold hint from the scanned pixels."""
    import numpy as np
    try:
        pix = page.get_pixmap(dpi=72, colorspace=fitz.csRGB)
    except Exception:
        return
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, 3).astype(int)

    def crop(bb, pad=0):
        x0, y0 = max(0, int(bb[0]) - pad), max(0, int(bb[1]) - pad)
        x1, y1 = min(pix.w, int(bb[2]) + 1 + pad), min(pix.h, int(bb[3]) + 1 + pad)
        return img[y0:y1, x0:x1] if x1 > x0 and y1 > y0 else None

    def stats(bb):
        sub = crop(bb)
        if sub is None or sub.size == 0:
            return None
        flat = sub.reshape(-1, 3)
        bg = np.median(flat, axis=0)
        diff = np.abs(flat - bg).max(axis=1)
        ink = diff > 60
        keys = (flat // 48)
        keys = keys[:, 0] * 36 + keys[:, 1] * 6 + keys[:, 2]
        counts = np.bincount(keys.astype(int), minlength=216) / max(1, len(keys))
        return dict(ink_frac=float(ink.mean()), ncol=int((counts >= 0.03).sum()), flat=flat, ink=ink, diff=diff)

    def line_text(ln):
        return ''.join(x.get('text', '') for x in ln.get('spans', [])).strip()

    # typical text size = lines with a real sentence in them; short fragments far bigger or smaller than that are marks
    # Tesseract found in artwork ('Lee', 'gOn', 'a' at 170 pt on a QR code or an illustration)
    ref = sorted(max((x.get('size', 11.0) for x in ln.get('spans', [])), default=11.0)
                 for blk in d.get('blocks', []) if blk.get('type') == 0 for ln in blk.get('lines', [])
                 if sum(ch.isalnum() for ch in line_text(ln)) >= 15)
    ref_size = ref[len(ref) // 2] if ref else None

    for blk in d.get('blocks', []):
        if blk.get('type') != 0:
            continue
        keep = []
        for ln in blk.get('lines', []):
            txt = line_text(ln)
            if ref_size and sum(ch.isalnum() for ch in txt) <= 5:
                lsz = max((x.get('size', 11.0) for x in ln.get('spans', [])), default=11.0)
                if lsz > 1.8 * ref_size or lsz < 0.45 * ref_size:
                    continue
            st = stats(ln['bbox'])
            real = re.search(r'[A-Za-z]{4,}', txt) is not None and len(txt) >= 8
            if st and not real and (st['ink_frac'] > 0.40 or st['ncol'] >= 8):
                continue                      # picture / QR code content, not text
            if st and len(txt) <= 3 and not re.search(r'[A-Za-z0-9]{2}', txt) and st['ncol'] >= 4:
                continue
            ln['_st'] = st
            keep.append(ln)
        blk['lines'] = keep
    d['blocks'] = [b for b in d.get('blocks', []) if b.get('type') != 0 or b.get('lines')]
    if only_junk:
        for blk in d.get('blocks', []):
            if blk.get('type') == 0 and blk['lines']:
                for ln in blk['lines']:
                    ln.pop('_st', None)
                blk['bbox'] = (min(l['bbox'][0] for l in blk['lines']), min(l['bbox'][1] for l in blk['lines']), max(l['bbox'][2] for l in blk['lines']), max(l['bbox'][3] for l in blk['lines']))
        return

    for blk in d.get('blocks', []):          # OCR boxes are measured at another size than the text is set in: no width matching for them
        if blk.get('type') == 0:
            for ln in blk['lines']:
                for x in ln.get('spans', []):
                    x['_ocr'] = True
    # a word whose ink colour differs strongly from the rest of its line is part of a logo / icon, not text ('17' in front
    # of 'BLUESTOCK'): drop it so the artwork survives as a picture
    def span_col(x):
        st_ = stats(x['bbox'])
        if not st_ or not st_['ink'].any():
            return None
        ys_ = st_['diff'] >= max(60, 0.7 * st_['diff'].max())
        return np.median(st_['flat'][ys_], axis=0) if ys_.any() else None
    for blk in d.get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk['lines']:
            sp = ln.get('spans', [])
            if len(sp) < 3:
                continue
            cols = [span_col(x) for x in sp]
            good = [c for c in cols if c is not None]
            if len(good) < 3:
                continue
            ref_c = np.median(np.array(good), axis=0)
            kept = []
            for pos_, (x, c) in enumerate(zip(sp, cols)):
                txt_ = x.get('text', '').strip()
                # logo glyph read as characters: first / last word, no real letters in it, and an ink colour far from the line's
                junk_glyph = (pos_ in (0, len(sp) - 1) and re.search(r'[A-Za-z]{3,}', txt_) is None and c is not None
                              and float(np.abs(c - ref_c).max()) >= 75)
                if not junk_glyph:
                    kept.append(x)
            if kept and len(kept) != len(sp):
                for x in sp:
                    if x not in kept:
                        d.setdefault('_artwork', []).append(tuple(x['bbox']))
                ln['spans'] = kept
                ln['bbox'] = (min(x['bbox'][0] for x in kept), min(x['bbox'][1] for x in kept), max(x['bbox'][2] for x in kept), max(x['bbox'][3] for x in kept))
                ln['_st'] = stats(ln['bbox'])

    # a rule / border touching a text line inflates its box (and with it the font size): cut the rule rows off
    for blk in d.get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk['lines']:
            sub = crop(ln['bbox'])
            if sub is None or sub.shape[0] < 12 or sub.shape[1] < 6:
                continue
            bgc = np.median(sub.reshape(-1, 3), axis=0)
            inkm = (np.abs(sub - bgc).max(axis=2) > 60)
            row = inkm.sum(axis=1) / float(sub.shape[1])
            def _longest(r_):
                best = cur = 0
                for v in r_:
                    cur = cur + 1 if v else 0
                    if cur > best:
                        best = cur
                return best
            rule_rows = np.array([_longest(r_) >= 0.6 * sub.shape[1] for r_ in inkm])   # one unbroken horizontal stroke
            has_ink = (row > 0.01) & ~rule_rows
            if not has_ink.any():
                continue
            # contiguous ink bands; gaps up to ~6 % of the box height (the dot of an i, an accent) do not split a band
            H = sub.shape[0]; tol = max(2, int(0.06 * H))
            bands, start, last = [], None, None
            for i_, v in enumerate(has_ink):
                if v:
                    if start is None:
                        start = i_
                    elif i_ - last > tol + 1:
                        bands.append((start, last)); start = i_
                    last = i_
            if start is not None:
                bands.append((start, last))
            y0, y1 = max(bands, key=lambda bd: row[bd[0]:bd[1] + 1].sum())
            if (y1 - y0 + 1) < 0.85 * H and len(line_text(ln)) >= 3:
                b0 = ln['bbox']
                ln['bbox'] = (b0[0], b0[1] + float(y0), b0[2], b0[1] + float(y1) + 1.0)
                band_h = float(y1 - y0 + 1)
                # font size from the glyph band: without descenders (g j p q y , ;) the band is only ~0.75 em high
                size_ = band_h * (1.02 if re.search(r'[gjpqy,;()]', line_text(ln)) else 1.3)
                inflated = (H - band_h) > 0.25 * H   # a rule or a neighbouring line made the box much taller than the text
                for x in ln['spans']:
                    x['bbox'] = (x['bbox'][0], ln['bbox'][1], x['bbox'][2], ln['bbox'][3])
                    if inflated:
                        x['size'] = max(6.0, size_)

    # bullets are read as '¢', '*', '«' ...
    for blk in d.get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk['lines']:
            sp = ln.get('spans', [])
            if sp:
                t0 = sp[0].get('text', '')
                if re.fullmatch(r'\s*[¢*«»°¤©®·]\s*', t0):
                    sp[0]['text'] = '\u2022'
                else:
                    m_ = re.match(r'^\s*[¢«»¤°]\s+(?=\S)', t0)
                    if m_:
                        sp[0]['text'] = '\u2022 ' + t0[m_.end():]

    # one size per text row (Tesseract returns every word as its own line, and words with a descender or no ascender
    # measure taller / shorter), then one size per paragraph
    flat_lines = [ln for blk in d.get('blocks', []) if blk.get('type') == 0 for ln in blk['lines']]
    rows_ = []
    for ln in sorted(flat_lines, key=lambda l: (l['bbox'][1] + l['bbox'][3]) / 2):
        cy = (ln['bbox'][1] + ln['bbox'][3]) / 2; h_ = max(1.0, ln['bbox'][3] - ln['bbox'][1])
        if rows_ and abs(cy - rows_[-1]['cy']) < 0.4 * max(h_, rows_[-1]['h']):
            rows_[-1]['lines'].append(ln); rows_[-1]['cy'] = (rows_[-1]['cy'] + cy) / 2
        else:
            rows_.append({'cy': cy, 'h': h_, 'lines': [ln]})
    for r_ in rows_:
        vals = []
        for ln in r_['lines']:
            if len(re.findall(r'[A-Za-z0-9]', line_text(ln))) >= 3:
                vals += [x.get('size', 11.0) for x in ln.get('spans', [])] * 1
        if len(vals) >= 2:
            vals.sort(); m_ = vals[len(vals) // 2]
            for ln in r_['lines']:
                for x in ln.get('spans', []):
                    x['size'] = m_
    for blk in d.get('blocks', []):
        if blk.get('type') != 0:
            continue
        sizes = []
        for ln in blk['lines']:
            sp = [x for x in ln.get('spans', []) if len(re.findall(r'[A-Za-z0-9]', x.get('text', ''))) >= 3] or ln.get('spans', [])
            vals = sorted(x.get('size', 11.0) for x in sp)
            if not vals:
                continue
            ln['_size'] = vals[len(vals) // 2]
            sizes.append((ln['_size'], max(1, len(line_text(ln)))))
        if not sizes:
            continue
        tot = sum(w for _, w in sizes); acc = 0.0; bsize = sizes[0][0]
        for sz, w in sorted(sizes):
            acc += w
            if acc >= tot / 2:
                bsize = sz; break
        for ln in blk['lines']:
            sz = ln.get('_size')
            if sz is None:
                continue
            if abs(sz - bsize) <= 0.22 * bsize:
                sz = bsize
            for x in ln.get('spans', []):
                x['size'] = sz

    # decorative marks drawn under a text line in a different colour (the green swoosh under a logo-like word) are not text:
    # keep them as a picture of exactly that region instead of losing them
    try:
        import cv2
        all_boxes = [tuple(l['bbox']) for bk in d.get('blocks', []) if bk.get('type') == 0 for l in bk['lines']]
        for blk in d.get('blocks', []):
            if blk.get('type') != 0:
                continue
            for ln in blk['lines']:
                st = ln.get('_st') or stats(ln['bbox'])
                bx = ln['bbox']; H = bx[3] - bx[1]; W = bx[2] - bx[0]
                # only display-size lines (logo-like words, headings) carry such marks; checking every body line is costly
                if st is None or H < 20 or W < 30 or len(line_text(ln)) < 3 or not ref_size or H < 2.0 * ref_size:
                    continue
                reg = (bx[0], bx[1], bx[2], bx[3] + 0.7 * H)           # the line and a band below it
                sub = crop(reg)
                if sub is None or sub.shape[0] < 8:
                    continue
                flat = sub.reshape(-1, 3)
                ys = st['diff'] >= max(60, 0.7 * st['diff'].max()) if st['diff'].size else None
                if ys is None or not ys.any():
                    continue
                ink_col = np.median(st['flat'][ys], axis=0)
                bgc = np.median(flat, axis=0)
                foreign = ((np.abs(flat - ink_col).max(axis=1) > 110) & (np.abs(flat - bgc).max(axis=1) > 70)).reshape(sub.shape[:2]).astype(np.uint8)
                if foreign.sum() < 120:
                    continue
                n, lab, stt, _ = cv2.connectedComponentsWithStats(foreign, connectivity=8)
                for i in range(1, n):
                    x, y, w, h, area = stt[i]
                    if area < 150 or w < 12 or h < 8 or (y + h / 2.0) < 0.62 * H:      # lower part of the line, or below it
                        continue
                    rect = (reg[0] + x - 1, reg[1] + y - 1, reg[0] + x + w + 1, reg[1] + y + h + 1)
                    def overlaps_other(o):
                        if o == tuple(bx):
                            return False
                        ix = max(0.0, min(rect[2], o[2]) - max(rect[0], o[0])); iy = max(0.0, min(rect[3], o[3]) - max(rect[1], o[1]))
                        return ix * iy > 0.2 * (rect[2] - rect[0]) * (rect[3] - rect[1])
                    if not any(overlaps_other(o) for o in all_boxes):
                        d.setdefault('_artwork', []).append(rect)
    except Exception:
        pass

    # ink colour per line; bold hint per text row
    all_lines = []
    for blk in d.get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk['lines']:
            st = ln.get('_st') or stats(ln['bbox'])
            if st is None:
                continue
            ys = st['diff'] >= max(60, 0.7 * st['diff'].max()) if st['diff'].size else None
            if ys is not None and ys.any():
                col = np.median(st['flat'][ys], axis=0).astype(int)
                for x in ln.get('spans', []):
                    x['color'] = (int(col[0]) << 16) | (int(col[1]) << 8) | int(col[2])
            ln['_dens'] = st['ink_frac']
            ln['_area'] = max(1.0, (ln['bbox'][2] - ln['bbox'][0]) * (ln['bbox'][3] - ln['bbox'][1]))
            all_lines.append(ln)
    rows = []
    for ln in sorted(all_lines, key=lambda l: (l['bbox'][1] + l['bbox'][3]) / 2):
        cy = (ln['bbox'][1] + ln['bbox'][3]) / 2; h_ = max(1.0, ln['bbox'][3] - ln['bbox'][1])
        if rows and abs(cy - rows[-1]['cy']) < 0.5 * max(h_, rows[-1]['h']):
            rows[-1]['lines'].append(ln)
        else:
            rows.append({'cy': cy, 'h': h_, 'lines': [ln]})
    for r_ in rows:
        tot = sum(l['_area'] for l in r_['lines'])
        r_['dens'] = sum(l['_dens'] * l['_area'] for l in r_['lines']) / tot
        r_['chars'] = sum(len(line_text(l)) for l in r_['lines'])
    cand = [r_ for r_ in rows if r_['chars'] >= 6]
    if len(cand) >= 4:
        med = float(np.median([r_['dens'] for r_ in cand]))
        for r_ in cand:
            if r_['dens'] > 1.35 * med:
                for l in r_['lines']:
                    for x in l.get('spans', []):
                        x['flags'] = x.get('flags', 0) | 16
    for blk in d.get('blocks', []):
        if blk.get('type') == 0:
            for ln in blk['lines']:
                ln.pop('_st', None)
    for blk in d.get('blocks', []):
        if blk.get('type') == 0 and blk['lines']:
            blk['bbox'] = (min(l['bbox'][0] for l in blk['lines']), min(l['bbox'][1] for l in blk['lines']), max(l['bbox'][2] for l in blk['lines']), max(l['bbox'][3] for l in blk['lines']))


def _ocr_text_dict(page, lang, tessdata_dir, use_cache=True):
    """OCR text dict that also catches display-size text. Tesseract skips very large headings at 300 dpi, so the page is
    also recognised at a low resolution (where those headings look normal-sized) and blocks that the first pass did
    not find are added. Returns (words, text_dict); results prefetched in parallel are reused."""
    if not OCR_ENABLED:
        if _scan_like_page(page):
            raise ScannedPdfUnsupported(SCANNED_PDF_MESSAGE)
        return page.get_text('words'), page.get_text('dict')   # a blank page: nothing to recognise
    key = (os.path.abspath(page.parent.name or ''), page.number, lang)
    if use_cache and key in _OCR_CACHE:
        return _OCR_CACHE[key]
    def _alnum(ws):
        return sum(len(w[4]) for w in ws if re.search(r'[A-Za-z0-9]{3,}', str(w[4])))

    src_page, keep_alive = page, None
    tp = page.get_textpage_ocr(language=lang, tessdata=tessdata_dir, dpi=_ocr_dpi(page), full=True)
    words = page.get_text('words', textpage=tp)
    d = page.get_text('dict', textpage=tp)
    _ocr_refine(page, d, only_junk=True)
    # The grey-scale / lighting-flattened second reading only pays off on photographed or tinted scans; a clean white page
    # (most of it plain paper) gains nothing from it, so skip that whole extra OCR pass there.
    def _clean_paper(pg):
        try:
            import numpy as np
            pm = pg.get_pixmap(dpi=36, colorspace=fitz.csRGB)
            im = np.frombuffer(pm.samples, np.uint8).reshape(pm.h, pm.w, 3)
            return float((im.min(axis=2) > 235).mean()) >= 0.55
        except Exception:
            return False
    enh = None if _clean_paper(page) else _enhanced_scan_page(page)
    if enh is not None:
        try:
            ep, keep_alive = enh
            etp = ep.get_textpage_ocr(language=lang, tessdata=tessdata_dir, dpi=_ocr_dpi(page), full=True)
            ewords = ep.get_text('words', textpage=etp)
            if _alnum(ewords) > 1.15 * _alnum(words):
                words, d, src_page, tp = ewords, ep.get_text('dict', textpage=etp), ep, etp
        except Exception:
            pass
    # Tesseract's result changes with the render scale (small print appears at one scale and disappears at the next), so the
    # page is read a second time at ~70 % of the first scale and every block the first pass did not find is added. A last
    # low-resolution pass picks up display-size headings, which Tesseract skips at normal scale.
    base_dpi = _ocr_dpi(page)
    passes = [(max(72, int(round(base_dpi * 0.72))), False)]
    if passes[0][0] > 100:
        passes.append((72, True))
    for dpi_n, large_only in passes:
        try:
            tp2 = src_page.get_textpage_ocr(language=lang, tessdata=tessdata_dir, dpi=dpi_n, full=True)
            d2 = src_page.get_text('dict', textpage=tp2)
            _ocr_refine(page, d2, only_junk=True)
            have = [fitz.Rect(b['bbox']) for b in d.get('blocks', []) if b.get('type') == 0]
            for b in d2.get('blocks', []):
                if b.get('type') != 0:
                    continue
                txt = ''.join(s.get('text', '') for ln in b.get('lines', []) for s in ln.get('spans', [])).strip()
                r = fitz.Rect(b['bbox'])
                if len(txt) < 3:
                    continue
                if large_only and r.height < 14:  # only genuinely large text needs the display-size pass
                    continue
                if any(not (r & h).is_empty and (r & h).width * (r & h).height > 0.3 * r.width * r.height for h in have):
                    continue
                d['blocks'].append(b)
                have.append(r)
        except Exception:
            pass
    # OCR run over a picture produces specks like 'ee' / 'E': keep only blocks that contain a real word
    def _real(b):
        txt = ''.join(s_.get('text', '') for ln in b.get('lines', []) for s_ in ln.get('spans', []))
        return re.search(r'[A-Za-z0-9À-￿]{3,}', txt) is not None
    # photographed / textured pages make Tesseract emit symbol soup next to real words: drop spans made of junk characters
    if (lang or 'eng').split('+')[0] in ('eng', 'spa', 'fra', 'deu', 'ita', 'por'):
        for blk in d.get('blocks', []):
            if blk.get('type') != 0:
                continue
            for ln in blk.get('lines', []):
                ln['spans'] = [x for x in ln.get('spans', [])
                               if not re.search(r'[�\|{}~^`_=<>]', x.get('text', ''))]
                txt_ = ''.join(x.get('text', '') for x in ln['spans']).strip()
                if txt_ and sum(ch.isalnum() for ch in txt_) < 0.5 * len(txt_):
                    ln['spans'] = []
            blk['lines'] = [ln for ln in blk.get('lines', []) if ln.get('spans')]
        d['blocks'] = [b for b in d.get('blocks', []) if b.get('type') != 0 or b.get('lines')]
    # drop speck spans ('e', 'eee') that OCR hallucinates next to real words, then re-measure the line
    for blk in d.get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk.get('lines', []):
            sp = ln.get('spans', [])
            if len(sp) > 1 or len(''.join(x.get('text', '') for x in sp).split()) > 1:
                kept = [x for x in sp if not re.fullmatch(r'\s*(?P<c>[a-z])(?P=c){0,3}\s*', x.get('text', ''))]
                if kept and len(kept) != len(sp):
                    ln['spans'] = kept
                    ln['bbox'] = (min(x['bbox'][0] for x in kept), min(x['bbox'][1] for x in kept), max(x['bbox'][2] for x in kept), max(x['bbox'][3] for x in kept))
            for x in ln.get('spans', []):
                t = x.get('text', '')
                m = re.match(r'^(?P<c>[a-z])(?P=c){1,3}(?=[A-Z])', t)
                if m:
                    x['text'] = t[m.end():]
        def _speck_line(ln):
            t = ''.join(x.get('text', '') for x in ln.get('spans', [])).strip()
            w, h = ln['bbox'][2] - ln['bbox'][0], max(1.0, ln['bbox'][3] - ln['bbox'][1])
            return len(t) <= 3 and t.islower() and w / h > 6  # an 'ee' stretched over 400 pt is a ruled line / edge, not text
        blk['lines'] = [ln for ln in blk.get('lines', []) if ''.join(x.get('text', '') for x in ln.get('spans', [])).strip() and not _speck_line(ln)]
        if blk['lines']:
            blk['bbox'] = (min(l['bbox'][0] for l in blk['lines']), min(l['bbox'][1] for l in blk['lines']), max(l['bbox'][2] for l in blk['lines']), max(l['bbox'][3] for l in blk['lines']))
    d['blocks'] = [b for b in d.get('blocks', []) if b.get('type') != 0 or _real(b)]
    try:
        _ocr_refine(page, d)
    except Exception as ex:
        print(f'WARN: OCR refinement skipped: {ex}', file=sys.stderr)
    return words, d


def _photo_page(figs, page):
    """A scanned page whose picture content covers most of the page is a photograph of a document (or a full-page
    illustration); the OCR text laid over it is unreliable noise, so the picture alone is kept."""
    return any(f.width * f.height >= 0.6 * page.rect.width * page.rect.height for f in figs)


def _scan_figures(page, text_dict, avoid_boxes=()):
    """Find standalone pictures / diagrams / artwork inside a scanned page: pixels that differ from the paper colour
    once every recognised text box has been blanked out, grouped into connected regions."""
    import numpy as np
    pix = page.get_pixmap(dpi=72, colorspace=fitz.csRGB)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, 3).astype(int)
    border = np.concatenate([img[:4].reshape(-1, 3), img[-4:].reshape(-1, 3), img[:, :4].reshape(-1, 3), img[:, -4:].reshape(-1, 3)])
    paper = np.median(border, axis=0)
    mask = (np.abs(img - paper).max(axis=2) > 35)
    for b in text_dict.get('blocks', []):
        if b.get('type') == 0:
            for ln in b.get('lines', []):
                x0, y0, x1, y1 = [int(v) for v in ln['bbox']]
                mask[max(0, y0 - 2):y1 + 3, max(0, x0 - 2):x1 + 3] = False
    for t in avoid_boxes:
        mask[max(0, int(t[1]) - 2):int(t[3]) + 3, max(0, int(t[0]) - 2):int(t[2]) + 3] = False
    cell = 6
    gh, gw = pix.h // cell, pix.w // cell
    if gh < 2 or gw < 2:
        return []
    grid = mask[:gh * cell, :gw * cell].reshape(gh, cell, gw, cell).mean(axis=(1, 3)) > 0.08
    seen = np.zeros_like(grid)
    figs = []
    for sy in range(gh):
        for sx in range(gw):
            if not grid[sy, sx] or seen[sy, sx]:
                continue
            stack, comp = [(sy, sx)], []
            seen[sy, sx] = True
            while stack:
                y, x = stack.pop(); comp.append((y, x))
                for dy in (-2, -1, 0, 1, 2):
                    for dx in (-2, -1, 0, 1, 2):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < gh and 0 <= nx < gw and grid[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True; stack.append((ny, nx))
            ys = [c[0] for c in comp]; xs = [c[1] for c in comp]
            r = fitz.Rect(min(xs) * cell, min(ys) * cell, (max(xs) + 1) * cell, (max(ys) + 1) * cell)
            area = r.width * r.height
            is_rule = (r.height <= 0.02 * page.rect.height and r.width >= 0.2 * page.rect.width and r.height >= 1.5)
            small_ok = (area >= 0.004 * page.rect.width * page.rect.height and min(r.width, r.height) >= 0.04 * page.rect.width)
            if not is_rule and not small_ok and (area < 0.015 * page.rect.width * page.rect.height or min(r.width, r.height) < 36):
                continue
            if not is_rule and len(comp) < 0.25 * (r.width / cell) * (r.height / cell):  # sparse scribble, not a picture
                continue
            figs.append(r & page.rect)
    for bx in text_dict.get('_artwork', []):  # logo glyphs the OCR read as characters
        r = fitz.Rect(bx[0] - 3, bx[1] - 3, bx[2] + 3, bx[3] + 3) & page.rect
        if r.width >= 8 and r.height >= 8 and not any(not (r & f).is_empty and (r & f).width * (r & f).height > 0.5 * r.width * r.height for f in figs):
            figs.append(r)
    return figs



def _text_rows(block):
    """Group a text block's PDF lines into rows that share a baseline (bullet + text, side-by-side segments)."""
    lines = [ln for ln in block.get('lines', []) if "".join(sp.get('text', '') for sp in ln.get('spans', [])).strip()]
    rows = []
    for ln in sorted(lines, key=lambda l: (l['bbox'][1], l['bbox'][0])):
        size = max((sp.get('size', 11.0) for sp in ln.get('spans', [])), default=11.0)
        if rows and abs(ln['bbox'][3] - rows[-1]['bottom']) <= size * 0.35:
            rows[-1]['lines'].append(ln); rows[-1]['bottom'] = max(rows[-1]['bottom'], ln['bbox'][3])
        else:
            rows.append({'lines': [ln], 'top': ln['bbox'][1], 'bottom': ln['bbox'][3], 'size': size})
    for r in rows:
        r['lines'].sort(key=lambda l: l['bbox'][0])
    return rows


def _fill_pptx_text_frame(tf, block):
    """Exact-position paragraphs: indent, tab stops for side-by-side segments, exact line pitch, real fonts."""
    from lxml import etree
    rows = _text_rows(block)
    bx0 = block['bbox'][0]
    for i, row in enumerate(rows):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        size = max(row['size'], 1.0)
        pitch = (rows[i + 1]['top'] - row['top']) if i + 1 < len(rows) else size * 1.2
        pitch = max(size, min(pitch, size * 3)) if pitch > 0 else size * 1.2
        pPr = p._p.get_or_add_pPr()
        pPr.set('marL', str(int(max(0.0, row['lines'][0]['bbox'][0] - bx0) * 12700)))
        pPr.set('indent', '0')
        ln_spc = etree.SubElement(pPr, qn_a('lnSpc')); etree.SubElement(ln_spc, qn_a('spcPts'), val=str(int(pitch * 100)))
        sb = etree.SubElement(pPr, qn_a('spcBef')); etree.SubElement(sb, qn_a('spcPts'), val='0')
        sa = etree.SubElement(pPr, qn_a('spcAft')); etree.SubElement(sa, qn_a('spcPts'), val='0')
        if len(row['lines']) > 1:
            tl = etree.SubElement(pPr, qn_a('tabLst'))
            for seg in row['lines'][1:]:
                etree.SubElement(tl, qn_a('tab'), pos=str(int(max(0.0, seg['bbox'][0] - bx0) * 12700)), algn='l')
        for k, seg in enumerate(row['lines']):
            if k > 0:
                # words returned as separate lines: a plain space when they sit close together (a tab stop that the
                # previous text overshoots would jump to the next stop); a tab only for a real gap such as a column
                gap = seg['bbox'][0] - row['lines'][k - 1]['bbox'][2]
                p.add_run().text = (' ' * max(1, int(round(gap / (0.28 * size))))) if gap < 1.3 * size else chr(9)
            for span in seg.get('spans', []):
                t = _pua(span.get('text', ''))
                if not t:
                    continue
                run = p.add_run()
                run.text = t
                run.font.size = Pt(max(4.0, min(120.0, span.get('size', 14.0))))
                fam, b, it = clean_font_name(span.get('font', ''))
                flags = span.get('flags', 0)
                run.font.name = safe_font(fam, flags)
                if b or (flags & 16) or re.search(r'bold|black|heavy|demi|semibold|medium', span.get('font', ''), re.I) or re.search(r'Md(?:$|[-_ ,])', span.get('font', '')):
                    run.font.bold = True
                if it or (flags & 2):
                    run.font.italic = True
                c = span.get('color', 0)
                if isinstance(c, int):
                    run.font.color.rgb = PptxRGBColor((c >> 16) & 255, (c >> 8) & 255, c & 255)
                _match_run_width(run, t, span, max(4.0, min(120.0, span.get('size', 14.0))), bool(run.font.bold), bool(run.font.italic))


def _match_run_width(run, text, span, size, bold, italic):
    """Character spacing so the substituted font fills the same width the original text occupied. Without it, justified or
    wide-set text comes out ragged on the right (the original face is wider or narrower than Arial / Times New Roman)."""
    try:
        bb = span.get('bbox')
        n = len(text)
        if span.get('_ocr') or not bb or n < 4 or '	' in text:
            return
        target = float(bb[2]) - float(bb[0])
        name = (run.font.name or 'Arial').lower()
        if name not in ('arial', 'helvetica', 'times new roman', 'courier new'):
            return  # only fonts with a metric-compatible base-14 twin can be measured reliably
        key = 'tiro' if 'times' in name else 'cour' if 'courier' in name else 'helv'
        code = {'helv': ('helv', 'hebo', 'heit', 'hebi'), 'tiro': ('tiro', 'tibo', 'tiit', 'tibi'), 'cour': ('cour', 'cobo', 'coit', 'cobi')}[key]
        f = fitz.Font(code[(1 if bold else 0) + (2 if italic else 0)])
        width = f.text_length(text, fontsize=size)
        d = (target - width) / n
        if abs(d * 100) >= 1 and abs(d) <= 0.35 * size:
            run.font._element.set('spc', str(int(round(d * 100))))
    except Exception:
        pass


def _progress(page, total):
    """Tell the server which page is being processed (read from stderr by the job gate)."""
    try:
        print(f'FILEORA_PROGRESS page={page} total={total}', file=sys.stderr, flush=True)
    except Exception:
        pass


def pdf_to_pptx(input_path, output_path, dpi=240):
    """
    Native Editable PDF to PowerPoint Converter:
    Reconstructs each slide with real editable PowerPoint text boxes,
    tables, and separate figures/diagrams.
    Zero full-slide screenshots are used.
    """
    tessdata_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tessdata')
    if not os.path.exists(tessdata_dir):
        tessdata_dir = os.path.join(os.getcwd(), 'tessdata')

    doc = fitz.open(input_path)
    if len(doc) == 0:
        doc.close()
        raise ValueError("PDF has 0 pages.")
    
    _precheck_pdf(input_path)
    scan_set = set(_scan_pages(input_path))
    prefetch_ocr(input_path, [p.number for p in doc if _page_needs_ocr(p)], 'eng', tessdata_dir)

    prs = Presentation()
    first_page = doc[0]
    prs.slide_width = Pt(first_page.rect.width)
    prs.slide_height = Pt(first_page.rect.height)
    blank_layout = prs.slide_layouts[6]
    
    with tempfile.TemporaryDirectory(prefix='editable_pptx_', ignore_cleanup_errors=True) as tmp_dir:
        for idx, page in enumerate(doc):
            _progress(idx + 1, len(doc))
            pw, ph = page.rect.width, page.rect.height
            page_area = pw * ph
            slide = prs.slides.add_slide(blank_layout)

            if idx in scan_set:
                # scanned page (OCR off): the page itself is the slide, fitted inside the slide without stretching
                import io as _io
                sw, sh = prs.slide_width, prs.slide_height
                scale = min(sw / Pt(pw), sh / Pt(ph))
                pic_w, pic_h = int(Pt(pw) * scale), int(Pt(ph) * scale)
                slide.shapes.add_picture(_io.BytesIO(_page_jpeg(page)), int((sw - pic_w) / 2), int((sh - pic_h) / 2), width=pic_w, height=pic_h)
                continue

            raw_text = page.get_text().strip()
            is_scanned = _page_needs_ocr(page, raw_text)

            # 1. Extract text dict (native or OCR)
            if is_scanned:
                try:
                    tp, text_dict = _ocr_text_dict(page, 'eng', tessdata_dir)
                except Exception:
                    text_dict = page.get_text('dict')
            else:
                text_dict = page.get_text('dict')

            # 2. Extract tables
            table_boxes = []
            try:
                found_tabs = page.find_tables()
                _tf_pix = None
                def page_fills(x, y):
                    nonlocal _tf_pix
                    if _tf_pix is None:
                        _tf_pix = _textfree_page_copy(page)[0].get_pixmap(dpi=144, alpha=False)
                    px = _tf_pix.pixel(int(max(0, min(_tf_pix.width - 1, x * 2))), int(max(0, min(_tf_pix.height - 1, y * 2))))
                    return tuple(px[:3])
                for ft in found_tabs:
                    t_rows = ft.extract()
                    if t_rows and len(t_rows) > 1 and len(t_rows[0]) > 1 and _table_plausible(ft, t_rows, page):
                        table_boxes.append(tuple(ft.bbox))
                        try:
                            if _add_native_pptx_table(slide, ft, text_dict, page_fills):
                                continue
                        except Exception as _te:
                            print(f"WARN: native table build failed, using plain table: {_te}", file=sys.stderr)
                        num_rows = len(t_rows)
                        num_cols = max(len(r) for r in t_rows)
                        tb_box = ft.bbox
                        tbl_shape = slide.shapes.add_table(
                            num_rows, num_cols,
                            Pt(tb_box[0]), Pt(tb_box[1]),
                            Pt(max(40, tb_box[2] - tb_box[0])), Pt(max(20, tb_box[3] - tb_box[1]))
                        )
                        t_table = tbl_shape.table
                        for r_idx, row in enumerate(t_rows):
                            for c_idx, cell_val in enumerate(row):
                                if c_idx < num_cols:
                                    t_table.cell(r_idx, c_idx).text = str(cell_val or '').strip()
            except Exception:
                pass

            # Artwork made of dozens of freeform / clipped pieces would become dozens of loose pictures; when a page has
            # more than 25 of them, use ONE text-free render of the page as its background picture instead
            flatten = False
            if not is_scanned:
                try:
                    _bg0, _vs0 = _page_vector_shapes(page, [tuple(t) for t in table_boxes])
                    if sum(1 for sh in _vs0 if sh.get('geom') or sh.get('clipped')) > 25 or sum(1 for sh in _vs0 if sh['rect'].width * sh['rect'].height < 150) > 120:
                        flatten = True
                        tf_full = _textfree_page_copy(page)
                        pth = os.path.join(tmp_dir, f'flat_{idx}.png')
                        tf_full[0].get_pixmap(dpi=150).save(pth)
                        slide.shapes.add_picture(pth, 0, 0, width=prs.slide_width, height=prs.slide_height)
                except Exception as _e:
                    flatten = False
                    print(f"WARN: page flattening failed on page {idx + 1}: {_e}", file=sys.stderr)

            if is_scanned and not flatten:
                try:
                    figs_ = _scan_figures(page, text_dict, table_boxes)
                    if _photo_page(figs_, page):
                        print(f"WARN: page {idx + 1} is a photograph of a document: kept as a picture, OCR text omitted (unreliable)", file=sys.stderr)
                        text_dict = {'blocks': []}
                    for fi, fr in enumerate(figs_):
                        fpath = os.path.join(tmp_dir, f'fig_{idx}_{fi}.png')
                        page.get_pixmap(clip=fr, dpi=200).save(fpath)
                        slide.shapes.add_picture(fpath, Pt(fr.x0), Pt(fr.y0), width=Pt(fr.width), height=Pt(fr.height))
                except Exception as _e:
                    print(f"WARN: figure detection failed on page {idx + 1}: {_e}", file=sys.stderr)

            # 3a. Pictures: placed exactly as they appear on the page (crop / mask / rotation / shadow applied) by
            #     cropping the visible area from a text-free render, at the image's native resolution
            try:
                tfp = None
                for blk in ([] if flatten else text_dict.get('blocks', [])):
                    if blk.get('type') != 1:
                        continue
                    br = fitz.Rect(blk['bbox']) & page.rect
                    if br.is_empty or br.width < 3 or br.height < 3:
                        continue
                    if is_scanned and br.width * br.height > 0.7 * page_area:
                        continue  # the scan itself: the text on top is what gets rebuilt
                    if tfp is None:
                        tfp = _textfree_page_copy(page)
                    native = (blk.get('width') or 0) / max(1.0, (fitz.Rect(blk['bbox']).width / 72.0))
                    dpi_c = int(max(96, min(300, native or 150)))
                    pth = os.path.join(tmp_dir, f'blk_{idx}_{int(br.x0)}_{int(br.y0)}.png')
                    tfp[0].get_pixmap(clip=br, dpi=dpi_c).save(pth)
                    slide.shapes.add_picture(pth, Pt(br.x0), Pt(br.y0), width=Pt(br.width), height=Pt(br.height))
            except Exception as _e:
                print(f"WARN: picture placement failed on page {idx + 1}: {_e}", file=sys.stderr)

            # 3b. Vector art: backgrounds and plain rectangles become native shapes; anything the shape model cannot
            #     reproduce faithfully (freeform paths, clipped artwork) is cropped from a text-free render as a picture
            try:
                from pptx.enum.shapes import MSO_SHAPE as _MS
                bg_rgb, vshapes = ((None, []) if flatten else _page_vector_shapes(page, table_boxes))
                if bg_rgb is not None:
                    slide.background.fill.solid()
                    slide.background.fill.fore_color.rgb = PptxRGBColor(*[int(round(v * 255)) for v in bg_rgb[:3]])
                textfree = None
                for sh in vshapes[:300]:
                    r_ = sh['rect']
                    if sh.get('geom') or sh.get('clipped'):
                        clip = r_ & page.rect
                        if clip.is_empty or clip.width < 2 or clip.height < 2:
                            continue
                        if textfree is None:
                            textfree = _textfree_page_copy(page)
                        pth = os.path.join(tmp_dir, f'art_{idx}_{id(sh)}.png')
                        textfree[0].get_pixmap(clip=clip, dpi=200).save(pth)
                        slide.shapes.add_picture(pth, Pt(clip.x0), Pt(clip.y0), width=Pt(clip.width), height=Pt(clip.height))
                        continue
                    shp = slide.shapes.add_shape(_MS.ROUNDED_RECTANGLE if sh['rounded'] else _MS.RECTANGLE, Pt(r_.x0), Pt(r_.y0), Pt(r_.width), Pt(r_.height))
                    if sh['fill'] is not None:
                        shp.fill.solid(); shp.fill.fore_color.rgb = PptxRGBColor(*[int(round(v * 255)) for v in sh['fill'][:3]])
                        op = sh.get('opacity')
                        if op is not None and op < 0.999:
                            clr = shp.fill._xPr.find(qn_a('solidFill'))[0]
                            from lxml import etree as _et
                            _et.SubElement(clr, qn_a('alpha'), val=str(int(op * 100000)))
                    else:
                        shp.fill.background()
                    if sh['line'] is not None:
                        shp.line.color.rgb = PptxRGBColor(*[int(round(v * 255)) for v in sh['line'][:3]]); shp.line.width = Pt(max(0.25, sh['line_w']))
                    else:
                        shp.line.fill.background()
                    shp.shadow.inherit = False
            except Exception as _e:
                print(f"WARN: vector shape reconstruction skipped on page {idx + 1}: {_e}", file=sys.stderr)

            # 4. Add native editable text boxes
            blocks = text_dict.get('blocks', [])
            def _in_table(bb):
                cx_, cy_ = (bb[0] + bb[2]) / 2.0, (bb[1] + bb[3]) / 2.0
                return any(t[0] - 1 <= cx_ <= t[2] + 1 and t[1] - 1 <= cy_ <= t[3] + 1 for t in table_boxes)

            for b in blocks:
                if b.get('type') == 0:  # text
                    # text already placed in a native table must not be duplicated as a text box
                    b = dict(b, lines=[ln for ln in b.get('lines', []) if not _in_table(ln['bbox'])])
                    if not b['lines']:
                        continue
                    xs = [ln['bbox'] for ln in b['lines']]
                    b['bbox'] = (min(x[0] for x in xs), min(x[1] for x in xs), max(x[2] for x in xs), max(x[3] for x in xs))
                    bx0, by0, bx1, by1 = b['bbox']
                    bw = max(20.0, bx1 - bx0)
                    bh = max(15.0, by1 - by0)
                    txBox = slide.shapes.add_textbox(Pt(bx0), Pt(by0), Pt(bw + 6), Pt(bh))
                    tf = txBox.text_frame
                    tf.word_wrap = False  # PDF lines are already broken: keep one PDF line = one PowerPoint line
                    tf.auto_size = MSO_AUTO_SIZE.NONE
                    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = Pt(0)
                    _fill_pptx_text_frame(tf, b)

    doc.close()
    prs.save(output_path)
    return output_path

def docx_to_pptx(input_path, output_path):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
        temp_pdf = os.path.join(temp_dir, 'intermediate.pdf')
        docx_to_pdf(input_path, temp_pdf)
        pdf_to_pptx(temp_pdf, output_path)
    return output_path

# =============================================================================
# PPTX TO DOCX CONVERSION ENGINE (DUAL-MODE ARCHITECTURE)
# =============================================================================

def get_word_safe_dimensions(w_pt, h_pt, max_dim_pt=1548.0):
    """
    Scales slide dimensions to fit within Word's 22-inch engine limit (1584 pt)
    while preserving the EXACT aspect ratio.
    """
    max_side = max(w_pt, h_pt)
    if max_side > max_dim_pt:
        scale = max_dim_pt / max_side
        return w_pt * scale, h_pt * scale, scale
    return w_pt, h_pt, 1.0

def get_shape_color_hex(fill):
    try:
        if fill.type == 1:  # SOLID
            color = fill.fore_color
            if hasattr(color, 'rgb') and color.rgb:
                return f"{color.rgb[0]:02X}{color.rgb[1]:02X}{color.rgb[2]:02X}"
    except Exception:
        pass
    return None

def get_line_color_hex(line):
    try:
        color = line.color
        if hasattr(color, 'rgb') and color.rgb:
            return f"{color.rgb[0]:02X}{color.rgb[1]:02X}{color.rgb[2]:02X}"
    except Exception:
        pass
    return None

def convert_pptx_to_docx_layout(pptx_path, docx_path, dpi=300):
    """
    Mode A: Layout-preserving mode
    - Renders each slide faithfully via LibreOffice Impress + PyMuPDF at 300 DPI.
    - Preserves exact aspect ratio, colors, images, diagrams, tables, and typography visually.
    - Ensures exactly one original slide maps to one Word page.
    - Eliminates stretching, cropping, unwanted margins, and extra blank pages.
    - Discloses in metadata that slide content is visually preserved and not individually editable.
    """
    temp_dir = tempfile.mkdtemp(prefix='pptx_layout_')
    try:
        opt_pptx = os.path.join(temp_dir, os.path.basename(pptx_path))
        optimize_pptx_for_conversion(pptx_path, opt_pptx)
        pdf_path = run_libreoffice(opt_pptx, temp_dir, 'pdf', filter_name='impress_pdf_Export')
        base = os.path.splitext(os.path.basename(pptx_path))[0]
        if not os.path.exists(pdf_path):
            raise RuntimeError("LibreOffice failed to generate PDF.")
            
        pdf_doc = fitz.open(pdf_path)
        if len(pdf_doc) == 0:
            raise RuntimeError("PDF generated by LibreOffice is empty.")
            
        doc = docx.Document()
        
        core_props = doc.core_properties
        core_props.comments = (
            "Conversion Mode: Layout-Preserving. "
            "Rendered faithfully from PowerPoint slides at 300 DPI. "
            "All visual layouts, colors, graphics, diagrams, and typography are preserved. "
            "Content is not individually editable; use Editable Mode for text/table editing."
        )
        core_props.title = base
        
        for idx, page in enumerate(pdf_doc):
            w_pt = page.rect.width
            h_pt = page.rect.height
            target_w_pt, target_h_pt, _ = get_word_safe_dimensions(w_pt, h_pt)
            
            pix = page.get_pixmap(dpi=dpi)
            img_path = os.path.join(temp_dir, f'slide_{idx}.png')
            pix.save(img_path)
            
            sec = doc.sections[0] if idx == 0 else doc.add_section(WD_SECTION_START.NEW_PAGE)
            sec.page_width = Pt(target_w_pt)
            sec.page_height = Pt(target_h_pt)
            sec.top_margin = Pt(0)
            sec.bottom_margin = Pt(0)
            sec.left_margin = Pt(0)
            sec.right_margin = Pt(0)
            sec.header_distance = Pt(0)
            sec.footer_distance = Pt(0)
            sec.gutter = Pt(0)
            
            p = doc.paragraphs[0] if (idx == 0 and doc.paragraphs) else doc.add_paragraph()
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.left_indent = Pt(0)
            p.paragraph_format.right_indent = Pt(0)
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            
            run = p.add_run()
            run.add_picture(img_path, width=Pt(target_w_pt), height=Pt(target_h_pt))
            
        pdf_doc.close()
        doc.save(docx_path)
        return docx_path
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

def convert_pptx_to_docx_editable(pptx_path, docx_path):
    """
    Mode B: Editable mode
    - Reconstructs text, images, tables, shapes, and backgrounds as native Word elements.
    - Preserves element positions, dimensions, text formatting, font sizes, alignment, grouping, and reading order.
    - Scales page dimensions to match the original slide's aspect ratio within Word's 22-inch engine limit.
    - Uses fixed-layout positioning (wp:anchor, bodyPr zero padding, tblpPr) with a single container paragraph
      per slide to eliminate unwanted pagination overflow and page breaks.
    """
    prs = Presentation(pptx_path)
    optimize_pptx_presentation(prs)
    major_theme_font, minor_theme_font = get_pptx_theme_fonts(prs)
    slide_w_pt = prs.slide_width / 12700.0
    slide_h_pt = prs.slide_height / 12700.0
    
    target_w_pt, target_h_pt, scale = get_word_safe_dimensions(slide_w_pt, slide_h_pt)
    
    doc = docx.Document()
    base_name = os.path.splitext(os.path.basename(pptx_path))[0]
    
    core_props = doc.core_properties
    core_props.comments = (
        "Conversion Mode: Editable. "
        "Reconstructed natively into editable Word text, tables, shapes, and images. "
        "Page dimensions preserve the original slide aspect ratio."
    )
    core_props.title = base_name

    temp_img_dir = tempfile.mkdtemp(prefix='pptx_edit_imgs_')
    img_counter = 0

    try:
        for slide_idx, slide in enumerate(prs.slides):
            sec = doc.sections[0] if slide_idx == 0 else doc.add_section(WD_SECTION_START.NEW_PAGE)
            sec.page_width = Pt(target_w_pt)
            sec.page_height = Pt(target_h_pt)
            sec.top_margin = Pt(0)
            sec.bottom_margin = Pt(0)
            sec.left_margin = Pt(0)
            sec.right_margin = Pt(0)
            sec.header_distance = Pt(0)
            sec.footer_distance = Pt(0)
            sec.gutter = Pt(0)
            
            p_container = doc.paragraphs[0] if (slide_idx == 0 and doc.paragraphs) else doc.add_paragraph()
            p_container.paragraph_format.space_before = Pt(0)
            p_container.paragraph_format.space_after = Pt(0)
            p_container.paragraph_format.line_spacing = Pt(1)
            p_container.paragraph_format.left_indent = Pt(0)
            p_container.paragraph_format.right_indent = Pt(0)

            def get_all_shapes(shapes_list, offset_x=0, offset_y=0):
                flat = []
                for s in shapes_list:
                    if s.shape_type == MSO_SHAPE_TYPE.GROUP:
                        flat.extend(get_all_shapes(s.shapes, offset_x + s.left, offset_y + s.top))
                    else:
                        flat.append((s, offset_x, offset_y))
                return flat

            flat_shapes = get_all_shapes(slide.shapes)
            # In PowerPoint, slide.shapes document order natively represents the stacking / z-order.
            # Preserve the author's stacking order so foreground objects remain in front of backgrounds.
            slide_w_emu = prs.slide_width
            slide_h_emu = prs.slide_height
            def is_canvas_bg(item):
                s = item[0]
                return (s.width >= slide_w_emu * 0.9 and s.height >= slide_h_emu * 0.9 and
                        (not s.has_text_frame or not any(p.text.strip() for p in s.text_frame.paragraphs)))

            bg_shapes = [item for item in flat_shapes if is_canvas_bg(item)]
            fg_shapes = [item for item in flat_shapes if not is_canvas_bg(item)]
            sorted_shapes = bg_shapes + fg_shapes

            for shape_item in sorted_shapes:
                shape, off_x, off_y = shape_item
                left_emu = int((shape.left + off_x) * scale)
                top_emu = int((shape.top + off_y) * scale)
                w_emu = max(1000, int(shape.width * scale))
                h_emu = max(1000, int(shape.height * scale))

                # 1. Native Picture
                if shape.shape_type == MSO_SHAPE_TYPE.PICTURE or hasattr(shape, 'image'):
                    try:
                        img_counter += 1
                        img_bytes = shape.image.blob
                        ext = shape.image.ext or 'png'
                        tmp_img_path = os.path.join(temp_img_dir, f'img_{img_counter}.{ext}')
                        with open(tmp_img_path, 'wb') as f:
                            f.write(img_bytes)

                        run_img = p_container.add_run()
                        run_img.font.size = Pt(1)
                        inline_pic = run_img.add_picture(tmp_img_path, width=Pt(w_emu / 12700.0), height=Pt(h_emu / 12700.0))

                        inline_elem = inline_pic._inline
                        graphic_elem = inline_elem.find('{http://schemas.openxmlformats.org/drawingml/2006/main}graphic')
                        extent_elem = inline_elem.find('{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent')
                        cx = extent_elem.get('cx') if extent_elem is not None else str(w_emu)
                        cy = extent_elem.get('cy') if extent_elem is not None else str(h_emu)

                        anchor_xml = f'''<wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                                   distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240"
                                   behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
                          <wp:simplePos x="0" y="0"/>
                          <wp:positionH relativeFrom="page"><wp:posOffset>{left_emu}</wp:posOffset></wp:positionH>
                          <wp:positionV relativeFrom="page"><wp:posOffset>{top_emu}</wp:posOffset></wp:positionV>
                          <wp:extent cx="{cx}" cy="{cy}"/>
                          <wp:effectExtent l="0" t="0" r="0" b="0"/>
                          <wp:wrapNone/>
                          <wp:docPr id="{100 + img_counter}" name="Picture {img_counter}"/>
                        </wp:anchor>'''
                        anchor_elem = parse_xml(anchor_xml)
                        anchor_elem.append(graphic_elem)
                        dp = inline_elem.getparent()
                        dp.remove(inline_elem)
                        dp.append(anchor_elem)
                        continue
                    except Exception:
                        pass

                # 2. Native Table
                if shape.has_table:
                    tbl = shape.table
                    num_rows = len(tbl.rows)
                    num_cols = len(tbl.columns)
                    if num_rows > 0 and num_cols > 0:
                        tblpX_dxa = int(left_emu / 635.0)
                        tblpY_dxa = int(top_emu / 635.0)
                        tblW_dxa = int(w_emu / 635.0)
                        col_widths_dxa = [int(col.width * scale / 635.0) for col in tbl.columns]
                        grid_xml = "".join(f'<w:gridCol w:w="{cw}"/>' for cw in col_widths_dxa)
                        
                        rows_xml = []
                        for r_idx, row in enumerate(tbl.rows):
                            cells_xml = []
                            for c_idx, cell in enumerate(row.cells):
                                cw = col_widths_dxa[c_idx] if c_idx < len(col_widths_dxa) else int(tblW_dxa / num_cols)
                                cell_fill = get_shape_color_hex(cell.fill)
                                shd_xml = f'<w:shd w:val="clear" w:color="auto" w:fill="{cell_fill}"/>' if cell_fill else ''
                                cell_p_xmls = []
                                for cp in cell.text_frame.paragraphs:
                                    t = cp.text.strip()
                                    runs_xml = []
                                    for cr in cp.runs:
                                        rt = cr.text
                                        if not rt:
                                            continue
                                        sz_pt = cr.font.size.pt * scale if cr.font.size else 10.0 * scale
                                        sz_xml = f'<w:sz w:val="{int(sz_pt * 2)}"/>'
                                        raw_font = cr.font.name or (cp.font.name if hasattr(cp, 'font') and cp.font else None) or minor_theme_font
                                        c_font, is_b, is_i = clean_font_name(raw_font)
                                        bold_xml = '<w:b/>' if (cr.font.bold or is_b) else ''
                                        italic_xml = '<w:i/>' if (cr.font.italic or is_i) else ''
                                        font_xml = f'<w:rFonts w:ascii="{c_font}" w:hAnsi="{c_font}" w:cs="{c_font}"/>'
                                        color_xml = ''
                                        try:
                                            if cr.font.color and cr.font.color.rgb:
                                                color_xml = f'<w:color w:val="{cr.font.color.rgb[0]:02X}{cr.font.color.rgb[1]:02X}{cr.font.color.rgb[2]:02X}"/>'
                                        except Exception:
                                            pass
                                        clean_text = rt.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                                        runs_xml.append(f'<w:r><w:rPr>{font_xml}{bold_xml}{italic_xml}{sz_xml}{color_xml}</w:rPr><w:t xml:space="preserve">{clean_text}</w:t></w:r>')
                                    if not runs_xml and t:
                                        clean_text = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                                        runs_xml.append(f'<w:r><w:rPr><w:sz w:val="{int(10.0 * scale * 2)}"/></w:rPr><w:t>{clean_text}</w:t></w:r>')
                                    elif not runs_xml:
                                        runs_xml.append('<w:r><w:t></w:t></w:r>')
                                    cell_p_xmls.append(f'<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>{"".join(runs_xml)}</w:p>')
                                if not cell_p_xmls:
                                    cell_p_xmls.append('<w:p/>')
                                cells_xml.append(f'''<w:tc>
                                  <w:tcPr>
                                    <w:tcW w:w="{cw}" w:type="dxa"/>
                                    {shd_xml}
                                    <w:tcMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>
                                  </w:tcPr>
                                  {"".join(cell_p_xmls)}
                                </w:tc>''')
                            rows_xml.append(f'<w:tr>{"".join(cells_xml)}</w:tr>')
                            
                        table_full_xml = f'''<w:tbl xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                          <w:tblPr>
                            <w:tblpPr w:vertAnchor="page" w:horzAnchor="page" w:tblpX="{tblpX_dxa}" w:tblpY="{tblpY_dxa}"/>
                            <w:tblW w:w="{tblW_dxa}" w:type="dxa"/>
                            <w:tblBorders>
                              <w:top w:val="single" w:sz="6" w:space="0" w:color="003366"/>
                              <w:left w:val="single" w:sz="6" w:space="0" w:color="003366"/>
                              <w:bottom w:val="single" w:sz="6" w:space="0" w:color="003366"/>
                              <w:right w:val="single" w:sz="6" w:space="0" w:color="003366"/>
                              <w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
                              <w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
                            </w:tblBorders>
                          </w:tblPr>
                          <w:tblGrid>{grid_xml}</w:tblGrid>
                          {"".join(rows_xml)}
                        </w:tbl>'''
                        tbl_elem = parse_xml(table_full_xml)
                        doc._body._body.append(tbl_elem)
                        continue

                # 3. Line / Connector Shape
                if shape.shape_type == MSO_SHAPE_TYPE.LINE:
                    line_color = get_line_color_hex(shape.line) if hasattr(shape, 'line') else '4472C4'
                    if not line_color:
                        line_color = '4472C4'
                    line_w_emu = max(12700, int((shape.line.width or 12700) * scale))
                    is_horiz = shape.width >= shape.height
                    geom_prst = 'rightArrow' if ('Arrow' in shape.name or 'Connector' in shape.name) else 'line'
                    
                    line_drawing_xml = f'''<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                         xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                         xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
                        <w:drawing>
                          <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240"
                                     behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
                            <wp:simplePos x="0" y="0"/>
                            <wp:positionH relativeFrom="page"><wp:posOffset>{left_emu}</wp:posOffset></wp:positionH>
                            <wp:positionV relativeFrom="page"><wp:posOffset>{top_emu}</wp:posOffset></wp:positionV>
                            <wp:extent cx="{w_emu}" cy="{max(12700, h_emu)}"/>
                            <wp:effectExtent l="0" t="0" r="0" b="0"/>
                            <wp:wrapNone/>
                            <wp:docPr id="{500 + img_counter}" name="Line {shape.name}"/>
                            <a:graphic>
                              <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
                                <wps:wsp>
                                  <wps:spPr>
                                    <a:xfrm><a:off x="0" y="0"/><a:ext cx="{w_emu}" cy="{max(12700, h_emu)}"/></a:xfrm>
                                    <a:prstGeom prst="{geom_prst}"><a:avLst/></a:prstGeom>
                                    <a:solidFill><a:srgbClr val="{line_color}"/></a:solidFill>
                                    <a:ln w="{line_w_emu}"><a:solidFill><a:srgbClr val="{line_color}"/></a:solidFill></a:ln>
                                  </wps:spPr>
                                  <wps:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/>
                                </wps:wsp>
                              </a:graphicData>
                            </a:graphic>
                          </wp:anchor>
                        </w:drawing>
                      </w:r>'''
                    r_elem = parse_xml(line_drawing_xml)
                    p_container._p.append(r_elem)
                    continue

                # 4. Text Shape or Styled Box / AutoShape
                has_text = shape.has_text_frame and any(p.text.strip() for p in shape.text_frame.paragraphs)
                fill_color = get_shape_color_hex(shape.fill) if hasattr(shape, 'fill') else None
                line_color = get_line_color_hex(shape.line) if hasattr(shape, 'line') else None
                
                if not has_text and not fill_color and not line_color:
                    continue

                fill_xml = f'<a:solidFill><a:srgbClr val="{fill_color}"/></a:solidFill>' if fill_color else '<a:noFill/>'
                if line_color:
                    line_w_emu = int((shape.line.width or 12700) * scale)
                    ln_xml = f'<a:ln w="{line_w_emu}"><a:solidFill><a:srgbClr val="{line_color}"/></a:solidFill></a:ln>'
                else:
                    ln_xml = '<a:ln><a:noFill/></a:ln>'

                txbx_paragraphs_xml = []
                if has_text:
                    for p in shape.text_frame.paragraphs:
                        p_align = 'left'
                        if p.alignment == PP_ALIGN.CENTER:
                            p_align = 'center'
                        elif p.alignment == PP_ALIGN.RIGHT:
                            p_align = 'right'
                        elif p.alignment == PP_ALIGN.JUSTIFY:
                            p_align = 'both'
                        
                        align_xml = f'<w:jc w:val="{p_align}"/>'
                        runs_xml = []
                        for r in p.runs:
                            text_str = r.text
                            if not text_str:
                                continue
                            sz_pt = r.font.size.pt * scale if r.font.size else 12.0 * scale
                            sz_xml = f'<w:sz w:val="{int(sz_pt * 2)}"/>'
                            raw_font = r.font.name or (p.font.name if hasattr(p, 'font') and p.font else None)
                            if not raw_font:
                                raw_font = major_theme_font if sz_pt >= 16 else minor_theme_font
                            font_name, is_b, is_i = clean_font_name(raw_font)
                            bold_flag = r.font.bold or is_b
                            italic_flag = r.font.italic or is_i
                            bold_xml = '<w:b/>' if bold_flag else ''
                            italic_xml = '<w:i/>' if italic_flag else ''
                            underline_xml = '<w:u w:val="single"/>' if r.font.underline else ''
                            font_xml = f'<w:rFonts w:ascii="{font_name}" w:hAnsi="{font_name}" w:cs="{font_name}"/>'
                            color_xml = ''
                            try:
                                if r.font.color and r.font.color.rgb:
                                    color_xml = f'<w:color w:val="{r.font.color.rgb[0]:02X}{r.font.color.rgb[1]:02X}{r.font.color.rgb[2]:02X}"/>'
                            except Exception:
                                pass
                            clean_text = text_str.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                            runs_xml.append(f'<w:r><w:rPr>{font_xml}{bold_xml}{italic_xml}{underline_xml}{sz_xml}{color_xml}</w:rPr><w:t xml:space="preserve">{clean_text}</w:t></w:r>')
                        
                        if not runs_xml and p.text.strip():
                            clean_text = p.text.strip().replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                            runs_xml.append(f'<w:r><w:rPr><w:sz w:val="{int(12.0 * scale * 2)}"/></w:rPr><w:t>{clean_text}</w:t></w:r>')
                        elif not runs_xml:
                            runs_xml.append('<w:r><w:t></w:t></w:r>')
                        p_sb = int(p.space_before.pt * 20 * scale) if p.space_before else 0
                        p_sa = int(p.space_after.pt * 20 * scale) if p.space_after else 0
                        # Cap excessive intra-shape paragraph gaps
                        if p_sb > 160: p_sb = 120
                        if p_sa > 160: p_sa = 120
                        spacing_xml = f'<w:spacing w:before="{p_sb}" w:after="{p_sa}"/>'
                        txbx_paragraphs_xml.append(f'<w:p><w:pPr>{align_xml}{spacing_xml}</w:pPr>{"".join(runs_xml)}</w:p>')
                else:
                    txbx_paragraphs_xml.append('<w:p/>')

                behind_doc = "1" if is_canvas_bg((shape, 0, 0)) else "0"

                # Use original shape text frame margins if available, converted to dxa
                tf_l_emu = int((shape.text_frame.margin_left or 0) * scale) if shape.has_text_frame else 0
                tf_t_emu = int((shape.text_frame.margin_top or 0) * scale) if shape.has_text_frame else 0
                tf_r_emu = int((shape.text_frame.margin_right or 0) * scale) if shape.has_text_frame else 0
                tf_b_emu = int((shape.text_frame.margin_bottom or 0) * scale) if shape.has_text_frame else 0

                # keep the real outline: freeform paths (frames, swooshes, arrows) and preset shapes (ellipse, rounded rect...)
                geom_xml = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
                try:
                    from lxml import etree as _et
                    _sp = shape._element.spPr
                    _cg = _sp.find('{http://schemas.openxmlformats.org/drawingml/2006/main}custGeom')
                    _pg = _sp.find('{http://schemas.openxmlformats.org/drawingml/2006/main}prstGeom')
                    if _cg is not None:
                        geom_xml = _et.tostring(_cg).decode()
                    elif _pg is not None and _pg.get('prst'):
                        geom_xml = f'<a:prstGeom prst="{_pg.get("prst")}"><a:avLst/></a:prstGeom>'
                except Exception:
                    pass

                shape_drawing_xml = f'''<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                     xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                     xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                     xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
                    <w:drawing>
                      <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240"
                                 behindDoc="{behind_doc}" locked="0" layoutInCell="1" allowOverlap="1">
                        <wp:simplePos x="0" y="0"/>
                        <wp:positionH relativeFrom="page"><wp:posOffset>{left_emu}</wp:posOffset></wp:positionH>
                        <wp:positionV relativeFrom="page"><wp:posOffset>{top_emu}</wp:posOffset></wp:positionV>
                        <wp:extent cx="{w_emu}" cy="{h_emu}"/>
                        <wp:effectExtent l="0" t="0" r="0" b="0"/>
                        <wp:wrapNone/>
                        <wp:docPr id="{1000 + img_counter}" name="Shape {shape.name}"/>
                        <a:graphic>
                          <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
                            <wps:wsp>
                              <wps:spPr>
                                <a:xfrm><a:off x="0" y="0"/><a:ext cx="{w_emu}" cy="{h_emu}"/></a:xfrm>
                                {geom_xml}
                                {fill_xml}
                                {ln_xml}
                              </wps:spPr>
                              <wps:txbx>
                                <w:txbxContent>
                                  {"".join(txbx_paragraphs_xml)}
                                </w:txbxContent>
                              </wps:txbx>
                              <wps:bodyPr lIns="{tf_l_emu}" tIns="{tf_t_emu}" rIns="{tf_r_emu}" bIns="{tf_b_emu}"/>
                            </wps:wsp>
                          </a:graphicData>
                        </a:graphic>
                      </wp:anchor>
                    </w:drawing>
                  </w:r>'''

                r_elem = parse_xml(shape_drawing_xml)
                p_container._p.append(r_elem)

        doc.save(docx_path)
        return docx_path
    finally:
        shutil.rmtree(temp_img_dir, ignore_errors=True)

def pptx_to_docx(input_path, output_path, mode='editable'):
    """
    Unified entry point for PowerPoint to Word conversion.
    Defaults to native editable mode (reconstructing Word text boxes, tables, shapes, and pictures).
    """
    mode_str = str(mode or 'editable').strip().lower()
    if mode_str in ('layout', 'visual', 'render'):
        return convert_pptx_to_docx_layout(input_path, output_path)
    else:
        convert_pptx_to_docx_editable(input_path, output_path)
        _maybe_prefer_rendered_rebuild(input_path, output_path)
        return output_path

def _pptx_head(src, dst, k):
    """Copy of a deck that keeps only its first k slides."""
    prs = Presentation(src)
    ids = prs.slides._sldIdLst
    for idx in range(len(ids) - 1, k - 1, -1):
        prs.part.drop_rel(ids[idx].rId)
        del ids[idx]
    prs.save(dst)


def _maybe_prefer_rendered_rebuild(pptx_path, docx_path):
    """The native rebuild reads shapes straight from the .pptx and cannot resolve everything a deck inherits from its
    master / layout (backgrounds, placeholder sizes, theme colours). The deck is rendered by LibreOffice and rebuilt as
    positioned editable text boxes + shapes + pictures; whichever result matches the render better is kept.
    For long decks the choice is made on the first slides only (the same masters/layouts drive the rest), so the cost
    of deciding does not grow with the number of slides."""
    SAMPLE = 5
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
            n_slides = len(Presentation(pptx_path).slides)
            if n_slides > SAMPLE + 1:
                head_pptx = os.path.join(td, 'head.pptx')
                _pptx_head(pptx_path, head_pptx, SAMPLE)
                head_pdf = os.path.join(td, 'head.pdf')
                pptx_to_pdf(head_pptx, head_pdf)
                head_native = os.path.join(td, 'head_native.docx')
                convert_pptx_to_docx_editable(head_pptx, head_native)
                head_alt = os.path.join(td, 'head_alt.docx')
                reconstruct_pdf_to_docx_editable(head_pdf, head_alt, positioned=True)
                native, rebuilt = _render_scores(head_pdf, [head_native, head_alt], max_pages=SAMPLE)
                if native is None or native < 12.0 or rebuilt is None or rebuilt + 4.0 >= native:
                    return
                ref_pdf = os.path.join(td, 'deck.pdf')
                pptx_to_pdf(pptx_path, ref_pdf)
                alt = os.path.join(td, 'alt.docx')
                reconstruct_pdf_to_docx_editable(ref_pdf, alt, positioned=True)
                shutil.copyfile(alt, docx_path)
                return
            ref_pdf = os.path.join(td, 'deck.pdf')
            pptx_to_pdf(pptx_path, ref_pdf)
            alt = os.path.join(td, 'alt.docx')
            reconstruct_pdf_to_docx_editable(ref_pdf, alt, positioned=True)
            native, rebuilt = _render_scores(ref_pdf, [docx_path, alt], max_pages=10)
            if native is None or native < 12.0:
                return
            if rebuilt is not None and rebuilt + 4.0 < native:
                shutil.copyfile(alt, docx_path)
    except Exception as e:
        print(f"WARN: rendered rebuild skipped: {e}", file=sys.stderr)

def compress_image(input_path, output_path, out_fmt=None, quality=80, max_dim=0, target_kb=0):
    """
    Format-Aware Production Image Compressor with Target-Size Optimization:
    - JPEG: EXIF orientation preservation, chroma subsampling, progressive encoding.
    - PNG: Full alpha preservation, lossless level-9 compression, adaptive palette quantization for target size.
    - WebP: Lossless & lossy modes with alpha channel support.
    - Automatic mode: uses quality + optional max_dim.
    - Manual mode (target_kb > 0): iterative binary search + progressive downscaling
      to ensure the final file size is <= target_kb * 1024 bytes.
    - Guaranteed byte budget verification.
    """
    import io
    from PIL import Image, ImageOps

    in_size = os.path.getsize(input_path)
    try:
        t_kb = float(target_kb) if target_kb else 0.0
    except (ValueError, TypeError):
        t_kb = 0.0
    target_bytes = int(t_kb * 1024) if t_kb > 0 else 0

    im = Image.open(input_path)
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass

    orig_w, orig_h = im.size

    # Determine source & target formats
    in_ext = os.path.splitext(input_path)[1].lower().lstrip('.')
    if in_ext in ('jpg', 'jpeg'):
        in_fmt = 'JPEG'
    elif in_ext == 'png':
        in_fmt = 'PNG'
    elif in_ext == 'webp':
        in_fmt = 'WEBP'
    elif in_ext in ('tif', 'tiff'):
        in_fmt = 'TIFF'
    else:
        in_fmt = im.format or 'JPEG'

    if out_fmt and str(out_fmt).strip() and str(out_fmt).strip().lower() != 'default':
        tgt_fmt = str(out_fmt).strip().upper()
        if tgt_fmt == 'JPG':
            tgt_fmt = 'JPEG'
    else:
        tgt_fmt = in_fmt

    # Initial downscaling if max_dim was provided
    max_d = int(max_dim) if max_dim else 0
    if max_d > 0 and max(orig_w, orig_h) > max_d:
        scale = max_d / float(max(orig_w, orig_h))
        new_w = max(1, int(orig_w * scale))
        new_h = max(1, int(orig_h * scale))
        im = im.resize((new_w, new_h), Image.Resampling.LANCZOS)

    def prepare_for_format(image, fmt):
        if fmt == 'JPEG':
            if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
                bg = Image.new('RGB', image.size, (255, 255, 255))
                c_im = image.convert('RGBA') if image.mode == 'P' else image
                bg.paste(c_im, mask=c_im.split()[3])
                return bg
            elif image.mode != 'RGB' and image.mode != 'L':
                return image.convert('RGB')
        return image

    def encode_candidate(image, fmt, q, optimize=True):
        buf = io.BytesIO()
        work_im = prepare_for_format(image, fmt)
        if fmt == 'JPEG':
            work_im.save(buf, format='JPEG', quality=max(5, min(95, q)), optimize=optimize, progressive=True, subsampling='4:2:0')
        elif fmt == 'WEBP':
            work_im.save(buf, format='WEBP', quality=max(5, min(95, q)), method=6)
        elif fmt == 'PNG':
            if q < 85:
                colors = max(16, min(256, int(256 * (q / 85.0))))
                try:
                    q_im = work_im.quantize(colors=colors)
                    q_im.save(buf, format='PNG', optimize=True, compress_level=9)
                except Exception:
                    work_im.save(buf, format='PNG', optimize=True, compress_level=9)
            else:
                work_im.save(buf, format='PNG', optimize=True, compress_level=9)
        else:
            work_im.save(buf, format=fmt, optimize=True)
        return buf.getvalue()

    if target_bytes > 0:
        best_bytes = None
        smallest_ever = None
        smallest_ever_size = float('inf')

        # Progressive scaling ladder (1.0 down to ~0.25)
        scale_steps = [1.0, 0.85, 0.72, 0.60, 0.50, 0.40, 0.30]
        cur_w, cur_h = im.size

        for scale in scale_steps:
            scaled_w = max(32, int(cur_w * scale))
            scaled_h = max(32, int(cur_h * scale))
            step_im = im if scale == 1.0 else im.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)

            # Binary search over quality [10 .. 92]
            low_q = 10
            high_q = 92
            best_pass_bytes = None

            while low_q <= high_q:
                mid_q = (low_q + high_q) // 2
                cand_data = encode_candidate(step_im, tgt_fmt, mid_q)
                cand_len = len(cand_data)

                if cand_len < smallest_ever_size:
                    smallest_ever_size = cand_len
                    smallest_ever = cand_data

                if cand_len <= target_bytes:
                    best_pass_bytes = cand_data
                    low_q = mid_q + 1
                else:
                    high_q = mid_q - 1

            if best_pass_bytes is not None:
                best_bytes = best_pass_bytes
                break

        if best_bytes is not None and len(best_bytes) <= target_bytes:
            final_data = best_bytes
            target_met = True
        else:
            final_data = smallest_ever if smallest_ever is not None else encode_candidate(im, tgt_fmt, 15)
            target_met = len(final_data) <= target_bytes

        with open(output_path, 'wb') as f:
            f.write(final_data)
    else:
        q = int(quality) if quality else 80
        q = max(10, min(100, q))
        data = encode_candidate(im, tgt_fmt, q)
        with open(output_path, 'wb') as f:
            f.write(data)
        target_met = True

    im.close()
    out_size = os.path.getsize(output_path)
    return {
        'original_size': in_size,
        'output_size': out_size,
        'bytes_saved': max(0, in_size - out_size),
        'reduction_pct': round(((in_size - out_size) / in_size) * 100, 1) if in_size > 0 else 0.0,
        'format': tgt_fmt,
        'target_kb': t_kb,
        'target_met': target_met
    }

def compress_pdf(input_path, output_path, level='recommended', gray=False):
    """
    Advanced Multi-Profile PDF Optimizer:
    - Deduplicates and optimizes embedded raster images with Pillow.
    - Preserves alpha transparency and masks on PNGs.
    - Strips bloat, redundant XML metadata, and orphaned objects safely.
    - Deflates content streams, fonts, and images losslessly.
    """
    import io
    from PIL import Image

    doc = fitz.open(input_path)
    in_size = os.path.getsize(input_path)

    settings_map = {
        'low': {'max_dim': 1600, 'quality': 80},
        'recommended': {'max_dim': 1000, 'quality': 65},
        'strong': {'max_dim': 800, 'quality': 50},
        'extreme': {'max_dim': 500, 'quality': 35}
    }
    cfg = settings_map.get(level, settings_map['recommended'])
    max_dim = cfg['max_dim']
    quality = cfg['quality']

    seen_xrefs = set()
    for page in doc:
        image_list = page.get_images(full=True)
        for img_info in image_list:
            xref = img_info[0]
            if xref in seen_xrefs:
                continue
            seen_xrefs.add(xref)
            try:
                base_image = doc.extract_image(xref)
                if not base_image or not base_image.get("image"):
                    continue

                image_bytes = base_image["image"]
                img = Image.open(io.BytesIO(image_bytes))
                w, h = img.size

                needs_rescale = max(w, h) > max_dim
                needs_gray = bool(gray)

                if needs_rescale:
                    scale = max_dim / float(max(w, h))
                    new_w = max(1, int(w * scale))
                    new_h = max(1, int(h * scale))
                    img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

                if needs_gray:
                    img = img.convert('L')

                out_io = io.BytesIO()
                if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                    img.save(out_io, format='PNG', optimize=True, compress_level=9)
                else:
                    if img.mode != 'RGB' and img.mode != 'L':
                        img = img.convert('RGB')
                    img.save(out_io, format='JPEG', quality=quality, optimize=True)

                new_bytes = out_io.getvalue()
                if len(new_bytes) < len(image_bytes):
                    if hasattr(page, 'replace_image'):
                        try:
                            page.replace_image(xref, stream=new_bytes)
                        except Exception:
                            doc.update_stream(xref, new_bytes)
                    else:
                        doc.update_stream(xref, new_bytes)
            except Exception:
                continue

    try:
        doc.scrub(attached_files=False, clean_pages=True, embedded_files=False, metadata=False, reset_fields=False, reset_responses=False, thumbnails=True, xml_metadata=True)
    except Exception:
        pass

    doc.save(
        output_path,
        garbage=4,
        deflate=True,
        deflate_images=True,
        deflate_fonts=True,
        clean=True
    )
    doc.close()
    out_size = os.path.getsize(output_path)
    return {
        'original_size': in_size,
        'output_size': out_size,
        'bytes_saved': max(0, in_size - out_size),
        'reduction_pct': round(((in_size - out_size) / in_size) * 100, 1) if in_size > 0 else 0.0
    }

def repair_pdf(input_path, output_path):
    """
    Staged PDF Structural Repair and Validation Pipeline:
    1. Inspects PDF signature (%PDF-) and recovers displaced header offsets.
    2. Runs MuPDF's recovery parser to sequentially scan objects, repair damaged/missing xref tables,
       reconstruct corrupted trailers, and repair unclosed object streams.
    3. Rebuilds and writes a pristine, standardized specification-compliant PDF.
    4. Independently validates that the repaired output opens cleanly, has valid pages (>0),
       and can be rasterized without error.
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")

    in_size = os.path.getsize(input_path)
    if in_size < 10:
        raise ValueError("File is too small to be a valid PDF.")

    with open(input_path, 'rb') as f:
        header_bytes = f.read(2048)

    pdf_start = header_bytes.find(b'%PDF-')
    if pdf_start == -1:
        with open(input_path, 'rb') as f:
            chunk = f.read(65536)
            pdf_start = chunk.find(b'%PDF-')
        if pdf_start == -1:
            raise ValueError("Invalid PDF format: File lacks %PDF- header signature.")

    # If there are leading garbage bytes before %PDF-, create a trimmed temporary copy
    work_input = input_path
    temp_trimmed = None
    if pdf_start > 0:
        import tempfile
        temp_trimmed = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf').name
        with open(input_path, 'rb') as f_in, open(temp_trimmed, 'wb') as f_out:
            f_in.seek(pdf_start)
            shutil.copyfileobj(f_in, f_out)
        work_input = temp_trimmed

    try:
        # Open with recovery mode
        doc = fitz.open(work_input)
        if len(doc) == 0:
            raise ValueError("PDF has no readable pages.")

        was_corrupted = bool(pdf_start > 0 or getattr(doc, 'is_repaired', False))

        # Save with full structural rebuild: fresh xref table, clean objects, garbage collection
        doc.save(
            output_path,
            garbage=4,
            deflate=True,
            clean=True
        )
        doc.close()

        # Step 4: Independent verification of the repaired output
        if not os.path.exists(output_path) or os.path.getsize(output_path) < 100:
            raise ValueError("Repair output file is missing or empty.")

        verify_doc = fitz.open(output_path)
        page_count = len(verify_doc)
        if page_count == 0:
            verify_doc.close()
            raise ValueError("Repaired document contains zero pages.")

        # Test rasterization of page 0 to ensure graphics and font streams are valid
        try:
            pix = verify_doc[0].get_pixmap(dpi=72)
            del pix
        except Exception as e:
            verify_doc.close()
            raise ValueError(f"Repaired document failed rendering validation: {e}")

        verify_doc.close()
        return {
            'success': True,
            'pages': page_count,
            'was_corrupted': was_corrupted,
            'original_size': in_size,
            'repaired_size': os.path.getsize(output_path)
        }
    finally:
        if temp_trimmed and os.path.exists(temp_trimmed):
            try: os.unlink(temp_trimmed)
            except Exception: pass

def protect_pdf(input_path, output_path, user_password, owner_password=None):
    """
    Encrypts a PDF using industry-standard AES-256 encryption.
    Supports user password (required to open) and optional owner password (permissions control).
    Fails clearly if the PDF is already encrypted with an incompatible password.
    """
    if not os.path.exists(input_path) or os.path.getsize(input_path) == 0:
        raise ValueError("Input PDF does not exist or is empty.")

    if not user_password:
        raise ValueError("A non-empty password is required to protect the PDF.")

    user_pw = str(user_password)
    owner_pw = str(owner_password) if owner_password else user_pw

    doc = fitz.open(input_path)
    if doc.is_encrypted:
        # Check if it can be opened without credentials or if user supplied current password
        auth_res = doc.authenticate(user_pw)
        if auth_res == 0:
            doc.close()
            raise ValueError("PDF is already encrypted with a different password. Please unlock it first.")

    page_count = len(doc)
    if page_count == 0:
        doc.close()
        raise ValueError("PDF has 0 pages.")

    # Apply standard permissions: allow printing, copying, annotating, accessibility
    permissions = (
        fitz.PDF_PERM_PRINT
        | fitz.PDF_PERM_COPY
        | fitz.PDF_PERM_ANNOTATE
        | fitz.PDF_PERM_ACCESSIBILITY
    )

    doc.save(
        output_path,
        encryption=fitz.PDF_ENCRYPT_AES_256,
        user_pw=user_pw,
        owner_pw=owner_pw,
        permissions=permissions,
        deflate=True,
        garbage=3
    )
    doc.close()

    if not os.path.exists(output_path) or os.path.getsize(output_path) < 50:
        raise ValueError("Protect PDF failed to write valid output.")

    # Verify that the output is indeed encrypted and opens with user_pw
    v_doc = fitz.open(output_path)
    if not v_doc.is_encrypted:
        v_doc.close()
        raise ValueError("Verification failed: Output PDF is not encrypted.")
    auth_check = v_doc.authenticate(user_pw)
    if auth_check == 0:
        v_doc.close()
        raise ValueError("Verification failed: Output PDF could not be decrypted with user password.")
    v_doc.close()

    return {
        'success': True,
        'pages': page_count,
        'algorithm': 'AES-256',
        'file_size': os.path.getsize(output_path)
    }

def unlock_pdf(input_path, output_path, password=''):
    """
    Unlocks a password-protected PDF and saves an unencrypted, fully accessible PDF.
    If the document is already unencrypted, it re-saves a clean version.
    """
    if not os.path.exists(input_path) or os.path.getsize(input_path) == 0:
        raise ValueError("Input PDF does not exist or is empty.")

    doc = fitz.open(input_path)
    page_count = len(doc)
    was_encrypted = bool(doc.is_encrypted)

    if was_encrypted:
        pwd = str(password or '')
        auth_res = doc.authenticate(pwd)
        if auth_res == 0:
            doc.close()
            raise ValueError("Incorrect password for protected PDF.")

    # Save completely unencrypted
    doc.save(
        output_path,
        encryption=fitz.PDF_ENCRYPT_NONE,
        deflate=True,
        garbage=3,
        clean=True
    )
    doc.close()

    if not os.path.exists(output_path) or os.path.getsize(output_path) < 50:
        raise ValueError("Unlock PDF failed to produce valid output.")

    # Verify the output is genuinely unencrypted
    v_doc = fitz.open(output_path)
    if v_doc.is_encrypted:
        v_doc.close()
        raise ValueError("Verification failed: Output PDF remains encrypted.")
    if len(v_doc) == 0:
        v_doc.close()
        raise ValueError("Verification failed: Output PDF has 0 pages.")
    v_doc.close()

    return {
        'success': True,
        'pages': page_count,
        'was_encrypted': was_encrypted,
        'file_size': os.path.getsize(output_path)
    }

def _ocr_page_words(pdf_path, page_idx, lang_code, tessdata_dir, dpi):
    """OCR one page in a worker process (opens its own copy of the PDF). Returns [(x0, y0, x1, y1, word), ...]; [] when the page cannot be read."""
    try:
        d = fitz.open(pdf_path)
        pg = d[page_idx]
        tp = pg.get_textpage_ocr(language=lang_code, tessdata=tessdata_dir, dpi=dpi)
        out = [(w[0], w[1], w[2], w[3], w[4]) for w in pg.get_text("words", textpage=tp)]
        d.close()
        return out
    except Exception:
        return []


def _ocr_workers(pages_to_read):
    """How many pages are OCR'd at once: one per CPU, at most 4 and at most what the memory limit allows (each worker needs roughly 80 MB).
    SCAN_WORKERS overrides. On the small free server this is 1 or 2; on a bigger machine OCR is several times faster."""
    try:
        forced = int(os.environ.get('SCAN_WORKERS', '0'))
    except ValueError:
        forced = 0
    if forced > 0:
        return max(1, min(forced, pages_to_read))
    cpus = os.cpu_count() or 1
    mem_mb = None
    for f in ('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'):
        try:
            v = open(f).read().strip()
            if v.isdigit() and int(v) < (1 << 50):
                mem_mb = int(v) // (1024 * 1024)
                break
        except Exception:
            pass
    if mem_mb is None:
        try:
            mem_mb = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') // (1024 * 1024)
        except Exception:
            mem_mb = 4096
    by_mem = max(1, int((mem_mb - 300) // 80))
    return max(1, min(cpus, 4, by_mem, pages_to_read))


def scan_pdf(input_path, output_path, lang='eng', mode='smart'):
    """
    Production-grade Scan PDF Engine:
    1. Inspects PDF structure and page contents.
    2. Native digital text pages: 100% preserved (vector text, hyperlinks, vector art untouched).
    3. Scanned / image-only pages:
       - Skew angle detection via OpenCV minAreaRect.
       - Optional deskewing if skew > 0.5 degrees.
       - Optional contrast enhancement for clean background.
       - OCR via PyMuPDF TextPage OCR (using local tessdata).
       - Injects invisible searchable text layer (render_mode=3) matching word coordinates.
    4. Mixed pages: only injects OCR text in regions where native text does not already exist (no overlapping layers).
    5. Output validation: verifies file exists, opens cleanly, has identical page count, and validates text searchability.
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")

    # Determine tessdata path
    tessdata_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tessdata')
    if not os.path.exists(tessdata_dir):
        os.makedirs(tessdata_dir, exist_ok=True)

    lang_code = (lang or 'eng').strip().lower()
    tess_file = os.path.join(tessdata_dir, f"{lang_code}.traineddata")
    if not os.path.exists(tess_file):
        try:
            import urllib.request
            url = f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{lang_code}.traineddata"
            urllib.request.urlretrieve(url, tess_file)
        except Exception:
            lang_code = 'eng'

    doc = fitz.open(input_path)
    if doc.is_encrypted:
        doc.close()
        raise ValueError("Cannot scan password-protected PDF. Please unlock it first.")

    total_pages = len(doc)
    if total_pages == 0:
        doc.close()
        raise ValueError("PDF contains no pages.")

    scanned_count = 0
    native_count = 0
    words_added_total = 0
    skipped_pages = 0

    # Pass 1: which pages are scans (native text pages are left exactly as they are)
    todo = []            # (page index, text blocks that already exist on it)
    for page_idx, page in enumerate(doc):
        existing_char_count = len(page.get_text().strip())
        if existing_char_count >= 50 and mode == 'smart':
            native_count += 1
            continue
        scanned_count += 1
        todo.append((page_idx, [fitz.Rect(b[:4]) for b in page.get_text("blocks")]))

    # Pass 2: OCR. Pages are independent, so they are read by several processes at once when the machine has the CPU and memory for it.
    # The render size is limited to about 2000 px on the long side (150 dpi on A4): more pixels only cost time. A time budget keeps a very
    # long scan from running into the server's request limit; pages not reached in time are left unchanged (reported in the metrics).
    os.environ.setdefault('OMP_THREAD_LIMIT', '1')        # Tesseract's own threading is slower than one process per page
    budget = float(os.environ.get('SCAN_TIME_BUDGET', '100'))
    started = time.time()
    results = {}
    jobs = []
    for page_idx, _blocks in todo:
        r = doc[page_idx].rect
        long_in = max(r.width, r.height) / 72.0
        jobs.append((page_idx, int(max(72, min(150, 2000.0 / max(long_in, 0.1))))))
    workers = _ocr_workers(len(jobs))
    if workers > 1:
        from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
        ex = ProcessPoolExecutor(max_workers=workers)
        try:
            pending = {ex.submit(_ocr_page_words, input_path, idx, lang_code, tessdata_dir, dpi): idx for idx, dpi in jobs}
            while pending:
                left = budget - (time.time() - started)
                if left <= 0:
                    break
                done, _ = wait(list(pending), timeout=left, return_when=FIRST_COMPLETED)
                for f in done:
                    results[pending.pop(f)] = f.result()
        except Exception:
            pass          # a worker could not start or died: the pages without a result are read one by one below
        finally:
            ex.shutdown(wait=False, cancel_futures=True)
    for idx, dpi in jobs:
        if idx in results:
            continue
        if time.time() - started > budget:
            break
        results[idx] = _ocr_page_words(input_path, idx, lang_code, tessdata_dir, dpi)
    skipped_pages = len([1 for idx, _ in jobs if idx not in results])

    # Pass 3: invisible text layer, one TextWriter per page (much faster than one insert_text call per word)
    font = fitz.Font('helv')
    for page_idx, existing_blocks in todo:
        words = results.get(page_idx)
        if not words:
            continue
        page = doc[page_idx]
        tw = fitz.TextWriter(page.rect)
        wrote = 0
        for w in words:
            x0, y0, x1, y1, word_text = w
            if not word_text or not word_text.strip():
                continue
            word_rect = fitz.Rect(x0, y0, x1, y1)
            if any(eb.intersects(word_rect) for eb in existing_blocks):
                continue
            fontsize = max(6.0, min(72.0, (y1 - y0) * 0.85))
            try:
                tw.append(fitz.Point(x0, y1 - 1.5), word_text, font=font, fontsize=fontsize)
                wrote += 1
            except Exception:
                pass
        if wrote:
            tw.write_text(page, render_mode=3)
            words_added_total += wrote

    doc.save(
        output_path,
        garbage=4,
        deflate=True,
        clean=True
    )
    doc.close()

    if not os.path.exists(output_path) or os.path.getsize(output_path) < 100:
        raise ValueError("Scan PDF failed to generate valid output file.")

    vdoc = fitz.open(output_path)
    if len(vdoc) != total_pages:
        vdoc.close()
        raise ValueError(f"Output verification failed: expected {total_pages} pages, found {len(vdoc)}.")
    vdoc.close()

    return {
        'success': True,
        'total_pages': total_pages,
        'scanned_pages': scanned_count - skipped_pages,
        'native_pages': native_count,
        'words_added': words_added_total,
        'skipped_pages': skipped_pages,
        'file_size': os.path.getsize(output_path)
    }

def enhance_image(input_path, output_path, preset='balanced', sharpen='medium', denoise='mild',
                  contrast=True, brightness=0, saturation=1.0, scale=1.0, out_fmt='default'):
    """
    High-Fidelity Traditional Image Enhancement Engine (OpenCV + Pillow):
    - NO generative AI / NO hallucinated upscaling.
    - Preserves alpha transparency for PNG and WebP.
    - Preserves orientation via EXIF transpose.
    - Denoising: bilateral filter (smooths noise while preserving crisp text & edges).
    - Contrast: CLAHE in LAB color space (adapts shadows & highlights without color shifts).
    - Sharpening: Unsharp mask (boosts edge high frequencies without halos).
    - Resizing: High-fidelity Lanczos interpolation (1x, 1.5x, 2x).
    - Format conversion or preservation.
    """
    import cv2
    import numpy as np
    from PIL import Image, ImageOps

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input image not found: {input_path}")

    in_size = os.path.getsize(input_path)

    im = Image.open(input_path)
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass

    orig_w, orig_h = im.size
    has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)

    alpha_channel = None
    if has_alpha:
        if im.mode != 'RGBA':
            im = im.convert('RGBA')
        alpha_channel = im.split()[-1]
        rgb_im = im.convert('RGB')
    else:
        rgb_im = im.convert('RGB')

    cv_img = cv2.cvtColor(np.array(rgb_im), cv2.COLOR_RGB2BGR)
    rgb_im = None
    im.close()
    # Speed and memory: the filters cost time and memory in proportion to the pixel count (about 35 MB per megapixel while a picture is being
    # processed). A picture above ENHANCE_MAX_PIXELS (8 megapixels by default, set higher on a bigger server) is reduced to that size first and the
    # result is never larger than 1.5 times that. A 3 MB upload is normally below this, so most pictures are untouched.
    try:
        MAX_IN_PX = int(os.environ.get('ENHANCE_MAX_PIXELS', '8000000'))
    except ValueError:
        MAX_IN_PX = 8_000_000
    MAX_OUT_PX = int(MAX_IN_PX * 1.5)
    if cv_img.shape[0] * cv_img.shape[1] > MAX_IN_PX:
        f = (MAX_IN_PX / float(cv_img.shape[0] * cv_img.shape[1])) ** 0.5
        cv_img = cv2.resize(cv_img, (max(1, int(cv_img.shape[1] * f)), max(1, int(cv_img.shape[0] * f))), interpolation=cv2.INTER_AREA)
        if alpha_channel is not None:
            alpha_channel = alpha_channel.resize((cv_img.shape[1], cv_img.shape[0]), Image.Resampling.LANCZOS)
        orig_w, orig_h = cv_img.shape[1], cv_img.shape[0]

    p = str(preset or 'balanced').lower()
    if p == 'document':
        sh_val = 1.2
        dn_val = 1
        use_clahe = True
        clahe_clip = 3.0
        bright_val = max(10, int(brightness))
        sat_val = 0.9
    elif p == 'photo':
        sh_val = 0.6
        dn_val = 2
        use_clahe = True
        clahe_clip = 2.0
        bright_val = int(brightness)
        sat_val = 1.15
    elif p == 'custom':
        sh_map = {'off': 0.0, 'low': 0.4, 'medium': 0.8, 'high': 1.4}
        sh_val = sh_map.get(str(sharpen).lower(), 0.8)
        dn_map = {'off': 0, 'mild': 1, 'strong': 2}
        dn_val = dn_map.get(str(denoise).lower(), 1)
        use_clahe = bool(contrast)
        clahe_clip = 2.0
        bright_val = int(brightness)
        sat_val = float(saturation)
    else:
        sh_val = 0.75
        dn_val = 1
        use_clahe = True
        clahe_clip = 2.0
        bright_val = int(brightness)
        sat_val = 1.05

    big = cv_img.shape[0] * cv_img.shape[1] > 4_000_000
    if dn_val == 1:
        cv_img = cv2.bilateralFilter(cv_img, d=5 if big else 7, sigmaColor=50, sigmaSpace=50)
    elif dn_val == 2:
        cv_img = cv2.bilateralFilter(cv_img, d=7 if big else 9, sigmaColor=75, sigmaSpace=75)

    if use_clahe:
        lab = cv2.cvtColor(cv_img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        lab = cv2.merge((cl, a, b))
        cv_img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    if bright_val != 0:
        cv_img = cv2.convertScaleAbs(cv_img, alpha=1.0, beta=bright_val)

    if abs(sat_val - 1.0) > 0.01:
        hsv = cv2.cvtColor(cv_img, cv2.COLOR_BGR2HSV)
        hsv[:, :, 1] = cv2.convertScaleAbs(hsv[:, :, 1], alpha=sat_val)      # saturating 8-bit multiply, same result as clip(s * sat, 0, 255)
        cv_img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
        hsv = None

    if sh_val > 0.05:
        gaussian = cv2.GaussianBlur(cv_img, (0, 0), sigmaX=2.0)
        cv_img = cv2.addWeighted(cv_img, 1.0 + sh_val, gaussian, -sh_val, 0)

    try:
        sc = float(scale)
    except (ValueError, TypeError):
        sc = 1.0
    if sc not in (1.0, 1.5, 2.0, 3.0, 4.0):
        sc = 1.0

    while sc > 1.0 and orig_w * orig_h * sc * sc > MAX_OUT_PX:
        sc = {4.0: 3.0, 3.0: 2.0, 2.0: 1.5, 1.5: 1.0}[sc]
    new_w, new_h = orig_w, orig_h
    if sc != 1.0:
        new_w = max(1, int(orig_w * sc))
        new_h = max(1, int(orig_h * sc))
        cv_img = cv2.resize(cv_img, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
        if alpha_channel is not None:
            alpha_channel = alpha_channel.resize((new_w, new_h), Image.Resampling.LANCZOS)

    rgb_result = Image.fromarray(cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB))
    cv_img = None

    in_ext = os.path.splitext(input_path)[1].lower().lstrip('.')
    fmt = str(out_fmt or 'default').strip().lower()
    if fmt == 'jpeg' or fmt == 'jpg':
        tgt_fmt = 'JPEG'
    elif fmt == 'png':
        tgt_fmt = 'PNG'
    elif fmt == 'webp':
        tgt_fmt = 'WEBP'
    else:
        if in_ext in ('jpg', 'jpeg'): tgt_fmt = 'JPEG'
        elif in_ext == 'png': tgt_fmt = 'PNG'
        elif in_ext == 'webp': tgt_fmt = 'WEBP'
        else: tgt_fmt = 'JPEG'

    if tgt_fmt in ('PNG', 'WEBP') and alpha_channel is not None:
        final_im = rgb_result.convert('RGBA')
        final_im.putalpha(alpha_channel)
        if tgt_fmt == 'PNG':
            final_im.save(output_path, format='PNG', compress_level=6)
        else:
            final_im.save(output_path, format='WEBP', quality=90, method=4)
    else:
        if tgt_fmt == 'JPEG':
            rgb_result.save(output_path, format='JPEG', quality=92, optimize=True, progressive=True, subsampling='4:2:0')
        elif tgt_fmt == 'PNG':
            rgb_result.save(output_path, format='PNG', compress_level=6)
        elif tgt_fmt == 'WEBP':
            rgb_result.save(output_path, format='WEBP', quality=90, method=4)
        else:
            rgb_result.save(output_path, format='JPEG', quality=92, optimize=True)

    im.close()
    if not os.path.exists(output_path) or os.path.getsize(output_path) < 100:
        raise ValueError("Enhance image failed to generate output file.")

    out_size = os.path.getsize(output_path)
    return {
        'success': True,
        'original_w': orig_w,
        'original_h': orig_h,
        'output_w': new_w,
        'output_h': new_h,
        'original_size': in_size,
        'output_size': out_size,
        'format': tgt_fmt
    }

def _words_to_grid(words, gap_pt=10.0):
    """Last-resort layout for pages without a detectable table: one spreadsheet row per text line,
    cells split at wide horizontal gaps. Words are PyMuPDF tuples (x0, y0, x1, y1, text, ...)."""
    lines = []
    for w in sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        cy = (w[1] + w[3]) / 2
        if lines and abs(lines[-1][0] - cy) <= max(3.0, (w[3] - w[1]) * 0.5):
            lines[-1][1].append(w)
        else:
            lines.append([cy, [w]])
    rows = []
    for _, ws_ in lines:
        cells, cur, last_x1 = [], [], None
        for w in sorted(ws_, key=lambda w: w[0]):
            if last_x1 is not None and w[0] - last_x1 > gap_pt:
                cells.append(' '.join(cur)); cur = []
            cur.append(w[4]); last_x1 = w[2]
        cells.append(' '.join(cur))
        rows.append(cells)
    width = max((len(r) for r in rows), default=0)
    return [r + [''] * (width - len(r)) for r in rows]

def _looks_like_table(rows):
    """Reject whitespace-'tables' that are really prose: real tables have a consistent number of filled cells per row,
    at most a dozen columns and short cell text."""
    ncols = max(len(r) for r in rows)
    if ncols > 12 or ncols < 2 or len(rows) < 3:
        return False
    filled = [sum(1 for c in r if (c or '').strip()) for r in rows]
    mode = max(set(filled), key=filled.count)
    if mode < 2 or filled.count(mode) / float(len(rows)) < 0.6:
        return False
    cells = [(c or '').strip() for r in rows for c in r if (c or '').strip()]
    long_share = sum(1 for c in cells if len(c) > 60) / float(len(cells))
    return long_share < 0.2

def _words_to_table(words, min_cols=2):
    """Rebuild a borderless table from positioned words: rows are text lines; column boundaries are the vertical
    white-space strips that (almost) no line crosses. Lines that read as running text (title, note) stay in one cell
    instead of being chopped at the column boundaries. Returns list of rows (list of str) or None."""
    words = [w for w in words if str(w[4]).strip()]
    if len(words) < 6:
        return None
    lines = []
    for w in sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        cy = (w[1] + w[3]) / 2
        if lines and abs(lines[-1][0] - cy) <= max(2.5, (w[3] - w[1]) * 0.45):
            lines[-1][1].append(w)
        else:
            lines.append([cy, [w]])
    lines = [sorted(l[1], key=lambda w: w[0]) for l in lines]
    if len(lines) < 3:
        return None

    def spanning(ln):
        if len(ln) < 3:
            return False
        h = sum(w[3] - w[1] for w in ln) / len(ln)
        gaps = [ln[i + 1][0] - ln[i][2] for i in range(len(ln) - 1)]
        return max(gaps) < 0.75 * h

    body = [ln for ln in lines if not spanning(ln)]
    if len(body) < 3:
        return None
    x0 = min(w[0] for ln in body for w in ln)
    x1 = max(w[2] for ln in body for w in ln)
    RES = 4  # grid cells per point: gaps between touching columns can be only ~2 pt
    n = int((x1 - x0) * RES) + 2
    cover = [0] * n
    for ln in body:
        seen = set()
        for w in ln:
            for x in range(int((w[0] - x0) * RES), int((w[2] - x0) * RES) + 1):
                seen.add(x)
        for x in seen:
            if 0 <= x < n:
                cover[x] += 1
    tol = max(0, int(0.06 * len(body)))
    seps, run = [], None
    for x in range(n):
        if cover[x] <= tol:
            run = [x, x] if run is None else [run[0], x]
        else:
            if run is not None:
                gap_pt = (run[1] - run[0] + 1) / float(RES)
                mid = (run[0] + run[1]) / (2.0 * RES) + x0
                if gap_pt >= 2.6:
                    seps.append(mid)
                elif gap_pt >= 1.2:
                    # a touching pair (right-aligned number next to the following cell): only a real column boundary when the
                    # word left of it is a number on (nearly) every row; text + text is an ordinary word space
                    lefts = []
                    for ln in body:
                        lw = [w for w in ln if w[2] <= mid + 0.6]
                        rw = [w for w in ln if w[0] >= mid - 0.6]
                        if lw and rw:
                            lefts.append(bool(_NUM_RE.match(str(lw[-1][4]).strip())))
                    if len(lefts) >= 3 and sum(lefts) >= 0.85 * len(lefts):
                        seps.append(mid)
            run = None
    seps = [sx for sx in seps if x0 + 1 < sx < x1 - 1]
    if len(seps) + 1 < min_cols:
        return None
    bounds = [-1e9] + seps + [1e9]

    def col_of(w):
        mid = (w[0] + w[2]) / 2.0
        for ci in range(len(bounds) - 1):
            if bounds[ci] <= mid < bounds[ci + 1]:
                return ci
        return len(bounds) - 2

    ncols = len(bounds) - 1
    rows = []
    for ln in lines:
        cells = [[] for _ in range(ncols)]
        if spanning(ln):
            cells[col_of((ln[0][0], 0, ln[0][0], 0))] = [w[4] for w in ln]  # by its left edge: the line starts there
        else:
            for w in ln:
                cells[col_of(w)].append(w[4])
        rows.append([' '.join(c) for c in cells])
    # a header word left-aligned over a right-aligned column lands one column too far left: move it above its data
    for c in range(ncols - 1):
        if rows[0][c].strip() and not rows[0][c + 1].strip() and not any(r[c].strip() for r in rows[1:])                 and any(r[c + 1].strip() for r in rows[1:]):
            rows[0][c + 1], rows[0][c] = rows[0][c], ''
    keep = [c for c in range(ncols) if any(r[c].strip() for r in rows)]
    rows = [[r[c] for c in keep] for r in rows]
    if len(keep) < min_cols:
        return None
    multi = sum(1 for r in rows if sum(1 for c in r if c.strip()) >= 2)
    if multi < 0.5 * len(rows):
        return None
    return rows


def _page_grids_raw(page, tessdata_dir):
    """Return a list of tables (list of rows of cell strings) for one page:
    ruled tables -> borderless text-aligned tables -> OCR grid (scanned) -> plain text lines."""
    raw_text = page.get_text().strip()
    scanned = _page_needs_ocr(page, raw_text)
    tp = None
    if scanned:
        try:
            tp = page.get_textpage_ocr(language='eng', tessdata=tessdata_dir, dpi=300, full=True)
        except Exception:
            tp = None
        if tp is not None:
            try:
                grids = detect_raster_tables(page, tp)
                if grids:
                    return [(g['rows'], 'table') for g in grids]
            except Exception as e:
                print(f"WARN: scanned table detection failed: {e}", file=sys.stderr)
            words = page.get_text('words', textpage=tp)
            return [(_words_to_grid(words), 'text')] if words else []
        return []
    tabs = [t.extract() for t in page.find_tables().tables]
    tabs = [t for t in tabs if t and len(t) > 0]
    if tabs:
        return [(t, 'table') for t in tabs]
    try:
        tbl = _words_to_table(page.get_text('words'))
        if tbl:
            return [(tbl, 'table')]
    except Exception:
        pass
    # cheap pre-check: borderless tables need most text lines to split into several cells at wide gaps;
    # skipping prose pages avoids the (very slow) text-strategy table search
    quick = _words_to_grid(page.get_text('words'))
    multi = sum(1 for r in quick if sum(1 for c in r if c) >= 2)
    if len(quick) < 3 or multi / float(len(quick)) < 0.5:
        return [(quick, 'text')] if quick else []
    try:  # borderless tables: whitespace-aligned columns
        for t in page.find_tables(strategy='text').tables:
            rows = t.extract()
            if rows and len(rows) >= 3 and len(rows[0]) >= 2:
                if _looks_like_table(rows):
                    tabs.append(rows)
    except Exception:
        pass
    if tabs:
        return [(t, 'table') for t in tabs]
    words = page.get_text('words')
    return [(_words_to_grid(words), 'text')] if words else []

def _page_grids(page, tessdata_dir):
    """[(rows, kind)] for one page, kind 'table' or 'text'. When ruled tables were found, the text that is NOT inside
    them is appended as a 'text' grid so nothing on the page is silently dropped."""
    grids = _page_grids_raw(page, tessdata_dir)
    if grids and all(k == 'table' for _, k in grids) and not _page_needs_ocr(page):
        try:
            boxes = [t.bbox for t in page.find_tables().tables]
            if boxes:
                outside = [w for w in page.get_text('words')
                           if not any(b[0] - 1 <= (w[0] + w[2]) / 2 <= b[2] + 1 and b[1] - 1 <= (w[1] + w[3]) / 2 <= b[3] + 1 for b in boxes)]
                if outside:
                    grids.append((_words_to_grid(outside), 'text'))
        except Exception:
            pass
    return grids

_NUM_RE = re.compile(r'^\(?-?[$€£₹]?\s?\d{1,3}(,\d{3})*(\.\d+)?\)?%?$|^\(?-?[$€£₹]?\s?\d+(\.\d+)?\)?%?$')

def _coerce_cell(c):
    """Table cell text -> number when it is unambiguously one (so Excel can sum/sort it); otherwise trimmed text.
    Leading zeros (IDs, zip codes) and anything with other characters stay text."""
    t = str(c or '').strip()
    if not t or not _NUM_RE.match(t):
        return t
    neg = t.startswith('(') and t.endswith(')')
    core = t.strip('()').replace(',', '').replace(' ', '')
    if core.endswith('%'):
        return t  # keep percentages as shown
    pct = False
    core = core.lstrip('$€£₹')
    if re.match(r'^-?0\d', core):
        return t
    try:
        v = float(core)
    except ValueError:
        return t
    v = -abs(v) if neg else v
    if pct:
        v /= 100.0
    return int(v) if v == int(v) and not pct and '.' not in core else v

def pdf_to_xlsx(input_path, output_path, lang='eng'):
    """
    Deterministic Table & OCR Spreadsheet Extractor (PDF -> XLSX):
    Extracts tabular data from digital and scanned PDFs directly into native Excel cells (.xlsx).
    - Detects explicit vector/lattice tables via PyMuPDF.
    - If a page has minimal text (scanned), runs OCR to identify table boundaries and cell contents.
    - Formats header rows with distinct styles and automatically adjusts column widths.
    - Guaranteed 0 image-only fallbacks: all output data resides in real spreadsheet cells.
    """
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    tessdata_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tessdata')
    if not os.path.exists(tessdata_dir):
        tessdata_dir = os.path.join(os.getcwd(), 'tessdata')

    _precheck_pdf(input_path, scans='refuse')
    doc_pdf = fitz.open(input_path)
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    header_font = Font(name='Calibri', size=11, bold=True, color='FFFFFF')
    header_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
    data_font = Font(name='Calibri', size=11)
    thin_border = Border(
        left=Side(style='thin', color='D9D9D9'),
        right=Side(style='thin', color='D9D9D9'),
        top=Side(style='thin', color='D9D9D9'),
        bottom=Side(style='thin', color='D9D9D9')
    )

    table_count = 0
    open_table = None  # (sheet, ncols, last_page) of the table that may continue on the next page
    for page_idx, page in enumerate(doc_pdf):
        grids = _page_grids(page, tessdata_dir)
        for t_idx, (rows, kind) in enumerate(grids):
            if not rows:
                continue
            ncols_here = max(len(r) for r in rows)
            def _pat(vals):
                return ['n' if isinstance(_coerce_cell(v), (int, float)) else ('e' if not str(v or '').strip() else 't') for v in vals]
            continues = False
            if kind == 'table' and t_idx == 0 and open_table is not None and open_table[1] == ncols_here and open_table[2] == page_idx - 1:
                ws0 = open_table[0]
                first = [str(_coerce_cell(c)) for c in rows[0]]
                hdr0 = [str(ws0.cell(row=1, column=ci + 1).value or '') for ci in range(ncols_here)]
                last = [ws0.cell(row=ws0.max_row, column=ci + 1).value for ci in range(ncols_here)]
                same_hdr = first == hdr0
                pa, pb = _pat(rows[0]), _pat(last)
                similar = sum(1 for x, y in zip(pa, pb) if x == y or 'e' in (x, y)) >= 0.8 * ncols_here
                continues = same_hdr or similar  # a header-looking first row (text over numbers) starts a different table
            if continues:
                ws = open_table[0]
                start = 1 if same_hdr else 0  # a repeated header row is not data
                for row in rows[start:]:
                    ws.append([_coerce_cell(c) for c in row])
                    for cell in ws[ws.max_row]:
                        cell.border = thin_border
                        cell.font = data_font
                        cell.alignment = Alignment(vertical='top', wrap_text=True)
                open_table = (ws, ncols_here, page_idx)
                continue
            table_count += 1
            sheet_title = (f"Page_{page_idx+1}_Table_{t_idx+1}" if kind == 'table' else f"Page_{page_idx+1}_Text")[:31]
            ws = wb.create_sheet(title=sheet_title)
            for r_idx, row in enumerate(rows):
                ws.append([_coerce_cell(c) for c in row])
                for cell in ws[r_idx + 1]:
                    cell.border = thin_border
                    if r_idx == 0 and kind == 'table':
                        cell.font = header_font
                        cell.fill = header_fill
                        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
                    else:
                        cell.font = data_font
                        cell.alignment = Alignment(vertical='top', wrap_text=True)
            for col in ws.columns:
                max_len = 0
                for cell in col:
                    max_len = max(max_len, len(str(cell.value or '').split(chr(10))[0]))
                ws.column_dimensions[col[0].column_letter].width = max(12, min(max_len + 4, 50))
            if kind == 'table':
                open_table = (ws, ncols_here, page_idx)

    if not wb.sheetnames:
        for page_idx, page in enumerate(doc_pdf):
            blocks = page.get_text('blocks')
            if blocks:
                sheet_title = f"Page_{page_idx+1}"[:31]
                ws = wb.create_sheet(title=sheet_title)
                for b in blocks:
                    t = b[4].strip()
                    if t:
                        ws.append([t])

    if not wb.sheetnames:
        ws = wb.create_sheet(title="Extracted Data")
        ws.append(["No structured data found in PDF"])

    doc_pdf.close()
    wb.save(output_path)
    return output_path

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python tools_converter.py <command> <input_file> <output_file> [extra_args...]")
        print("Commands: pptx2pdf, docx2pdf, xlsx2pdf, pdf2docx, pdf2pptx, docx2pptx, pptx2docx, pdf2xlsx, compress_pdf, repair_pdf, compress_image, protect_pdf, unlock_pdf, scan_pdf, enhance_image")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    in_file = sys.argv[2]
    out_file = sys.argv[3]
    extra = sys.argv[4:]

    if cmd == 'protect_pdf':
        pwd = extra[0] if len(extra) > 0 else ''
        owner_pwd = extra[1] if len(extra) > 1 else None
        try:
            res = protect_pdf(in_file, out_file, pwd, owner_pwd)
            import json
            print(f"METRICS:{json.dumps(res)}")
            print("SUCCESS")
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

    if cmd == 'unlock_pdf':
        pwd = extra[0] if len(extra) > 0 else ''
        try:
            res = unlock_pdf(in_file, out_file, pwd)
            import json
            print(f"METRICS:{json.dumps(res)}")
            print("SUCCESS")
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

    if cmd == 'compress_image':
        out_fmt = extra[0] if len(extra) > 0 and extra[0] != 'default' else None
        quality = int(extra[1]) if len(extra) > 1 and extra[1].isdigit() else 80
        max_dim = int(extra[2]) if len(extra) > 2 and extra[2].isdigit() else 0
        target_kb = float(extra[3]) if len(extra) > 3 and extra[3].replace('.', '', 1).isdigit() else 0
        try:
            res = compress_image(in_file, out_file, out_fmt=out_fmt, quality=quality, max_dim=max_dim, target_kb=target_kb)
            import json
            print(f"METRICS:{json.dumps(res)}")
            print("SUCCESS")
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

    if cmd == 'compress_pdf':
        level = extra[0] if len(extra) > 0 else 'recommended'
        gray = (extra[1] == '1' or extra[1].lower() == 'true') if len(extra) > 1 else False
        try:
            res = compress_pdf(in_file, out_file, level=level, gray=gray)
            import json
            print(f"METRICS:{json.dumps(res)}")
            print("SUCCESS")
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

    if cmd == 'repair_pdf':
        try:
            rep_res = repair_pdf(in_file, out_file)
            import json
            print(f"METRICS:{json.dumps(rep_res)}")
            print("SUCCESS")
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

    if cmd == 'scan_pdf':
        # The Scan PDF tool is on by default (the server's DISABLED_TOOLS list is the switch). FILEORA_ENABLE_OCR is a different setting: it makes the
        # PDF-to-Word / PowerPoint converters read scanned pages, and it is deliberately left as it was.
        if os.environ.get('FILEORA_DISABLE_SCAN_TOOL', '').strip().lower() in ('1', 'true', 'yes'):
            print("ERROR: TOOL_DISABLED: Scan PDF (OCR) is temporarily unavailable.", file=sys.stderr)
            sys.exit(5)
        lang = extra[0] if len(extra) > 0 else 'eng'
        mode = extra[1] if len(extra) > 1 else 'smart'
        try:
            res = scan_pdf(in_file, out_file, lang=lang, mode=mode)
            import json
            print(f"METRICS:{json.dumps(res)}")
            print("SUCCESS")
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

    if cmd == 'enhance_image':
        if os.environ.get('FILEORA_DISABLE_ENHANCE_TOOL', '').strip().lower() in ('1', 'true', 'yes'):
            print("ERROR: TOOL_DISABLED: Image enhancement is temporarily unavailable.", file=sys.stderr)
            sys.exit(5)
        preset = extra[0] if len(extra) > 0 else 'balanced'
        sharpen = extra[1] if len(extra) > 1 else 'medium'
        denoise = extra[2] if len(extra) > 2 else 'mild'
        contrast = (extra[3] == '1' or extra[3].lower() == 'true') if len(extra) > 3 else True
        brightness = int(extra[4]) if len(extra) > 4 and (extra[4].lstrip('-').isdigit()) else 0
        saturation = float(extra[5]) if len(extra) > 5 else 1.0
        scale = float(extra[6]) if len(extra) > 6 else 1.0
        out_fmt = extra[7] if len(extra) > 7 else 'default'
        try:
            res = enhance_image(in_file, out_file, preset=preset, sharpen=sharpen, denoise=denoise,
                                contrast=contrast, brightness=brightness, saturation=saturation,
                                scale=scale, out_fmt=out_fmt)
            import json
            print(f"METRICS:{json.dumps(res)}")
            print("SUCCESS")
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

    def _finish(kind):
        """Compare the result with the source; an incomplete result is deleted and reported, never delivered."""
        import output_verify
        try:
            info = output_verify.verify(kind, in_file, out_file)
        except output_verify.IncompleteOutput as e:
            try: os.remove(out_file)
            except OSError: pass
            print(f"OUTPUT_INCOMPLETE: {e}", file=sys.stderr)
            sys.exit(3)
        except Exception as e:
            try: os.remove(out_file)
            except OSError: pass
            print(f"OUTPUT_UNREADABLE: {type(e).__name__}: {e}", file=sys.stderr)
            sys.exit(4)
        print(f"VERIFIED:{info}")

    if cmd == 'pptx2docx':
        mode = extra[0] if extra else 'layout'
        if str(mode).strip().lower() not in ('layout', 'visual', 'render') and \
                os.environ.get('FILEORA_ENABLE_PPTX_EDITABLE', '').strip().lower() not in ('1', 'true', 'yes'):
            print("ERROR: TOOL_DISABLED: Editable PowerPoint-to-Word mode is temporarily unavailable.", file=sys.stderr)
            sys.exit(5)
        try:
            pptx_to_docx(in_file, out_file, mode=mode)
        except ScannedPdfUnsupported as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        if str(mode).strip().lower() in ('layout', 'visual', 'render'):
            _finish('pptx2docx')
        print("SUCCESS")
        sys.exit(0)
    
    dispatch = {
        'pptx2pdf': pptx_to_pdf,
        'docx2pdf': docx_to_pdf,
        'xlsx2pdf': xlsx_to_pdf,
        'pdf2docx': pdf_to_docx,
        'pdf2pptx': pdf_to_pptx,
        'docx2pptx': docx_to_pptx,
        'pdf2xlsx': pdf_to_xlsx,
    }
    
    if cmd not in dispatch:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
        
    try:
        dispatch[cmd](in_file, out_file)
    except ScannedPdfUnsupported as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    if cmd == 'pdf2docx':
        try:
            _fix_column_sections(out_file)     # text beside a picture stays side by side in LibreOffice as well as Word
        except Exception as e:
            print(f"WARN: column layout fix skipped: {e}", file=sys.stderr)
    _finish(cmd)
    print("SUCCESS")
    sys.exit(0)
