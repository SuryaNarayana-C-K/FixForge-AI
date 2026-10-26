# FixForge Milestone 14 — Private Pilot Deployment & Operations Guide

This guide defines the hardened deployment architecture, provisioning prerequisites, security boundaries, and operational procedures for conducting a private pilot with trusted users.

---

## 1. Executive Summary & Deployment Architecture

FixForge M14 provides an isolated, multi-tenant software repair platform deployed on a dedicated, private Linux host.

```text
Trusted Pilot Users (Browser / IDE Extension)
                     │
                     │ HTTPS (Port 443, TLS 1.3) over Tailscale / WireGuard / Private Subnet
                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Dedicated Linux Host / VM Boundary (Ubuntu 24.04 LTS, cgroups v2)      │
│                                                                        │
│  [ fixforge-proxy: Caddy 2.9 (Reverse Proxy) ]                         │
│  ├── Terminates TLS & enforces HSTS                                    │
│  ├── Exposes ONLY Port 443 & Port 80 (HTTP-to-HTTPS redirect)          │
│  ├── Bound strictly to private IP (BIND_ADDRESS)                       │
│  ├── Routes '/' and assets ───────► fixforge-web (Internal port 80)    │
│  └── Routes '/api/*' ─────────────► fixforge-api (Internal port 5000)  │
│                                                                        │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Private Internal Network: pilot-network (Zero Public Exposure)    │ │
│  │                                                                   │ │
│  │  [ fixforge-api: Node 24 Express + Prisma (Single Replica) ]      │ │
│  │  ├── Exclusively owns SQLite DB volume at /data/fixforge.db       │ │
│  │  ├── Strict JWT session authentication (demo mode disabled)        │ │
│  │  ├── Tenant isolation & Cross-Tenant IDOR rejection               │ │
│  │  ├── Concurrency governor (global: 4, per-user: 2)                │ │
│  │  ├── Sliding window rate limiter & hourly repair quotas           │ │
│  │  ├── State machine with terminal state locking                    │ │
│  │  ├── Manual patch approval policy gate (ADMIN/MANAGER required)   │ │
│  │  └── Audit logging with secret token redaction                    │ │
│  │          │                                                        │ │
│  │          │ Internal HTTP + X-Service-Key Auth                     │ │
│  │          ▼                                                        │ │
│  │  [ fixforge-ai: Python 3.11 FastAPI (Agent Orchestrator) ]        │ │
│  │  ├── Zero host Docker socket access                               │ │
│  │  ├── LangGraph bounded self-correction loop                       │ │
│  │  ├── PatchValidator (protects test files & CI/secret files)       │ │
│  │  └── Tarball workspace packager                                   │ │
│  │          │                                                        │ │
│  │          │ Internal HTTP + X-Worker-Key Auth                      │ │
│  │          ▼                                                        │ │
│  │  [ fixforge-sandbox-worker: Rootless Docker Daemon in Container ] │ │
│  │  ├── Runs docker:dind-rootless as UID 1000                        │ │
│  │  ├── Tarball unpacker with path traversal & tarbomb guards        │ │
│  │  └── Bounded Ephemeral Container:                                 │ │
│  │      ├── Non-root (sandboxuser UID 1000)                          │ │
│  │      ├── --network none (network egress completely disabled)      │ │
│  │      ├── Resource limits (1 CPU, 512MB RAM, 128 PIDs, 120s limit)│ │
│  │      ├── Security: --cap-drop ALL, no-new-privileges:true         │ │
│  │      └── Read-only rootfs + tmpfs /tmp (64MB, noexec, nosuid)     │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Infrastructure Prerequisites (Ubuntu 24.04 LTS)

### A. Host Hardware Minimum Specifications
| Component | Minimum Specification | Recommended Pilot Sizing |
|---|---|---|
| **OS** | Ubuntu 24.04 LTS x86_64 | Ubuntu 24.04 LTS x86_64 (Kernel >= 6.8) |
| **vCPU** | 4 cores | 8 cores |
| **RAM** | 8 GB | 16 GB |
| **Storage** | 50 GB NVMe / SSD | 100 GB NVMe / SSD |
| **Networking** | Private VPC IP / VPN Interface | Dedicated Private Interface (No public IP) |

### B. Linux Kernel & System Verification
Run these commands on the target host to verify cgroups v2 and user namespace support:

```bash
# 1. Verify Linux Kernel version (must be >= 6.1)
uname -r

