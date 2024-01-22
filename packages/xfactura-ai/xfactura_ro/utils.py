import os
import re
import json
from typing import Any

from flask import request, flash
from werkzeug.utils import secure_filename

from .data import UPLOADS_FOLDER



def logger(kind: str, message: Any) -> None:
    try:
        print(f'[{kind}] {str(message)}')
    except Exception as _:
        return


def allowed_file(filename: str, extensions: list[str]) -> bool:
    return '.' in filename and \
        filename.rsplit('.', 1)[1].lower() in extensions


def get_file(allowlist: list[str]) -> str | None:
    if 'file' not in request.files:
        flash('No file part')
        return None

    file = request.files['file']
    if file.filename == '':
        flash('No selected file')
        return None

    if file and allowed_file(file.filename, allowlist):
        filename = secure_filename(file.filename)
        filepath = os.path.join(UPLOADS_FOLDER, filename)
        file.save(filepath)

        return filepath


def extract_json_from_data(data: str) -> Any | None:
    try:
        data = re.sub(r'^```json', '', data)
        data = re.sub(r'```$', '', data)
        parsed = json.loads(data)
        return parsed['invoice']
    except Exception as error:
        logger('ERROR', error)

        return None
