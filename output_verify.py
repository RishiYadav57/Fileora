"""Completeness check for converted files.

A converter that runs out of memory, is killed, or silently drops content can still leave a file that opens (a 12-page Word
document turned into a 3-page PDF, a 38 KB Word file turned into a 3 KB stub). Size and "does it parse" checks do not catch that.
This module compares the text of the source with the text of the result and fails when a meaningful part is missing.

    python output_verify.py <kind> <source> <result>      exit 0 = complete, exit 3 = incomplete (reason on stderr)

kinds: docx2pdf pptx2pdf xlsx2pdf pdf2docx pdf2pptx pdf2xlsx docx2pptx pptx2docx

The checks are deliberately tolerant of formatting differences (they compare words, not layout) and skip themselves when the
source has too little text to judge; they are meant to catch truncation and stubs, not to grade fidelity.
"""
import html
import re
import sys
import unicodedata
import zipfile


class IncompleteOutput(Exception):
    """The converted file is missing a meaningful part of the source."""


_WORD = re.compile(r'[^\W\d_]+', re.UNICODE)
_CJK = re.compile(r'[぀-ヿ㐀-䶿一-鿿가-힯]')
MIN_TOKENS = 12          # below this the source carries too little text for a word comparison to mean anything


def tokens(text):
    """Comparable word list: NFKC-folded (ligatures, full-width forms), lower-case, words of 3+ letters; CJK as character pairs."""
    out = []
    for w in _WORD.findall(unicodedata.normalize('NFKC', text or '').lower()):
        if _CJK.search(w):
            out.extend([w] if len(w) == 1 else [w[i:i + 2] for i in range(len(w) - 1)])
        elif len(w) >= 3:
            out.append(w)
    return out


def _chars(text):
    return len(re.sub(r'\s+', '', text or ''))


