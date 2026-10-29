import csv
import io
import os
from typing import Dict, List, Optional

# Optional OCR backends
_easyocr_available = False
_pytesseract_available = False
_pdfminer_available = False
_pypdf_available = False
_pdfminer_extract = None
_PdfReader = None

try:  # EasyOCR (Apache-2.0, ok for commercial use)
    import easyocr  # type: ignore
    _easyocr_available = True
except Exception:
    easyocr = None  # type: ignore

try:  # pytesseract fallback
    import pytesseract  # type: ignore
    from PIL import Image  # type: ignore
    _pytesseract_available = True
except Exception:
    pytesseract = None  # type: ignore
    Image = None  # type: ignore

try:  # pdfminer.six — best text-based PDF extraction
    from pdfminer.high_level import extract_text as _pdfminer_extract  # type: ignore
    _pdfminer_available = True
except Exception:
    pass

try:  # pypdf fallback (pypdf or PyPDF2)
    try:
        from pypdf import PdfReader as _PdfReader  # type: ignore
    except Exception:
        from PyPDF2 import PdfReader as _PdfReader  # type: ignore
    _pypdf_available = True
except Exception:
    pass

_fitz_available = False
try:  # PyMuPDF — renders scanned PDF pages as images for OCR
    import fitz  # type: ignore
    _fitz_available = True
except Exception:
    fitz = None  # type: ignore

# Minimum characters from text extraction before we assume a scanned PDF
_SCANNED_THRESHOLD = 80


class OcrReader:
    """Lightweight OCR / text-extraction helper.

    - Images: EasyOCR primary, pytesseract fallback
    - PDFs: pdfminer.six primary, pypdf/PyPDF2 fallback
    - CSV/TSV/TXT: always works (no external deps)
    - Gracefully degrades if backends are missing
    """

    IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}
    PDF_EXTS = {'.pdf'}
    CSV_EXTS = {'.csv', '.tsv', '.txt'}

    def __init__(self, languages: Optional[List[str]] = None):
        self.languages = languages or ['en']
        self._easyocr_reader = None

    def is_available(self) -> bool:
        """True if image OCR or PDF extraction backend is installed."""
        return _easyocr_available or _pytesseract_available or _pdfminer_available or _pypdf_available or _fitz_available

    def backend_name(self) -> Optional[str]:
        if _easyocr_available:
            return 'easyocr'
        if _pytesseract_available:
            return 'pytesseract'
        if _fitz_available:
            return 'pymupdf'
        if _pdfminer_available:
            return 'pdfminer'
        if _pypdf_available:
            return 'pypdf'
        return None

    def info(self) -> Dict:
        return {
            'backend': self.backend_name(),
            'available': self.is_available(),
            'languages': self.languages or [],
        }

    def _ensure_easyocr(self):
        if not _easyocr_available or self._easyocr_reader is not None:
            return
        self._easyocr_reader = easyocr.Reader(self.languages, gpu=False)

    def _extract_image(self, abs_path: str) -> str:
        """Extract text from an image using EasyOCR or pytesseract."""
        if _easyocr_available:
            self._ensure_easyocr()
            if self._easyocr_reader is None:
                return ''
            results = self._easyocr_reader.readtext(abs_path, detail=0)
            return '\n'.join([str(x).strip() for x in results if str(x).strip()]).strip()
        if _pytesseract_available and Image is not None:
            img = Image.open(abs_path)
            return (pytesseract.image_to_string(img) or '').strip()
        return ''

    def _extract_pdf(self, abs_path: str) -> str:
        """Extract text from a PDF.

        Strategy:
          1. Try fast text extraction (pdfminer / pypdf).
          2. If the result looks too sparse (scanned document with no embedded
             text), render each page via PyMuPDF and run image OCR on it.
        """
        text = ''
        if _pdfminer_available and _pdfminer_extract is not None:
            try:
                text = (_pdfminer_extract(abs_path) or '').strip()
            except Exception:
                pass
        if not text and _pypdf_available and _PdfReader is not None:
            try:
                reader = _PdfReader(abs_path)
                pages = [page.extract_text() or '' for page in reader.pages]
                text = '\n'.join(pages).strip()
            except Exception:
                pass

        # If too little text was found, assume scanned PDF and fall back to OCR
        if len(text) < _SCANNED_THRESHOLD:
            ocr_text = self._pdf_ocr_via_render(abs_path)
            if ocr_text:
                return ocr_text

        return text

    def _pdf_ocr_via_render(self, abs_path: str) -> str:
        """Render each PDF page at 200 DPI using PyMuPDF and run image OCR."""
        if not _fitz_available:
            return ''
        if not (_easyocr_available or _pytesseract_available):
            return ''
        try:
            import numpy as np  # type: ignore
            from PIL import Image as _PILImage  # type: ignore
        except Exception:
            return ''

        try:
            doc = fitz.open(abs_path)
        except Exception as e:
            print(f'[ocr_reader] Cannot open PDF: {e}')
            return ''

        page_texts = []
        mat = fitz.Matrix(200 / 72, 200 / 72)  # 200 DPI
        try:
            for page_num, page in enumerate(doc):
                try:
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    img_bytes = pix.tobytes('png')
                    page_text = ''
                    if _easyocr_available:
                        self._ensure_easyocr()
                        if self._easyocr_reader:
                            img_arr = np.array(_PILImage.open(io.BytesIO(img_bytes)))
                            results = self._easyocr_reader.readtext(img_arr, detail=0)
                            page_text = '\n'.join(str(r).strip() for r in results if str(r).strip())
                    elif _pytesseract_available and Image is not None:
                        img = _PILImage.open(io.BytesIO(img_bytes))
                        page_text = (pytesseract.image_to_string(img) or '').strip()
                    if page_text:
                        page_texts.append(f'[Page {page_num + 1}]\n{page_text}')
                except Exception as pe:
                    print(f'[ocr_reader] Page {page_num + 1} OCR failed: {pe}')
        finally:
            doc.close()

        return '\n\n'.join(page_texts).strip()

    def _extract_csv(self, abs_path: str) -> str:
        """Read a CSV/TSV/TXT file and format it as a readable table string."""
        try:
            with open(abs_path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read(20000)  # cap at 20 KB
            try:
                reader = csv.reader(io.StringIO(content))
                rows = list(reader)
                if rows:
                    lines = [' | '.join(str(c).strip() for c in row)
                             for row in rows if any(c.strip() for c in row)]
                    return '\n'.join(lines)
            except Exception:
                pass
            return content.strip()
        except Exception:
            return ''

    def extract_text_for_file(self, abs_path: str) -> str:
        """Dispatch to the right extractor based on file extension."""
        try:
            ext = os.path.splitext(abs_path)[1].lower()
            if ext in self.IMAGE_EXTS:
                return self._extract_image(abs_path)
            if ext in self.PDF_EXTS:
                return self._extract_pdf(abs_path)
            if ext in self.CSV_EXTS:
                return self._extract_csv(abs_path)
            return ''
        except Exception:
            return ''

    def extract_texts(self, abs_paths: List[str]) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for p in abs_paths:
            t = self.extract_text_for_file(p)
            if t:
                out[p] = t
        return out
