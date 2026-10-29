# Memora sync server.
#   docker compose up -d                  (see compose.yaml)
#   docker build -t memora-server . && docker run -p 5050:5050 -v memora-data:/data memora-server
# Data (database and uploads) lives in /data. Set MEMO_SYNC_PASSWORD.
FROM python:3.12-slim

# Optional extras: photo reading, PDF text, and the AI providers the server's
# own AI can use (bring your own key). Build with --build-arg EXTRAS="" to skip.
ARG EXTRAS="pillow pypdf openai anthropic"

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt ${EXTRAS}
COPY package.json LICENSE NOTICE.md ./
COPY backend ./backend
COPY src ./src

RUN useradd --create-home --uid 1000 memora && mkdir /data && chown memora /data
USER memora
VOLUME /data
EXPOSE 5050
CMD ["python", "backend/memora_server.py", "--host", "0.0.0.0", "--port", "5050", "--base-dir", "/data"]
