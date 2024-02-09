from flask import jsonify, request

from ..utils import get_tokens, process_intelligent_act, logger
from ..ai import text_to_invoice



def upload_text():
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
