import os
import re
import json
import requests
from typing import Any

from flask import request, flash
from werkzeug.utils import secure_filename

from .data import UPLOADS_FOLDER, ENVIRONMENT



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


def clean_file(filepath: str) -> None:
    if not ENVIRONMENT['IN_PRODUCTION']:
        return

    try:
        os.remove(filepath)
    except Exception as error:
        logger('ERROR', error)


def extract_json_from_data(data: str) -> Any | None:
    try:
        data = re.sub(r'^```json', '', data)
        data = re.sub(r'```$', '', data)
        parsed = json.loads(data)
        return parsed['invoice']
    except Exception as error:
        logger('ERROR', error)

        return None


def get_tokens():
    access_token = request.cookies.get('XFCT_AT')
    refresh_token = request.cookies.get('XFCT_RT')

    if not access_token or not refresh_token:
        return None

    return {
        'access_token': access_token,
        'refresh_token': refresh_token,
    }


def process_intelligent_act(
    tokens: dict[str, str],
):
    response = requests.post(
        f'{ENVIRONMENT["API_DOMAIN"]}/process-intelligent-act',
        headers={
            'Authorization': f'Bearer {tokens["access_token"]}',
            'Authorization-Refresh': f'Bearer Refresh {tokens["refresh_token"]}',
            'Content-Type': 'application/json',
        },
    ).json()

    return response['status']