def check_text(label, src_text, out_text, min_cov=0.8, min_ratio=0.6, min_tail=0.6):
    """Raise IncompleteOutput when the result is missing words of the source. Returns metrics."""
    st = tokens(src_text)
    metrics = {'src_words': len(st)}
    if len(st) < MIN_TOKENS:
        metrics['skipped'] = 'too little source text'
        return metrics
    ordered = list(dict.fromkeys(st))
    out_set = set(tokens(out_text))
    cov = sum(1 for t in ordered if t in out_set) / len(ordered)
    tail = ordered[-max(8, len(ordered) // 6):]          # the end of the document: truncation loses this first
    tail_cov = sum(1 for t in tail if t in out_set) / len(tail)
    ratio = _chars(out_text) / max(1, _chars(src_text))
    metrics.update(coverage=round(cov, 3), tail_coverage=round(tail_cov, 3), char_ratio=round(ratio, 3))
    if cov < min_cov or tail_cov < min_tail or ratio < min_ratio:
        raise IncompleteOutput(
            f'{label}: only {cov:.0%} of the words ({tail_cov:.0%} of the end of the document) and {ratio:.0%} of the text of the source '
            f'are present in the result')
    return metrics


# ------------------------------------------------------------------ text extraction
def _xml_text(xml, tag):
    return ' '.join(html.unescape(m) for m in re.findall(r'<%s(?:\s[^>]*)?>([^<]*)</%s>' % (tag, tag), xml))


def docx_text(path):
    with zipfile.ZipFile(path) as z:
        return _xml_text(z.read('word/document.xml').decode('utf8', 'replace'), 'w:t')


def pptx_slides(path, visible_only=True):
    """[(slide xml)] in slide order; hidden slides (show="0") are left out because PowerPoint/LibreOffice do not print them."""
    with zipfile.ZipFile(path) as z:
        names = sorted((n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)), key=lambda n: int(re.search(r'(\d+)', n.rsplit('/', 1)[1]).group(1)))
        slides = [z.read(n).decode('utf8', 'replace') for n in names]
    if visible_only:
        slides = [x for x in slides if not re.search(r'<p:sld\b[^>]*\bshow="(0|false)"', x[:2000])]
    return slides


def pptx_text(path):
    return ' '.join(_xml_text(x, 'a:t') for x in pptx_slides(path))


def xlsx_cells(path):
    """(text of visible sheets, number of non-empty cells)."""
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        shared = []
        if 'xl/sharedStrings.xml' in names:
            sx = z.read('xl/sharedStrings.xml').decode('utf8', 'replace')
            for si in re.findall(r'<si\b[^>]*>(.*?)</si>', sx, flags=re.S):
                shared.append(html.unescape(' '.join(re.findall(r'<t(?:\s[^>]*)?>([^<]*)</t>', si))))
        wb = z.read('xl/workbook.xml').decode('utf8', 'replace')
        rels = z.read('xl/_rels/workbook.xml.rels').decode('utf8', 'replace') if 'xl/_rels/workbook.xml.rels' in names else ''
        target = {}
        for m in re.finditer(r'<Relationship\b([^>]*)/?>', rels):
            a = m.group(1)
            i, t = re.search(r'\bId="([^"]+)"', a), re.search(r'\bTarget="([^"]+)"', a)
            if i and t:
                target[i.group(1)] = t.group(1).lstrip('/')
        parts, count = [], 0
        for m in re.finditer(r'<sheet\b([^>]*)/?>', wb):
            a = m.group(1)
            if re.search(r'\bstate="(hidden|veryHidden)"', a):
                continue
            rid = re.search(r'\br:id="([^"]+)"', a)
            tgt = target.get(rid.group(1)) if rid else None
            if not tgt:
                continue
            part = tgt if tgt.startswith('xl/') else 'xl/' + tgt
            if part not in names:
                continue
            sx = z.read(part).decode('utf8', 'replace')
            for cm in re.finditer(r'<c\b([^>]*?)(?:/>|>(.*?)</c>)', sx, flags=re.S):
                attrs, body = cm.group(1), cm.group(2) or ''
                if not body:
                    continue
                if re.search(r'\bt="s"', attrs):
                    v = re.search(r'<v>(\d+)</v>', body)
                    if v and int(v.group(1)) < len(shared):
                        parts.append(shared[int(v.group(1))])
                        count += 1
                elif re.search(r'\bt="inlineStr"', attrs):
                    parts.append(html.unescape(' '.join(re.findall(r'<t(?:\s[^>]*)?>([^<]*)</t>', body))))
                    count += 1
                elif re.search(r'<v>[^<]+</v>', body):
                    count += 1
        return ' '.join(parts), count


def sniff(path):
    """'docx' | 'pptx' | 'xlsx' by the package parts, None when the file is not an Office package."""
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
    except Exception:
        return None
    for part, kind in (('word/document.xml', 'docx'), ('ppt/presentation.xml', 'pptx'), ('xl/workbook.xml', 'xlsx')):
        if part in names:
            return kind
    return None


def scan_page_count(path):
    """Pages that are scans: (almost) no text and a picture over at least a quarter of the page (the converter's own rule)."""
    import fitz
    doc = fitz.open(path)
    try:
        n = 0
        for p in doc:
            area = p.rect.width * p.rect.height
            big = area > 0 and any((i['bbox'][2] - i['bbox'][0]) * (i['bbox'][3] - i['bbox'][1]) >= 0.25 * area for i in p.get_image_info())
            if big and len(p.get_text().strip()) < 10:
                n += 1
        return n
    finally:
        doc.close()


def pdf_pages_text(path):
    import fitz
    doc = fitz.open(path)
    try:
        return len(doc), '\n'.join(p.get_text() for p in doc)
    finally:
        doc.close()


def _csv_text(path):
    raw = open(path, 'rb').read()
    for enc in ('utf-8-sig', 'utf-16', 'cp1252'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode('latin1')


# ------------------------------------------------------------------ the checks
def verify(kind, src, out):
    """Raise IncompleteOutput if `out` does not hold the content of `src`. Returns a metrics dict."""
    kind = kind.lower()
    if kind in ('docx2pdf', 'pptx2pdf', 'xlsx2pdf'):
        pages, out_text = pdf_pages_text(out)
        if pages < 1:
            raise IncompleteOutput('the PDF has no pages')
        # LibreOffice converts by content, not by file name: judge the source by what it really is
        actual = sniff(src) or ('csv' if src.lower().endswith('.csv') else None)
        if actual == 'docx':
            src_text, mc = docx_text(src), 0.8
        elif actual == 'pptx':
            slides = pptx_slides(src)
            if slides and pages < len(slides):
                raise IncompleteOutput(f'the PDF has {pages} pages for {len(slides)} slides')
            src_text, mc = pptx_text(src), 0.8
        elif actual == 'csv':
            src_text, mc = _csv_text(src), 0.7
        elif actual == 'xlsx':
            src_text, mc = xlsx_cells(src)[0], 0.7
        else:
            return {'pages': pages, 'skipped': 'source format not compared'}
        m = check_text(kind, src_text, out_text, min_cov=mc, min_ratio=0.5)
        m['pages'] = pages
        return m

    if kind == 'pdf2docx':
        pages, src_text = pdf_pages_text(src)
        m = check_text(kind, src_text, docx_text(out), min_cov=0.8, min_ratio=0.6)
        m['pages'] = pages
        scans = scan_page_count(src)
        if scans:
            # scanned pages have no text to compare: they must be there as pictures, and an all-scanned file as one section per page
            with zipfile.ZipFile(out) as z:
                xml = z.read('word/document.xml').decode('utf8', 'replace')
            pics = xml.count('<w:drawing')
            if pics < scans:
                raise IncompleteOutput(f'{scans} scanned pages but only {pics} pictures in the Word file')
            if scans == pages and xml.count('<w:sectPr') != pages:
                raise IncompleteOutput(f'{pages} scanned pages but {xml.count("<w:sectPr")} sections in the Word file')
            m.update(scanned_pages=scans, pictures=pics)
        return m

    if kind == 'pdf2pptx':
        pages, src_text = pdf_pages_text(src)
        slides = pptx_slides(out, visible_only=False)
        if len(slides) < pages:
            raise IncompleteOutput(f'{len(slides)} slides were produced for {pages} PDF pages')
        m = check_text(kind, src_text, pptx_text(out), min_cov=0.75, min_ratio=0.5)
        m.update(pages=pages, slides=len(slides))
        scans = scan_page_count(src)
        if scans:
            pics = sum(x.count('<p:pic>') + x.count('<p:pic ') for x in slides)
            if pics < scans:
                raise IncompleteOutput(f'{scans} scanned pages but only {pics} pictures in the presentation')
            m.update(scanned_pages=scans, pictures=pics)
        return m

    if kind == 'pdf2xlsx':
        pages, src_text = pdf_pages_text(src)
        out_text, cells = xlsx_cells(out)
        if cells < 1 and len(tokens(src_text)) >= MIN_TOKENS:
            raise IncompleteOutput('the spreadsheet has no data cells')
        m = check_text(kind, src_text, out_text, min_cov=0.6, min_ratio=0.3, min_tail=0.4)
        m.update(pages=pages, cells=cells)
        return m

    if kind == 'docx2pptx':
        slides = pptx_slides(out, visible_only=False)
        if not slides:
            raise IncompleteOutput('no slides were produced')
        m = check_text(kind, docx_text(src), pptx_text(out), min_cov=0.75, min_ratio=0.5)
        m['slides'] = len(slides)
        return m

    if kind == 'pptx2docx':
        # layout mode: one picture/page per visible slide; editable mode: the slide text is present as text
        with zipfile.ZipFile(out) as z:
            media = [n for n in z.namelist() if n.startswith('word/media/')]
            body = z.read('word/document.xml').decode('utf8', 'replace')
        slides = pptx_slides(src)
        out_text = docx_text(out)
        if media and len(tokens(out_text)) < MIN_TOKENS:
            if len(media) < len(slides):
                raise IncompleteOutput(f'{len(media)} slide images for {len(slides)} slides')
            return {'slides': len(slides), 'images': len(media)}
        m = check_text(kind, pptx_text(src), out_text, min_cov=0.7, min_ratio=0.5)
        m['slides'] = len(slides)
        return m

    raise ValueError(f'unknown kind: {kind}')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print('Usage: python output_verify.py <kind> <source> <result>', file=sys.stderr)
        sys.exit(2)
    try:
        info = verify(sys.argv[1], sys.argv[2], sys.argv[3])
        print('OK ' + repr(info))
        sys.exit(0)
    except IncompleteOutput as e:
        print(f'OUTPUT_INCOMPLETE: {e}', file=sys.stderr)
        sys.exit(3)
    except Exception as e:
        print(f'OUTPUT_UNREADABLE: {type(e).__name__}: {e}', file=sys.stderr)
        sys.exit(4)
