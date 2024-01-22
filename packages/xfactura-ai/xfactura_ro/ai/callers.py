import base64
from io import BufferedReader

from ..utils import extract_json_from_data

from .client import client
from .prompts import text_to_invoice_prompt, image_to_invoice_prompt



def transcribe_audio(audio_file: BufferedReader):
    transcript = client.audio.transcriptions.create(
        model='whisper-1',
        file=audio_file,
    )
    return transcript.text


def text_to_invoice(data: str):
    response = client.chat.completions.create(
        model="gpt-4-1106-preview",
        messages=[
            {"role": "system", "content": text_to_invoice_prompt},
            {"role": "user", "content": data},
        ]
    )
    data = response.choices[0].message.content

    return extract_json_from_data(data)


def encode_image(image_path: str):
  with open(image_path, "rb") as image_file:
    return base64.b64encode(image_file.read()).decode('utf-8')


def image_to_invoice(image_path: str):
    base64_image = encode_image(image_path)

    response = client.chat.completions.create(
        model="gpt-4-vision-preview",
        messages=[
            {
                "role": "user",
                "content": [
                    {
                       "type": "text",
                       "text": image_to_invoice_prompt,
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{base64_image}",
                        },
                    },
                ],
            },
        ],
        max_tokens=1000,
    )
    data = response.choices[0].message.content

    return extract_json_from_data(data)
