from flask import jsonify, request

from ..utils import logger
from ..ai import text_to_invoice



def upload_text():
    try:
        text_data = text_to_invoice(request.json['text'])
        if text_data is None:
            return jsonify({
                'status': False,
            })

        return jsonify({
            'status': True,
            'data': text_data,
        })
    except Exception as error:
        logger('ERROR', error)

        return jsonify({
            'status': False,
        })
