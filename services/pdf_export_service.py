import io
import mimetypes
import os
import textwrap
import importlib
from datetime import datetime
from urllib.parse import urlparse


def pdf_dependencies_available() -> bool:
    try:
        importlib.import_module('reportlab')
        importlib.import_module('pypdf')
        return True
    except Exception:
        return False


def _pdf_page_size(size_name):
    key = (size_name or 'A4').strip().upper()
    try:
        pagesizes = importlib.import_module('reportlab.lib.pagesizes')
        A4 = getattr(pagesizes, 'A4')
        LETTER = getattr(pagesizes, 'LETTER')
        LEGAL = getattr(pagesizes, 'LEGAL')
        sizes = {
            'A4': A4,
            'LETTER': LETTER,
            'LEGAL': LEGAL,
        }
        return sizes.get(key, A4), key
    except Exception:
        return (595.275590551, 841.88976378), key


def _resolve_upload_abs_path(url, base_dir):
    if not url:
        return None
    if isinstance(url, dict):
        url = url.get('url') or url.get('storedPath') or ''
    if not isinstance(url, str):
        return None
    candidate = url.strip()
    if candidate.startswith('http://') or candidate.startswith('https://'):
        try:
            parsed = urlparse(candidate)
            candidate = parsed.path or ''
        except Exception:
            return None
    if not candidate.startswith('/uploads/'):
        return None
    rel = os.path.normpath(candidate.lstrip('/'))
    return os.path.join(base_dir, rel)


def _append_scaled_pdf_pages(writer, pdf_path, page_size, top_title=None):
    pypdf_module = importlib.import_module('pypdf')
    PdfReader = getattr(pypdf_module, 'PdfReader')

    src_pdf = PdfReader(pdf_path)
    target_w = float(page_size[0])
    target_h = float(page_size[1])
    margin = 28.0
    title_space = 18.0 if top_title else 0.0

    for src_page in src_pdf.pages:
        src_w = float(src_page.mediabox.width)
        src_h = float(src_page.mediabox.height)
        if src_w <= 0 or src_h <= 0:
            writer.add_page(src_page)
            continue

        scale_x = (target_w - margin * 2) / src_w
        scale_y = (target_h - margin * 2 - title_space) / src_h
        scale = min(scale_x, scale_y)
        draw_w = src_w * scale
        draw_h = src_h * scale
        tx = (target_w - draw_w) / 2
        ty = (target_h - draw_h) / 2
        if top_title:
            ty = min(ty, target_h - margin - title_space - draw_h)

        blank = writer.add_blank_page(width=target_w, height=target_h)
        blank.merge_transformed_page(src_page, (scale, 0, 0, scale, tx, ty))


def _entry_assets(entry):
    assets = []

    for idx, img in enumerate(entry.get('images') or [], start=1):
        url = img.get('url') if isinstance(img, dict) else img
        if isinstance(img, dict) and not url:
            url = img.get('storedPath')
        if not url:
            continue
        assets.append({'label': f'Image {idx}', 'url': url})

    for idx, att in enumerate(entry.get('attachments') or [], start=1):
        if not isinstance(att, dict):
            continue
        url = att.get('url') or att.get('storedPath')
        if not url:
            continue
        assets.append({'label': att.get('name') or f'Attachment {idx}', 'url': url})

    return assets


def _text_pdf_bytes(lines, page_size, title=None):
    canvas_module = importlib.import_module('reportlab.pdfgen.canvas')
    canvas = getattr(canvas_module, 'Canvas')

    out = io.BytesIO()
    c = canvas(out, pagesize=page_size)
    width, height = page_size
    margin_x = 42
    margin_top = height - 50
    margin_bottom = 42

    def draw_header():
        if title:
            c.setFont('Helvetica-Bold', 12)
            c.drawString(margin_x, height - 32, title)
            c.setLineWidth(0.5)
            c.line(margin_x, height - 36, width - margin_x, height - 36)

    draw_header()
    y = margin_top - (14 if title else 0)

    for raw_line in lines:
        line = '' if raw_line is None else str(raw_line)
        wrapped = textwrap.wrap(line, width=110) or ['']
        for part in wrapped:
            if y <= margin_bottom:
                c.showPage()
                draw_header()
                y = margin_top - (14 if title else 0)
            c.setFont('Helvetica', 10)
            c.drawString(margin_x, y, part)
            y -= 14

    c.save()
    out.seek(0)
    return out.getvalue()


