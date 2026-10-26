# FixForge Isolated Sandbox Image for Python Projects
# Provides a minimal, secure, non-root execution environment.

FROM python:3.11-slim

# Prevent interactive prompts during build
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Install minimal test runner tooling (pytest)
RUN pip install --no-cache-dir pytest==8.3.4

# Create unprivileged sandbox user (UID 1000)
RUN groupadd -g 1000 sandboxgroup && \
    useradd -u 1000 -g sandboxgroup -m -s /bin/bash sandboxuser

# Create workspace directory with correct permissions
RUN mkdir -p /workspace && \
    chown -R sandboxuser:sandboxgroup /workspace

# Working directory
WORKDIR /workspace

# Switch to non-root user
USER sandboxuser

# Default command
CMD ["pytest"]
