from flask import jsonify

from ..data import ALLOWED_AUDIO
from ..utils import get_tokens, process_intelligent_act, get_file, logger
from ..ai import transcribe_audio, text_to_invoice



def upload_audio():
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

        filepath = get_file(ALLOWED_AUDIO)
        if filepath is None:
            return jsonify({
                'status': False,
            })

        audio_file= open(filepath, 'rb')
        transcript = transcribe_audio(audio_file)
        invoice_data = text_to_invoice(transcript)
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