def _image_pdf_bytes(image_path, page_size, title):
    canvas_module = importlib.import_module('reportlab.pdfgen.canvas')
    utils_module = importlib.import_module('reportlab.lib.utils')
    canvas = getattr(canvas_module, 'Canvas')
    ImageReader = getattr(utils_module, 'ImageReader')

    out = io.BytesIO()
    c = canvas(out, pagesize=page_size)
    width, height = page_size
    margin = 36

    c.setFont('Helvetica-Bold', 11)
    c.drawString(margin, height - 26, title)

    ir = ImageReader(image_path)
    iw, ih = ir.getSize()
    max_w = width - margin * 2
    max_h = height - margin * 2 - 24
    scale = min(max_w / float(iw), max_h / float(ih)) if iw and ih else 1
    draw_w = iw * scale
    draw_h = ih * scale
    x = (width - draw_w) / 2
    y = (height - draw_h) / 2 - 10
    c.drawImage(ir, x, y, width=draw_w, height=draw_h, preserveAspectRatio=True, mask='auto')
    c.save()
    out.seek(0)
    return out.getvalue()


def _variant_label(variant):
    return 'Finance' if str(variant).lower() == 'finance' else 'Memo'


def _finance_tax_amount(subtotal, tax_value):
    if tax_value is None or tax_value == '':
        return 0.0
    s = str(tax_value).strip()
    if not s:
        return 0.0
    if s.endswith('%'):
        try:
            perc = float(s[:-1])
            return subtotal * (perc / 100.0)
        except Exception:
            return 0.0
    try:
        return float(s)
    except Exception:
        return 0.0


def _finance_summary_values(entry):
    items = entry.get('items') or []
    if items:
        subtotal = 0.0
        for item in items:
            try:
                subtotal += float(item.get('totalPrice') or 0)
            except Exception:
                pass
    else:
        try:
            subtotal = float(entry.get('price') or 0) + float(entry.get('adjustment') or 0)
        except Exception:
            subtotal = 0.0

    tax = _finance_tax_amount(subtotal, entry.get('tax'))
    try:
        total = float(entry.get('total'))
    except Exception:
        total = subtotal + tax

    return subtotal, tax, total


def _fmt_currency(value):
    try:
        return f'${float(value):,.2f}'
    except Exception:
        return '$0.00'


def _build_reportlab_modules():
    styles_module = importlib.import_module('reportlab.lib.styles')
    units_module = importlib.import_module('reportlab.lib.units')
    colors_module = importlib.import_module('reportlab.lib.colors')
    plus_module = importlib.import_module('reportlab.platypus')

    return {
        'getSampleStyleSheet': getattr(styles_module, 'getSampleStyleSheet'),
        'ParagraphStyle': getattr(styles_module, 'ParagraphStyle'),
        'SimpleDocTemplate': getattr(plus_module, 'SimpleDocTemplate'),
        'Paragraph': getattr(plus_module, 'Paragraph'),
        'Spacer': getattr(plus_module, 'Spacer'),
        'Table': getattr(plus_module, 'Table'),
        'TableStyle': getattr(plus_module, 'TableStyle'),
        'inch': getattr(units_module, 'inch'),
        'colors': colors_module,
    }


