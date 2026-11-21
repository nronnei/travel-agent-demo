# syntax=docker/dockerfile:1
# Build from this directory: docker build -f apps/parlant/Dockerfile apps/parlant
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PARLANT_HOME=/var/lib/parlant
WORKDIR /app

# Dependencies from the lockfile only, so this layer is cached until they change.
FROM base AS deps
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

# Dev image for Tilt: source is live-synced in and the process restarted.
FROM deps AS dev
COPY main.py ./
COPY travel_agent ./travel_agent
RUN mkdir -p $PARLANT_HOME
EXPOSE 8800
CMD ["/app/.venv/bin/python", "main.py"]

# Parlant runs with its development authorization policy (no auth): it is only
# reachable in-cluster, through the Nest API, which checks conversation ownership.
FROM base AS runtime
COPY --from=deps /app/.venv /app/.venv
COPY main.py ./
COPY travel_agent ./travel_agent
RUN useradd --uid 1000 --no-create-home parlant && mkdir -p $PARLANT_HOME && chown parlant $PARLANT_HOME
USER parlant
EXPOSE 8800
CMD ["/app/.venv/bin/python", "main.py"]