# 2. Verify cgroups v2 unified hierarchy
stat -fc %T /sys/fs/cgroup/
# Expected output: cgroup2fs

# 3. Verify user namespaces are enabled
sysctl kernel.unprivileged_userns_clone
# Expected output: kernel.unprivileged_userns_clone = 1

# 4. Verify user namespace allocation limit
sysctl user.max_user_namespaces
# Expected output: >= 28633

# 5. Ensure TUN device module is loaded for rootless networking
sudo modprobe tun
ls -l /dev/net/tun
```

---

## 3. Secret Generation & Storage Architecture

### A. Required Security Secrets
Four high-entropy secrets (256-bit / 64 hex characters) are required:
1. `JWT_SECRET`: Signs user session authentication tokens.
2. `SESSION_SECRET`: Signs server-side session cookies.
3. `INTERNAL_SERVICE_KEY`: Authenticates calls from Node API to Python AI Agent.
4. `INTERNAL_WORKER_KEY`: Authenticates calls from Python AI Agent to Sandbox Worker.

### B. Secret Generation Policy
- **Never hardcode secrets** in Dockerfiles, Compose files, or repository manifests.
- **Never echo or print secrets** to stdout, stderr, build logs, or CI terminals.
- **Restrict file permissions**: The generated `.env.pilot` file must have `chmod 600` (read/write only by file owner).
- `.env.pilot` is automatically ignored by `.gitignore`.

### C. Execution
Run the automated generation script on the host:
```bash
# Linux host:
bash scripts/generate-pilot-secrets.sh

# Or using Node:
node scripts/generate-pilot-secrets.js
```

Then append your LLM API key to `.env.pilot`:
```bash
echo "GEMINI_API_KEY=your_actual_key_here" >> .env.pilot
```

---

## 4. Single-Instance SQLite Durability & Backup Runbook

### A. Single-Instance Rule
FixForge uses SQLite for the pilot deployment (`pilot-sqlite-data` volume mounted at `/data/fixforge.db`).
- **SQLite Concurrency Model**: Multiple concurrent readers, single concurrent writer.
- **Deployment Constraint**: Only **one** instance of `fixforge-api` may run against the database volume. **Never scale the API container horizontally (replicas > 1)** until migrating to PostgreSQL.
- **In-Memory Concurrency Governor**: The API enforces `MAX_CONCURRENT_REPAIR_JOBS=4` and `MAX_CONCURRENT_PER_USER=2`, queuing or rejecting excess jobs to prevent database write starvation.

### B. Online Hot Backup
To create a non-blocking, transactionally consistent snapshot while the system is live:
```bash
docker exec fixforge-pilot-api node scripts/db-backup-restore.js backup
```
- Executes SQLite `VACUUM INTO`.
- Computes SHA-256 digest and validates `SQLite format 3\0` magic header.
- Saves snapshot to `/data/backups/fixforge-backup-<timestamp>.db`.

### C. Offline Restore & Integrity Verification
To restore from a backup snapshot:
```bash
# 1. Stop the application services
docker compose -f docker-compose.pilot.yml stop fixforge-api fixforge-ai

# 2. Restore database from verified backup snapshot
docker run --rm -v fixforge-main_pilot-sqlite-data:/data alpine \
  cp /data/backups/<backup-filename>.db /data/fixforge.db

# 3. Start API and verify PRAGMA integrity
docker compose -f docker-compose.pilot.yml start fixforge-api
docker exec fixforge-pilot-api node scripts/db-backup-restore.js verify
```

---

## 5. Rootless-Docker Shared Kernel Risk Documentation

### A. Isolation Guarantees Provided by M14
- **No Docker Socket Mounting**: The host `/var/run/docker.sock` is absent from all application containers.
- **Unprivileged User Daemon**: The sandbox worker runs `dockerd` inside an unprivileged user namespace as UID 1000.
- **Container Hardening**: Ephemeral containers run with `--user 1000:1000`, `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, `--read-only`, and tmpfs `/tmp`.

