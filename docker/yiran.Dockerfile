# Compose build context is mind-map/docker/.
# Yiran sources are supplied via additional_contexts.yiran_src (YIRAN_ROOT).
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=yiran_src backend/requirements.txt /app/backend/requirements.txt
RUN pip install -r /app/backend/requirements.txt

COPY --from=yiran_src backend /app/backend
COPY yiran-entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

WORKDIR /app/backend

EXPOSE 8000
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