def _entry_detail_pdf_bytes(entry, idx, total, variant, page_size, normalized_size):
    mods = _build_reportlab_modules()
    getSampleStyleSheet = mods['getSampleStyleSheet']
    ParagraphStyle = mods['ParagraphStyle']
    SimpleDocTemplate = mods['SimpleDocTemplate']
    Paragraph = mods['Paragraph']
    Spacer = mods['Spacer']
    Table = mods['Table']
    TableStyle = mods['TableStyle']
    inch = mods['inch']
    colors = mods['colors']

    out = io.BytesIO()
    doc = SimpleDocTemplate(out, pagesize=page_size, leftMargin=0.55 * inch, rightMargin=0.55 * inch, topMargin=0.6 * inch, bottomMargin=0.55 * inch)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('DocTitle', parent=styles['Title'], fontSize=16, leading=20, spaceAfter=10)
    section_style = ParagraphStyle('Section', parent=styles['Heading3'], fontSize=11, leading=14, spaceAfter=4)
    body_style = ParagraphStyle('Body', parent=styles['BodyText'], fontSize=9.6, leading=13)
    small_style = ParagraphStyle('Small', parent=styles['BodyText'], fontSize=8.8, leading=11)

    variant_label = _variant_label(variant)
    entry_id = str(entry.get('id') or f'entry-{idx}')
    desc = entry.get('description') or '(No description)'
    date_value = entry.get('purchaseDate') if str(variant).lower() == 'finance' else datetime.fromtimestamp((entry.get('ts') or 0) / 1000).strftime('%Y-%m-%d %H:%M:%S')
    tags = entry.get('tags') or []
    assets = _entry_assets(entry)

    story = [Paragraph(f'Detailed Log of {variant_label} in PDF ({normalized_size})', title_style), Paragraph(f'Entry {idx} of {total}', small_style), Spacer(1, 6)]

    meta_rows = [
        ['Entry ID', entry_id],
        ['Category', str(entry.get('category') or 'Uncategorized')],
        ['Date', str(date_value or '')],
        ['Attachments', str(len(assets))],
    ]
    if str(variant).lower() == 'finance':
        subtotal_value, tax_value_calc, total_value_calc = _finance_summary_values(entry)
        meta_rows.extend([
            ['Subtotal', _fmt_currency(subtotal_value)],
            ['Tax', _fmt_currency(tax_value_calc)],
            ['Total', _fmt_currency(total_value_calc)],
        ])

    meta_table = Table(meta_rows, colWidths=[1.2 * inch, None], hAlign='LEFT')
    meta_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#EEF2F7')),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#1F2937')),
        ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#CBD5E1')),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    if str(variant).lower() == 'finance':
        finance_money_labels = {'Subtotal', 'Tax', 'Total'}
        for row_idx, row in enumerate(meta_rows):
            if row and str(row[0]) in finance_money_labels:
                meta_table.setStyle(TableStyle([('ALIGN', (1, row_idx), (1, row_idx), 'RIGHT')]))
    story.extend([meta_table, Spacer(1, 8), Paragraph('Description', section_style), Paragraph(str(desc).replace('\n', '<br/>'), body_style), Spacer(1, 8), Paragraph('Tags', section_style), Paragraph(', '.join(tags) if tags else '(none)', body_style), Spacer(1, 8)])

    if str(variant).lower() == 'finance':
        story.append(Paragraph('Items', section_style))
        items = entry.get('items') or []
        if items:
            item_rows = [['#', 'Name', 'Qty', 'Unit', 'Total']]
            for row_idx, item in enumerate(items, start=1):
                item_rows.append([
                    str(row_idx),
                    str(item.get('name') or ''),
                    str(item.get('amount') if item.get('amount') is not None else ''),
                    _fmt_currency(item.get('unitPrice') if item.get('unitPrice') is not None else 0),
                    _fmt_currency(item.get('totalPrice') if item.get('totalPrice') is not None else 0),
                ])
            items_table = Table(item_rows, colWidths=[0.4 * inch, 2.9 * inch, 0.7 * inch, 0.9 * inch, 0.9 * inch], repeatRows=1)
            items_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E2E8F0')),
                ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#0F172A')),
                ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#CBD5E1')),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 0), (-1, -1), 8.6),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('ALIGN', (2, 1), (4, -1), 'RIGHT'),
                ('ALIGN', (2, 0), (4, 0), 'CENTER'),
                ('LEFTPADDING', (0, 0), (-1, -1), 5),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                ('TOPPADDING', (0, 0), (-1, -1), 3),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ]))
            story.append(items_table)
        else:
            story.append(Paragraph('(no itemized rows)', body_style))
        story.append(Spacer(1, 8))

    story.append(Paragraph('Attached Files (bookmarked in PDF outline)', section_style))
    if assets:
        file_rows = [['No.', 'Label', 'Source URL']]
        for asset_idx, asset in enumerate(assets, start=1):
            file_rows.append([str(asset_idx), str(asset['label']), str(asset['url'])])
        file_table = Table(file_rows, colWidths=[0.4 * inch, 1.9 * inch, None], repeatRows=1)
        file_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E2E8F0')),
            ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#0F172A')),
            ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#CBD5E1')),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 8.2),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        story.append(file_table)
    else:
        story.append(Paragraph('(no attached files)', body_style))

    doc.build(story)
    out.seek(0)
    return out.getvalue()