### B. Residual Kernel-Sharing Risk
- **Shared Linux Kernel**: Containers share the Linux host kernel. A critical zero-day kernel exploit in the host kernel could theoretically break container isolation.
- **Mitigation & Operational Rule**:
  - FixForge must **NEVER be exposed publicly** to arbitrary untrusted users.
  - Access is restricted exclusively to **trusted pilot users** via private VPN/mesh networking.
  - Test suites executed by FixForge must belong to approved internal pilot repositories.
  - Enterprise multi-tenant roadmap: Future milestones will evaluate microVM isolation (AWS Firecracker or gVisor) for running arbitrary external repositories.

---

## 6. Pilot Acceptance Verification

Run the automated live acceptance suite against the deployment:

```bash
# If testing locally or over SSH tunnel:
node scripts/pilot-acceptance-runner.mjs http://127.0.0.1:5000/api

# If testing over HTTPS reverse proxy:
node scripts/pilot-acceptance-runner.mjs https://pilot.local/api
```

The acceptance suite automatically validates:
1. Liveness (`GET /healthz`) and Deep Readiness (`GET /readyz`) probes.
2. Unauthenticated request rejection (401).
3. Cross-tenant IDOR access rejection (403).
4. Idempotent submission and conflicting payload rejection (409).
5. Developer approval rejection and unverified repair approval rejection.
6. Job cancellation and terminal state locking.
7. Database backup, SQLite header magic bytes, and PRAGMA integrity checks.

---

## 7. Pilot Onboarding Checklist

Follow this checklist when onboarding each pilot user:

- [ ] **1. Provision User Account**:
  - Admin logs in to the dashboard.
  - Navigates to Organization Admin → Members → Invite Member.
  - Assigns role: `DEVELOPER` (for engineers submitting repairs) or `MANAGER` (for leads approving repairs).
  - An initial temporary password is set; user must change password upon first login.
- [ ] **2. Establish Private Network Connectivity**:
  - Add user's device to Tailscale mesh / WireGuard VPN.
  - Verify user can resolve and reach `https://<pilot-domain-or-ip>`.
  - Verify user cannot reach internal ports 5000, 8000, or 9000 directly.
- [ ] **3. Connect Pilot Repository**:
  - Create a test project pointing to an approved pilot repository.
  - Ensure baseline tests run and execute inside the rootless sandbox.
- [ ] **4. Verify Human Approval Workflow**:
  - Run a repair job.
  - Confirm that developer cannot approve the patch.
  - Have designated Manager/Admin review the unified diff, inspect test verification evidence, and click `[ Approve Repair ]`.
- [ ] **5. Confirm Audit Trail**:
  - In Admin Dashboard, inspect Audit Logs.
  - Verify login, repair submission, and approval actions are recorded with sanitized metadata.

---

## 8. Rollback & Disaster Recovery Procedures

| Scenario | Symptoms | Action Steps |
|---|---|---|
| **Stuck Worker / Unresponsive Daemon** | Healthcheck on `fixforge-pilot-worker` fails; readiness probe returns 503. | Run `docker restart fixforge-pilot-worker`. The worker entrypoint cleans up dangling containers and re-initializes rootless daemon. |
| **Interrupted Server / Unclean Shutdown** | Server restarted while repair jobs were in-flight. | Start API container. `reconcileInterruptedJobs()` automatically marks unfinished repairs as `failed` with reason `interrupted by server restart`. |
| **Database Corruption / Schema Issue** | API logs `SQLITE_CORRUPT` or `PRAGMA integrity_check` fails. | Follow Section 4.C to restore the latest daily snapshot from `/data/backups/`. |
| **Compromised Secret / Session Token** | Suspicious session activity detected in audit logs. | Re-run `bash scripts/generate-pilot-secrets.sh --force`, update `.env.pilot`, and execute `docker compose -f docker-compose.pilot.yml up -d --force-recreate`. All previous tokens will immediately be invalidated. |
