FROM python:3.12-alpine

RUN apk update
RUN pip install --no-cache-dir pipenv

WORKDIR /usr/src/app
COPY Pipfile Pipfile.lock start.py ./
COPY xfactura_ro ./xfactura_ro

RUN pipenv install --system --deploy

EXPOSE 8080

ENTRYPOINT ["python", "start.py"]


### Build Command
# > docker build -t xfactura-ro-ai .

### Run Command
# > docker run -d -p 8585:8080 xfactura-ro-ai
# > docker run --env-file ./.env -d -p 8585:8080 xfactura-ro-ai
