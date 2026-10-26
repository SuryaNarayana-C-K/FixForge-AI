#!/usr/bin/env bash
# =============================================================================
# FixForge Milestone 14: Linux Pilot Secret Generation & Injection Utility
# =============================================================================
# Generates 256-bit cryptographically random hex keys using openssl.
# Writes directly to .env.pilot with chmod 600.
# CRITICAL: Secret values are NEVER printed to stdout or written to logs.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_FILE="${ROOT_DIR}/.env.pilot"
TEMPLATE_FILE="${ROOT_DIR}/.env.pilot.example"

FORCE=false
if [[ "${1:-}" == "--force" || "${1:-}" == "-f" ]]; then
    FORCE=true
fi

if [[ -f "${TARGET_FILE}" && "${FORCE}" != "true" ]]; then
    echo "ERROR: ${TARGET_FILE} already exists. Pass --force to regenerate (existing sessions will be invalidated)." >&2
    exit 1
fi

if [[ ! -f "${TEMPLATE_FILE}" ]]; then
    echo "ERROR: Template ${TEMPLATE_FILE} not found." >&2
    exit 1
fi

# Ensure openssl is available
if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: openssl is required to generate cryptographic secrets." >&2
    exit 1
fi

# Generate secrets in-memory
JWT_SEC="$(openssl rand -hex 32)"
SESS_SEC="$(openssl rand -hex 32)"
SRV_SEC="$(openssl rand -hex 32)"
WRK_SEC="$(openssl rand -hex 32)"

# Create file with strict permissions prior to writing content
touch "${TARGET_FILE}"
chmod 600 "${TARGET_FILE}"

# Substitute placeholders line by line without leaking secrets in ps/logs
awk -v j="${JWT_SEC}" -v s="${SESS_SEC}" -v k="${SRV_SEC}" -v w="${WRK_SEC}" '
{
    if ($0 ~ /^JWT_SECRET=/) { print "JWT_SECRET=" j }
    else if ($0 ~ /^SESSION_SECRET=/) { print "SESSION_SECRET=" s }
    else if ($0 ~ /^INTERNAL_SERVICE_KEY=/) { print "INTERNAL_SERVICE_KEY=" k }
    else if ($0 ~ /^INTERNAL_WORKER_KEY=/) { print "INTERNAL_WORKER_KEY=" w }
    else { print $0 }
}' "${TEMPLATE_FILE}" > "${TARGET_FILE}"

# Unset in-memory variables
unset JWT_SEC SESS_SEC SRV_SEC WRK_SEC

echo "================================================================="
echo "FixForge Pilot Security: Secrets Generated Successfully (Linux)"
echo "================================================================="
echo "Target File:      ${TARGET_FILE}"
echo "Permissions:      chmod 600 (owner read/write only)"
echo "Injected Keys:    JWT_SECRET, SESSION_SECRET, INTERNAL_SERVICE_KEY, INTERNAL_WORKER_KEY"
echo "Security Notice:  Secrets were written directly to disk and NEVER echoed to console."
echo "Next Step:        Add your GEMINI_API_KEY to .env.pilot before starting Docker."
echo "================================================================="
