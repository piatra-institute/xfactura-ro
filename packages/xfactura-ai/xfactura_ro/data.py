import os



UPLOADS_FOLDER = './uploads'

ALLOWED_AUDIO = ['mp3', 'wav', 'ogg', 'm4a']
ALLOWED_FILE = ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'json', 'xml']

SIZE_30_MB = 30 * 1000 * 1000

ENVIRONMENT = {
    'FLASK_SECRET': os.getenv('FLASK_SECRET'),
    'OPENAI_SECRET': os.getenv('OPENAI_SECRET'),
}