def _toc_pdf_bytes(entries, entry_page_start, page_offset, variant, page_size, normalized_size):
    canvas_module = importlib.import_module('reportlab.pdfgen.canvas')
    colors_module = importlib.import_module('reportlab.lib.colors')
    canvas = getattr(canvas_module, 'Canvas')
    colors = colors_module

    out = io.BytesIO()
    c = canvas(out, pagesize=page_size)
    width, height = page_size

    margin_x = 34
    margin_top = 38
    margin_bottom = 34
    table_w = width - (margin_x * 2)
    row_h = 16
    header_h = 16
    is_finance = str(variant).lower() == 'finance'
    if is_finance:
        col_ws = [16, 42, 50, 157, 18, 74, 64, 74, 32]
        row_h = 22
    else:
        col_ws = [24, 62, 78, 236, 34, 34]
    if sum(col_ws) < table_w:
        col_ws[-1] += table_w - sum(col_ws)
    elif sum(col_ws) > table_w:
        overflow = sum(col_ws) - table_w
        reducible = max(0, col_ws[3] - 120)
        cut = min(overflow, reducible)
        col_ws[3] -= cut
        overflow -= cut
        if overflow > 0:
            col_ws[-1] = max(20, col_ws[-1] - overflow)

    variant_label = _variant_label(variant)
    link_specs = []
    toc_page = 0
    finance_amount_cols = {5, 6, 7}

    def trim_text(txt, max_len):
        value = '' if txt is None else str(txt)
        return (value[:max_len] + '...') if len(value) > max_len else value

    def clamp_desc_two_lines(txt, width_chars=36):
        raw = '' if txt is None else str(txt)
        wrapped = textwrap.wrap(raw, width=width_chars) or ['']
        truncated = len(wrapped) > 2
        lines = wrapped[:2]
        if truncated:
            line2 = lines[1].rstrip()
            if len(line2) >= 3:
                line2 = line2[:-3].rstrip()
            lines[1] = (line2 + '...') if line2 else '...'
        return lines

    def draw_header(is_cont=False):
        nonlocal y_cursor
        c.setFont('Helvetica-Bold', 15)
        c.setFillColor(colors.HexColor('#0F172A'))
        c.drawString(margin_x, height - margin_top, f'Detailed Log of {variant_label} in PDF ({normalized_size})')
        c.setFont('Helvetica', 9)
        c.setFillColor(colors.HexColor('#334155'))
        subtitle = 'Summary Table / Table of Contents'
        if is_cont:
            subtitle += ' (continued)'
        c.drawString(margin_x, height - margin_top - 14, subtitle)

        y_cursor = height - margin_top - 30

        c.setFillColor(colors.HexColor('#CBD5E1'))
        c.rect(margin_x, y_cursor - header_h, table_w, header_h, fill=1, stroke=0)
        c.setFillColor(colors.HexColor('#0F172A'))
        c.setFont('Helvetica-Bold', 8.0 if is_finance else 8.4)
        headers = ['#', 'Date', 'Category', 'Description', 'Files', 'Page']
        if is_finance:
            headers = ['#', 'Date', 'Category', 'Description', 'Files', 'Subtotal', 'Tax', 'Total', 'Page']
        x = margin_x
        for i, text in enumerate(headers):
            if is_finance and i in finance_amount_cols:
                c.drawRightString(x + col_ws[i] - 3, y_cursor - 10, text)
            else:
                c.drawString(x + 3, y_cursor - 10, text)
            x += col_ws[i]

        c.setStrokeColor(colors.HexColor('#94A3B8'))
        c.setLineWidth(0.45)
        c.rect(margin_x, y_cursor - header_h, table_w, header_h, fill=0, stroke=1)
        y_cursor -= header_h

    y_cursor = 0
    draw_header(False)

    subtotal_sum = 0.0
    tax_sum = 0.0
    total_sum = 0.0

    for idx, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{idx}')
        if y_cursor - row_h < margin_bottom:
            c.showPage()
            toc_page += 1
            draw_header(True)

        desc = trim_text(entry.get('description') or '(No description)', 90)
        if is_finance:
            date_value = entry.get('purchaseDate') or ''
        else:
            date_value = datetime.fromtimestamp((entry.get('ts') or 0) / 1000).strftime('%Y-%m-%d')

        page_no = int(entry_page_start.get(entry_id, 0)) + int(page_offset) + 1
        if is_finance:
            subtotal, tax_value, total_value = _finance_summary_values(entry)
            subtotal_sum += subtotal
            tax_sum += tax_value
            total_sum += total_value
            values = [
                str(idx),
                trim_text(date_value, 12),
                trim_text(entry.get('category') or 'Uncategorized', 10),
                desc,
                str(len(_entry_assets(entry))),
                _fmt_currency(subtotal),
                _fmt_currency(tax_value),
                _fmt_currency(total_value),
                str(page_no),
            ]
        else:
            values = [
                str(idx),
                trim_text(date_value, 12),
                trim_text(entry.get('category') or 'Uncategorized', 16),
                desc,
                str(len(_entry_assets(entry))),
                str(page_no),
            ]

        if idx % 2 == 0:
            c.setFillColor(colors.HexColor('#F8FAFC'))
            c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=1, stroke=0)

        c.setFillColor(colors.HexColor('#0F172A'))
        c.setFont('Helvetica', 7.8 if is_finance else 8.1)
        x = margin_x
        for col_idx, value in enumerate(values):
            if is_finance and col_idx == 3:
                desc_lines = clamp_desc_two_lines(value, width_chars=36)
                c.setFont('Helvetica', 7.1)
                c.drawString(x + 3, y_cursor - 9, desc_lines[0])
                if len(desc_lines) > 1:
                    c.drawString(x + 3, y_cursor - 17, desc_lines[1])
                c.setFont('Helvetica', 7.8)
            elif is_finance and col_idx in finance_amount_cols:
                c.drawRightString(x + col_ws[col_idx] - 3, y_cursor - 13, value)
            else:
                c.drawString(x + 3, y_cursor - 13, value)
            x += col_ws[col_idx]

        c.setStrokeColor(colors.HexColor('#CBD5E1'))
        c.setLineWidth(0.35)
        c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=0, stroke=1)

        link_specs.append({'toc_page': toc_page, 'entry_id': entry_id, 'rect': (margin_x, y_cursor - row_h, margin_x + table_w, y_cursor)})

        y_cursor -= row_h

    if is_finance:
        if y_cursor - row_h < margin_bottom:
            c.showPage()
            toc_page += 1
            draw_header(True)

        c.setFillColor(colors.HexColor('#E2E8F0'))
        c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=1, stroke=0)
        c.setFillColor(colors.HexColor('#0F172A'))
        c.setFont('Helvetica-Bold', 7.9)

        totals_values = [
            '',
            '',
            '',
            'Totals',
            '',
            _fmt_currency(subtotal_sum),
            _fmt_currency(tax_sum),
            _fmt_currency(total_sum),
            '',
        ]

        x = margin_x
        for col_idx, value in enumerate(totals_values):
            if col_idx in finance_amount_cols:
                c.drawRightString(x + col_ws[col_idx] - 3, y_cursor - 13, value)
            else:
                c.drawString(x + 3, y_cursor - 13, value)
            x += col_ws[col_idx]

        c.setStrokeColor(colors.HexColor('#94A3B8'))
        c.setLineWidth(0.45)
        c.rect(margin_x, y_cursor - row_h, table_w, row_h, fill=0, stroke=1)

    c.save()
    out.seek(0)
    return out.getvalue(), link_specs


