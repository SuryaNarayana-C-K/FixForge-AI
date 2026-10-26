# =============================================================================
# FixForge AI Agent Engine Dockerfile
# Python 3.11 + FastAPI + Docker CLI for isolated sandbox execution
# =============================================================================
#
# DOCKER SOCKET REQUIREMENT & SECURITY IMPLICATIONS:
#
# 1. Architecture:
#    FixForge's autonomous repair engine validates and tests software repairs inside
#    ephemeral, isolated Docker containers (via DockerSandboxRunner in app/sandbox).
#    To launch and monitor these sandbox containers, the AI agent service requires
#    access to the host Docker daemon by mounting the host Docker socket:
#      -v /var/run/docker.sock:/var/run/docker.sock
#
# 2. Security Implications:
#    Mounting /var/run/docker.sock grants effective root-equivalent access over the
#    host machine, as any process able to issue Docker commands can start containers
#    with arbitrary volume mounts and privileges.
#
# 3. Defense-in-Depth Mitigations:
#    - The container executes under an unprivileged user (`fixforge`, UID/GID 1000).
#    - Host Docker socket access should be scoped; when possible, use Rootless Docker
#      or a Docker socket proxy filtering out dangerous endpoints.
#    - FixForge strictly enforces fail-closed sandbox policies: commands are sanitized,
#      workspace roots are validated against directory traversal, execution timeouts
#      are strictly enforced, and containers are guaranteed to be cleaned up.
#    - The service is internal-only and must never be exposed on public interfaces.
# =============================================================================

FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    PYTHONPATH=/app \
    EXECUTION_MODE=docker \
    ALLOW_LOCAL_SUBPROCESS=false

# Install Docker CLI binary directly from the official Docker CLI image
# (Required by DockerSandboxRunner to execute isolated test runs)
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# Install declared Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Create unprivileged application user and set ownership
RUN groupadd -g 1000 fixforge && \
    useradd -u 1000 -g fixforge -m -s /bin/bash fixforge && \
    mkdir -p /app && \
    chown -R fixforge:fixforge /app

# Copy application source code only (excluding tests, secrets, or .env files)
COPY --chown=fixforge:fixforge app/ ./app/

# Switch to unprivileged non-root user
USER fixforge

EXPOSE 8000

# Verified healthcheck against FastAPI /healthz endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
