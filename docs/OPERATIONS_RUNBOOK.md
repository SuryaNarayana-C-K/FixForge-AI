# FixForge Operations Runbook & Production Deployment Guide

## 1. Overview & Architecture
FixForge is an autonomous software repair and verification platform composed of:
1. **React / Vite Frontend**: SPA running on port 3000 (dev) or served via reverse proxy (production).
2. **Node.js / Express API**: REST API on port 5000 handling authentication, RBAC, tenant isolation, quota management, and repair lifecycle state transitions.
3. **Database**: Prisma ORM with SQLite (`database/dev.db`) for single-node deployments; PostgreSQL for multi-replica high-availability deployments.
4. **Python / FastAPI AI Agent**: Intelligence service on port 8000 driving root-cause analysis, patch generation, patch validation, and self-correction loops.
5. **Docker Sandbox Runner**: Enforced Docker isolation (`--network none`, non-root user `uid=1000`, read-only rootfs, dropped capabilities, `no-new-privileges`, CPU/memory/PID limits) executing untrusted test suites.

---

## 2. Environment Configuration

### Required Production Environment Variables
| Variable | Description | Production Requirement | Default Dev Value |
|---|---|---|---|
| `NODE_ENV` | Environment identifier | Must be `production` | `development` |
| `FIXFORGE_ENV` | Platform runtime environment | Must be `production` | `development` |
| `PORT` | API Server port | Valid TCP port (e.g. `5000`) | `5000` |
| `JWT_SECRET` | Secret key for signing session tokens | Minimum 32 characters, cryptographically random | Insecure dev default (BLOCKED in prod) |
| `DATABASE_URL` | Prisma database connection string | Valid connection string | `file:../../../database/dev.db` |
| `AI_SERVICE_URL` | Python AI Agent endpoint | Internal network URL (e.g. `http://ai-agent:8000`) | `http://localhost:8000` |
| `ALLOW_LOCAL_SUBPROCESS`| Allow host execution fallback | **Must be false / unset**; host execution is blocked in prod | `false` |
| `SANDBOX_ENFORCE_DOCKER`| Force Docker execution | Always `true` in production | `false` |
| `GITHUB_TOKEN` | Token for opening pull requests | Required for GitHub delivery | Unset |

> [!CAUTION]
> If `NODE_ENV=production` or `FIXFORGE_ENV=production` is detected:
> - The API server refuses to start if `JWT_SECRET` is less than 32 characters or uses the development default.
> - The demo fallback (`DEMO_USERS.ADMIN`) is disabled; unauthenticated requests receive `401 UNAUTHORIZED`.
> - The `x-demo-role` header is ignored.
> - The Python runner permanently prohibits local subprocess execution even if `ALLOW_LOCAL_SUBPROCESS=true` is requested.

---

## 3. Liveness & Readiness Probes

### Liveness Probe (`GET /api/healthz`)
- **Purpose**: Verifies that the Express API process is alive and responding to HTTP requests.
- **Expected Status**: `HTTP 200`
- **Payload**: `{"status": "ok"}`
- **Action on Failure**: Container restart.

### Readiness Probe (`GET /api/readyz`)
- **Purpose**: Verifies end-to-end operational capacity:
  1. Database connectivity (`SELECT 1`)
  2. AI Agent service connectivity (`/healthz`)
  3. Docker sandbox runner availability (`/sandbox/health`)
- **Expected Status**: `HTTP 200` (`status: "ready"`)
- **Degraded Status**: `HTTP 503` (`status: "not_ready"`) with sanitized, actionable issues (no connection strings, passwords, or internal paths leaked).
- **Action on Failure**: Remove pod/container from load balancer routing until dependencies recover.

---

## 4. Startup & Shutdown Procedures

### Application Startup
1. Start Docker Daemon / Docker Desktop.
2. Ensure `fixforge-sandbox:latest` image is built:
   ```bash
   docker build -t fixforge-sandbox:latest -f ai-agent/Dockerfile.sandbox .
   ```