def build_detailed_pdf(entries, variant, page_size_name, base_dir):
    pypdf_module = importlib.import_module('pypdf')
    PdfReader = getattr(pypdf_module, 'PdfReader')
    PdfWriter = getattr(pypdf_module, 'PdfWriter')

    page_size, normalized_size = _pdf_page_size(page_size_name)
    writer = PdfWriter()

    entry_page_start = {}
    asset_bookmarks = []

    for idx, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{idx}')
        assets = _entry_assets(entry)

        summary_bytes = _entry_detail_pdf_bytes(entry, idx, len(entries), variant, page_size, normalized_size)
        summary_reader = PdfReader(io.BytesIO(summary_bytes))

        summary_start = len(writer.pages)
        entry_page_start[entry_id] = summary_start
        for page in summary_reader.pages:
            writer.add_page(page)

        for asset_idx, asset in enumerate(assets, start=1):
            asset_title = f'Entry {idx} - {asset["label"]}'
            asset_url = asset['url']
            asset_path = _resolve_upload_abs_path(asset_url, base_dir)
            asset_start = len(writer.pages)

            appended = False
            if asset_path and os.path.exists(asset_path):
                ext = os.path.splitext(asset_path)[1].lower()
                mime, _ = mimetypes.guess_type(asset_path)

                if ext == '.pdf' or mime == 'application/pdf':
                    try:
                        before = len(writer.pages)
                        _append_scaled_pdf_pages(writer, asset_path, page_size, top_title=asset_title)
                        appended = len(writer.pages) > before
                    except Exception:
                        appended = False
                elif ext in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'} or (mime and mime.startswith('image/')):
                    try:
                        image_bytes = _image_pdf_bytes(asset_path, page_size, asset_title)
                        image_reader = PdfReader(io.BytesIO(image_bytes))
                        for page in image_reader.pages:
                            writer.add_page(page)
                        appended = len(image_reader.pages) > 0
                    except Exception:
                        appended = False

            if not appended:
                placeholder_lines = [
                    asset_title,
                    f'Original URL: {asset_url}',
                    'This file type cannot be directly converted in server export.',
                    'A placeholder page is inserted instead.',
                ]
                placeholder_bytes = _text_pdf_bytes(placeholder_lines, page_size, title='Attachment Placeholder')
                placeholder_reader = PdfReader(io.BytesIO(placeholder_bytes))
                for page in placeholder_reader.pages:
                    writer.add_page(page)

            asset_bookmarks.append({'entry_id': entry_id, 'title': f'{asset_idx}. {asset["label"]}', 'page': asset_start})

    entry_parent = {}
    for i, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{i}')
        page_index = entry_page_start.get(entry_id, 0)
        desc = (entry.get('description') or '(No description)').strip()
        if len(desc) > 60:
            desc = desc[:60] + '…'
        entry_parent[entry_id] = writer.add_outline_item(f'Entry {i}: {desc}', page_number=page_index)

    for b in asset_bookmarks:
        parent = entry_parent.get(b['entry_id'])
        writer.add_outline_item(b['title'], page_number=b['page'], parent=parent)

    toc_guess = 1
    toc_bytes = b''
    toc_links = []
    toc_pages_count = 0
    for _ in range(5):
        toc_bytes, toc_links = _toc_pdf_bytes(entries, entry_page_start, toc_guess, variant, page_size, normalized_size)
        toc_reader = PdfReader(io.BytesIO(toc_bytes))
        toc_pages_count = len(toc_reader.pages)
        if toc_pages_count == toc_guess:
            break
        toc_guess = toc_pages_count

    final_writer = PdfWriter()
    if toc_bytes:
        toc_reader = PdfReader(io.BytesIO(toc_bytes))
        for page in toc_reader.pages:
            final_writer.add_page(page)
    for page in writer.pages:
        final_writer.add_page(page)

    final_entry_parent = {}
    for i, entry in enumerate(entries, start=1):
        entry_id = str(entry.get('id') or f'entry-{i}')
        page_index = entry_page_start.get(entry_id, 0) + toc_pages_count
        desc = (entry.get('description') or '(No description)').strip()
        if len(desc) > 60:
            desc = desc[:60] + '…'
        final_entry_parent[entry_id] = final_writer.add_outline_item(f'Entry {i}: {desc}', page_number=page_index)

    for b in asset_bookmarks:
        parent = final_entry_parent.get(b['entry_id'])
        final_writer.add_outline_item(b['title'], page_number=b['page'] + toc_pages_count, parent=parent)

    try:
        annotations_module = importlib.import_module('pypdf.annotations')
        Link = getattr(annotations_module, 'Link')
        for link_spec in toc_links:
            entry_id = link_spec['entry_id']
            if entry_id not in entry_page_start:
                continue
            target_page = entry_page_start[entry_id] + toc_pages_count
            link_obj = Link(rect=link_spec['rect'], target_page_index=target_page)
            final_writer.add_annotation(link_spec['toc_page'], link_obj)
    except Exception:
        pass

    out = io.BytesIO()
    final_writer.write(out)
    out.seek(0)
    return out.getvalue()
