FROM python:3.14-slim

WORKDIR /dependencies
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never
RUN pip install --no-cache-dir uv==0.11.21 \
    && uv sync --locked --no-install-project \
    && rm -rf /root/.cache/uv

ENV UV_OFFLINE=1 \
    UV_NO_SYNC=1 \
    UV_CACHE_DIR=/tmp/uv-cache \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTEST_ADDOPTS="-p no:cacheprovider" \
    HOME=/tmp
WORKDIR /workspace
USER 65534:65534
