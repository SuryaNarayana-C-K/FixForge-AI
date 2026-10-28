# FixForge Isolated Sandbox Worker (M13.6-D)
# Based on docker:dind-rootless to own a genuinely isolated rootless Docker daemon.
# Crucially: This container DOES NOT mount the host's /var/run/docker.sock.

FROM docker:dind-rootless

USER root

# Install Python 3, pip, curl, tar, gzip, procps
RUN apk add --no-cache \
    python3 \
    py3-pip \
    curl \
    tar \
    gzip \
    procps

WORKDIR /app

# Install FastAPI, Uvicorn, and Pydantic
RUN pip install --no-cache-dir --break-system-packages \
    fastapi>=0.115.0 \
    uvicorn>=0.30.0 \
    pydantic>=2.8.0

# Copy pre-packaged sandbox image for offline daemon provisioning (optional)
COPY fixforge-sandbox.tar* /app/

# Copy application source code and entrypoint
COPY app /app/app
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh && \
    mkdir -p /app/workspaces && \
    chown -R rootless:rootless /app

USER rootless

ENV DOCKER_HOST=unix:///run/user/1000/docker.sock \
    ROOTLESS_DOCKER_SOCKET=/run/user/1000/docker.sock \
    PORT=9000 \
    PYTHONUNBUFFERED=1 \
    WORKER_WORKSPACES_DIR=/app/workspaces

EXPOSE 9000

ENTRYPOINT ["/app/entrypoint.sh"]
