from datetime import datetime

from services.pdf_export_service import build_detailed_pdf, pdf_dependencies_available


class ExportService:
    def handle_detailed_pdf_export(self, payload, variant, base_dir, get_memos_for_variant):
        page_size = payload.get('pageSize') or 'A4'
        entry_ids = payload.get('entryIds') or []

        if not isinstance(entry_ids, list):
            return {'message': 'entryIds must be an array.'}, 400

        all_memos = get_memos_for_variant(variant)
        active_entries = [memo for memo in all_memos if not memo.get('deletedAt')]
        by_id = {str(memo.get('id')): memo for memo in active_entries}

        selected = []
        if entry_ids:
            for raw_id in entry_ids:
                key = str(raw_id)
                if key in by_id:
                    selected.append(by_id[key])
        else:
            selected = active_entries

        if not selected:
            return {'message': 'No entries selected for export.'}, 400

        if not pdf_dependencies_available():
            return {
                'message': 'Detailed PDF export dependencies are missing. Install: pip install reportlab pypdf pillow'
            }, 500

        try:
            pdf_bytes = build_detailed_pdf(selected, variant, page_size, base_dir)
        except Exception as exc:
            return {'message': f'Failed to build detailed PDF: {exc}'}, 500

        filename = f"{variant}_detailed_export_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.pdf"
        return {
            'pdfBytes': pdf_bytes,
            'filename': filename,
            'mimetype': 'application/pdf',
        }, 200
