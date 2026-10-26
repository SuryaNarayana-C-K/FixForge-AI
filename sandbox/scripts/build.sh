#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${1:-fixforge-sandbox:latest}"
echo "Building FixForge sandbox image: ${IMAGE_TAG}..."
docker build -t "${IMAGE_TAG}" "$(dirname "$0")/.."
echo "Build complete: ${IMAGE_TAG}"
