#!/bin/sh
export FLASK_APP=./xfactura_ro/server.py

pipenv run flask --debug run -h 0.0.0.0 --port 8088
