from flask import Flask
from flask_cors import CORS

from .handlers import home, upload_file, upload_audio, upload_text
from .setup import setup
from .data import ENVIRONMENT, SIZE_30_MB



setup()

app = Flask(
    __name__,
    template_folder='./html/',
)
CORS(
    app,
    resources={r"/*": {"origins": "*"}},
    supports_credentials=True,
)

app.secret_key = ENVIRONMENT['FLASK_SECRET']
app.config['MAX_CONTENT_LENGTH'] = SIZE_30_MB

app.add_url_rule('/', view_func=home, methods=['GET'])
app.add_url_rule('/upload_file', view_func=upload_file, methods=['POST'])
app.add_url_rule('/upload_audio', view_func=upload_audio, methods=['POST'])
app.add_url_rule('/upload_text', view_func=upload_text, methods=['POST'])
