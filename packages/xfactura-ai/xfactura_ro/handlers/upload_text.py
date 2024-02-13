from flask import jsonify, request

from ..utils import get_tokens, process_intelligent_act, store_prompt, logger
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

        text=request.json['text']
        data = text_to_invoice(text)
        if data is None:
            return jsonify({
                'status': False,
            })

        store_prompt(tokens, text, data)

        return jsonify({
            'status': True,
            'data': data,
        })
    except Exception as error:
        logger('ERROR', error)

        return jsonify({
            'status': False,
        })
