FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY leados_tg ./leados_tg
COPY login.py .
USER nobody
CMD ["python", "-m", "leados_tg"]
