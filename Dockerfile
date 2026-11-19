# Stage 1: typecheck + bundle the TypeScript front end.
FROM node:20-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/tsconfig.json ./
COPY frontend/src ./src
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
COPY templates ./templates
COPY static ./static
COPY --from=frontend /build/dist/ ./static/

ENV PORT=9030 DATA_DIR=/app/data
EXPOSE 9030
# One worker: the snapshot (and its once-per-REFRESH_S feed call) lives in-process.
# --preload: a missing LAT/LON stops the container with a clear message instead of
# gunicorn restarting the worker forever.
CMD ["sh", "-c", "gunicorn --preload -b 0.0.0.0:${PORT} -w 1 --threads 8 --timeout 30 app:app"]
