import os
from dotenv import load_dotenv

from .data import UPLOADS_FOLDER



def setup():
    load_dotenv()

    if not os.path.exists(UPLOADS_FOLDER):
        os.mkdir(UPLOADS_FOLDER)