3. Start Python AI Agent:
   ```bash
   cd ai-agent
   $env:PYTHONPATH="."
   py -m uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
4. Start Node.js API Server:
   ```bash
   cd artifacts/api-server
   node src/index.js
   ```
   *At startup, the API server executes:*
   - Startup configuration validation (`enforceStartupConfig`).
   - Database reconciliation (`reconcileInterruptedJobs`): any repairs left in running/verifying/analyzing states from a previous unclean shutdown are safely transitioned to `failed`.
   - Dispatch to Python agent to prune orphaned sandbox containers.

### Graceful Shutdown
1. Send `SIGTERM` to Express API server:
   - Stops accepting new repair requests.
   - Allows in-flight idempotent completions or transitions active slots to abort.
2. Send `SIGTERM` to Python AI Agent:
   - Signals running container tasks to abort.
   - Cleans up active Docker containers immediately.

---

## 5. Database Backup, Restore & Data Retention

### Hot Backup Procedure
FixForge provides an online, zero-downtime backup script using SQLite `VACUUM INTO`:
```bash
node scripts/db-backup-restore.js backup
```
- Performs a transactionally consistent copy of `database/dev.db`.
- Computes SHA-256 integrity digest and verifies SQLite magic header.
- Saves timestamped snapshot into `database/backups/fixforge-backup-<ISO_TIMESTAMP>.db`.

### Restore Procedure
1. Stop the API server and AI agent processes.
2. Restore the database from verified backup:
   ```bash
   node -e "import('./scripts/db-backup-restore.js').then(m => m.restoreDatabaseBackup('database/backups/<backup-file>.db'))"
   ```
3. Run schema verification:
   ```bash
   node scripts/db-backup-restore.js verify
   ```
4. Restart the API server and agent.

### Data Retention Guarantee
Schema migrations and database updates must preserve:
- `users` and `organizations`
- `projects` and `repair_jobs`
- `activity_events` and `audit_logs`
- `patches` and `repair_attempts`

Run `node scripts/db-backup-restore.js verify` to assert zero historical data loss after migrations.

---

## 6. SQLite Single-Instance Limitation & PostgreSQL Migration Path

### SQLite Limitation
- **Single Concurrency Domain**: SQLite supports multiple concurrent readers but only **one concurrent writer**.
- **Process Boundary**: SQLite databases mounted on shared NFS/EFS volumes across multiple container replicas risk database locking (`SQLITE_BUSY`) and file corruption.
- **Deployment Topology**: With SQLite, FixForge API server must run as a **single instance**.

### Migration Path to Multi-Replica PostgreSQL
For multi-replica, highly available production clusters:
1. Provision a managed PostgreSQL instance (e.g. AWS RDS PostgreSQL, Google Cloud SQL, or Azure Database for PostgreSQL) version 15+.
2. Update `lib/db/prisma/schema.prisma`:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```
3. Generate and apply Prisma migrations:
   ```bash
   npx prisma migrate dev --name init_postgresql
   npx prisma generate
   ```
4. Run data transfer utility or pgloader to transfer historical records from `dev.db` to PostgreSQL.
5. Scale API server horizontally behind an Application Load Balancer / Ingress Controller.

---

## 7. Docker Resource Management & Targeted Cleanup

### Safe Resource Cleanup Policy
> [!IMPORTANT]
> **Never run indiscriminate commands** like `docker system prune -a` or `docker volume prune -f` in production, as this destroys caches and untracked container storage belonging to other workloads.

### Targeted FixForge Cleanup Command
FixForge sandbox containers are strictly named with the prefix `fixforge-sandbox-` and labeled with `app=fixforge-sandbox`.

Run targeted cleanup:
```bash
# 1. Stop any stuck FixForge sandbox containers older than 10 minutes
docker ps -q --filter "name=fixforge-sandbox-*" | ForEach-Object { docker stop -t 2 $_ }

# 2. Remove stopped FixForge sandbox containers
docker rm -f $(docker ps -a -q --filter "name=fixforge-sandbox-*")

# 3. Clean up dangling sandbox build layers
docker image prune -f --filter "label=app=fixforge-sandbox"
```

---

## 8. Incident Response Procedures

| Incident | Symptoms | Diagnosis Steps | Remediation |
|---|---|---|---|
| **Host Subprocess Escalation Attempt** | Logs show `CRITICAL SECURITY: Local host subprocess execution is permanently disabled in production mode.` | Audit request origin and check `ALLOW_LOCAL_SUBPROCESS` env setting. | Ensure `FIXFORGE_ENV=production` is locked; ensure Docker engine is running. |
| **Cross-Tenant IDOR Attempt** | Audit log shows `ACCESS_DENIED` with `Cross-organization repair access attempt`. | Check user ID, organization membership, and resource ID from `audit_logs`. | Verify credentials; revoke compromised session token if suspicious. |
| **Stuck Container / Sandbox Timeout** | Active repair slot remains occupied without completing. | Check `GET /api/repairs/stats/concurrency`; check `docker ps`. | Call `POST /api/repairs/:id/cancel`; lifecycle manager aborts controller and executes `docker rm -f`. |
| **GitHub Delivery Rejection** | Delivery status `FAILED` with `UNVERIFIED_REPAIR_BLOCKED` or `POLICY_VIOLATION`. | Inspect repair verification level and tests passed in repair record. | Delivery is intentionally blocked for unverified or unapproved repairs; run empirical verification first. |
