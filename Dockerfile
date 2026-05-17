FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080

CMD python -m gunicorn --bind 0.0.0.0:$PORT --workers 2 --worker-class gthread --threads 4 --timeout 180 api:app
