from .chat_routes import create_chat_blueprint
from .memo_routes import create_memo_blueprint
from .ocr_routes import create_ocr_blueprint
from .operations_routes import create_operations_blueprint
from .upload_routes import create_upload_blueprint
from .export_routes import create_export_blueprint
from .backup_routes import create_backup_blueprint
from .frontend_routes import create_frontend_blueprint
from .config_routes import create_config_blueprint

__all__ = [
    'create_chat_blueprint',
    'create_memo_blueprint',
    'create_ocr_blueprint',
    'create_operations_blueprint',
    'create_upload_blueprint',
    'create_export_blueprint',
    'create_backup_blueprint',
    'create_frontend_blueprint',
    'create_config_blueprint',
]
