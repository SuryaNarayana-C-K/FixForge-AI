#!/bin/sh
set -e

export DOCKER_HOST=unix:///run/user/1000/docker.sock
export ROOTLESS_DOCKER_SOCKET=/run/user/1000/docker.sock

# Start dedicated rootless Docker daemon in background using official entrypoint
echo "[worker-init] Starting isolated rootless Docker daemon..."
/usr/local/bin/dockerd-entrypoint.sh dockerd > /tmp/dockerd.log 2>&1 &
DOCKERD_PID=$!

# Wait for rootless daemon to become ready
echo "[worker-init] Waiting for rootless Docker socket at /run/user/1000/docker.sock..."
TRIES=0
while [ ! -S /run/user/1000/docker.sock ]; do
    TRIES=$((TRIES + 1))
    if [ $TRIES -gt 40 ]; then
        echo "[worker-init] ERROR: Rootless daemon failed to start within 40 seconds."
        cat /tmp/dockerd.log 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# Wait for docker CLI to confirm daemon responsiveness
while ! docker version > /dev/null 2>&1; do
    sleep 0.5
done

echo "[worker-init] Rootless Docker daemon is operational (Version: $(docker version --format '{{.Server.Version}}'))!"

# Pre-load sandbox image if available
if [ -f /app/fixforge-sandbox.tar ]; then
    echo "[worker-init] Pre-loading fixforge-sandbox:latest into rootless daemon..."
    docker load -i /app/fixforge-sandbox.tar
fi

# Clean up any leftover temporary containers on startup
echo "[worker-init] Performing startup orphan reconciliation..."
docker rm -f $(docker ps -aq --filter name=fixforge-worker-) 2>/dev/null || true

# Start FastAPI worker application
echo "[worker-init] Starting FixForge Sandbox Worker API on port ${PORT:-9000}..."
exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-9000}"
