from flask import jsonify

from ..data import ALLOWED_FILE
from ..utils import get_tokens, process_intelligent_act, get_file, clean_file, logger
from ..ai import image_to_invoice



def upload_file():
    try:
        tokens = get_tokens()
        if not tokens:
            return jsonify({
                'status': False,
            })

        processed = process_intelligent_act(tokens)
        if not processed:
            return jsonify({
                'status': False,
            })

        filepath = get_file(ALLOWED_FILE)
        if filepath is None:
            return jsonify({
                'status': False,
            })

        invoice_data = image_to_invoice(filepath)
        clean_file(filepath)
        if invoice_data is None:
            return jsonify({
                'status': False,
            })

        return jsonify({
            'status': True,
            'data': invoice_data,
        })
    except Exception as error:
        logger('ERROR', error)

        return jsonify({
            'status': False,
        })
