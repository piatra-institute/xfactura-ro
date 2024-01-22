from openai import OpenAI

from ..data import ENVIRONMENT



client = OpenAI(api_key=ENVIRONMENT['OPENAI_SECRET'])
