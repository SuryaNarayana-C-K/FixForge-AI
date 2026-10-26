# FixForge Security

FixForge treats every repository as untrusted. Milestone 3 implements the **Docker Sandbox + Safe Execution Runner** to safely isolate repository inspection and test execution.

---

## 1. Security Architecture & Threat Model

The primary security boundary in FixForge is:
```
FixForge Agent
     ↓
ExecutionRunner (interface)
     ↓
DockerSandboxRunner
     ↓
Docker Isolation (cgroups, namespaces, seccomp)
     ├── Non-root user (sandboxuser, UID 1000)
     ├── Filesystem Isolation (only isolated workspace mounted, read/write)
     ├── Network Isolation (--network none)
     ├── Resource Limits (CPU, Memory, PIDs)
     ├── Environment Filtering (strict allowlist, no host secrets)
     └── Execution Lifecyle & Guaranteed Cleanup (finally-guaranteed container removal)
```

FixForge assumes that repository code, test fixtures, dependencies, and configuration files may contain:
- Arbitrary code execution or exploitation attempts
- Resource exhaustion attacks (fork bombs, CPU loops, memory allocations, disk flooding)
- Network egress attempts (probing cloud metadata, internal LAN, exfiltrating credentials)
- Host environment snooping (inspecting env variables, SSH keys, credentials)
- Host filesystem traversal attacks (`../`, symlinks escaping root)

---

## 2. Sandbox Controls & Defenses

### A. Non-Root Execution
- The sandbox image (`sandbox/Dockerfile`) creates a non-root user `sandboxuser` with UID 1000.
- Container execution is launched with `--user 1000:1000`.
- The user has minimal privileges necessary to execute test runners in `/workspace`. No sudo or root capabilities (`--cap-drop=ALL` where applicable) are granted.

### B. Filesystem Isolation
- The container only mounts the designated repository workspace directory at `/workspace`.
- Sensitive host directories (`/`, `/home`, `/root`, `/etc`, `/var`, `C:\Windows`, etc.) are never mounted.
- Docker socket (`/var/run/docker.sock` or `//./pipe/docker_engine`) is strictly forbidden and never exposed inside the container.
- Paths are validated by `WorkspaceManager` prior to mount, rejecting directory traversal (`../`) and symlink escapes outside the workspace boundary.

### C. Network Restriction
- The sandbox runs with `--network none` by default.
- No incoming or outgoing network access is permitted.
- Untrusted code cannot contact internal microservices, host loopback services, private clouds, or cloud metadata endpoints (`169.254.169.254`).

### D. Resource Limits (Cgroups)
Resource limits are strictly enforced and configurable via environment variables:
- **CPU**: Default `1` CPU core (`--cpus=1` / `SANDBOX_CPUS`).
- **Memory**: Default `512m` (`--memory=512m` / `SANDBOX_MEMORY`).
- **Process / PID Limit**: Default `128` processes (`--pids-limit=128` / `SANDBOX_PIDS_LIMIT`). Protects against fork bombs and runaway subprocess cascades.
- **Output Limit**: Default `5MB` (`SANDBOX_OUTPUT_LIMIT=5242880`). Output exceeding this limit is safely truncated with `[output truncated by FixForge sandbox]`.
- **Repository Size**: Maximum repository size is checked before execution (`WorkspaceManager.MAX_REPO_BYTES`).

### E. Environment Isolation
- Host environment variables (including database credentials, API keys, GitHub tokens, JWT secrets, SSH keys) are completely stripped.
- Containers receive only an explicit minimal allowlist:
  ```
  PYTHONUNBUFFERED=1
  PYTHONDONTWRITEBYTECODE=1
  LANG=C.UTF-8
  LC_ALL=C.UTF-8
  ```

### F. Timeout & Lifecycle Cleanup Guarantee
- Configurable process execution timeout (`SANDBOX_TIMEOUT=120` seconds).
- Guaranteed container cleanup: Containers are named uniquely `fixforge-sandbox-{job_id}-{run_id}`.
- Every container is stopped and force-removed (`docker rm -f`) in a `finally` block, ensuring no orphan or zombie containers remain even if:
  - The test process times out
  - The execution fails with non-zero exit code
  - A Docker daemon or API error occurs
  - The process crashes or is aborted

---

## 3. Execution Mode Selection

FixForge supports two execution modes configured by `EXECUTION_MODE`:

1. **`docker` (Production Default)**:
   - Untrusted code executes solely inside isolated Docker containers via `DockerSandboxRunner`.
   - If Docker is unavailable, FixForge returns structured error `SandboxUnavailable` and **never silently falls back to host execution**.
2. **`local` (Development / Test Only)**:
   - Uses `LocalExecutionRunner` for trusted demo repositories in controlled local development environments where Docker is not installed.
   - Distinctly labeled in the UI as `LOCAL EXECUTION` (never marked as `SANDBOXED ✓`).

---

## 4. Milestone 4: Patch Generation & Application Security

FixForge treats every LLM-generated patch as **untrusted input**. An AI model must never have write access to host filesystems or arbitrary shell execution.

### A. Separation of Roles: Propose vs Validate
- **The LLM proposes**: Generates a unified diff as plain text.
- **Application code validates and executes**: Deterministic Python code (`PatchValidator`, `PatchApplier`) parses, inspects, validates, backs up, and applies modifications.
- The LLM is never given direct filesystem access, file descriptor writing, or execution permissions.

### B. Test File Modification Rejection
- **Rule**: Repair agents must never "fix" broken software by deleting, weakening, or altering assertions in tests.
- **Enforcement**: Any patch touching test directories (`tests/`, `test/`) or test files (`test_*.py`, `*_test.py`) is immediately rejected with `TEST_MODIFICATION_REJECTED`.

### C. Workspace Containment & Path Traversal Rejection
- Unified diff file headers (`--- a/...`, `+++ b/...`) are checked for path traversal attempts (`../`, `..\\`).
- Absolute paths (`/etc/...`, `C:\...`) and paths escaping the approved repository directory are rejected with `WORKSPACE_ESCAPE_REJECTED`.

### D. Protected Infrastructure & Secret File Policies
- Patches touching Dockerfiles (`Dockerfile`, `docker-compose.yml`), CI/CD workflows (`.github/workflows/`), security files (`SECURITY.md`), or environment secrets (`.env`, `.env.*`) are flagged as `REQUIRES_REVIEW` and cannot be silently applied.

### E. Atomic Backups and Reversible Application
- Before any file is modified, `PatchApplier` snapshots the file into `.fixforge_backups/`.
- If applying any hunk fails or encounters an unexpected line mismatch, all modified files are automatically restored from backup to prevent repository corruption.

---

## 5. Threat Model & Limitations

While the Docker sandbox and patch validation significantly reduce attack surface, isolation has recognized boundaries:
- **Shared Linux Kernel**: Containers share the host kernel. Hardening for enterprise multi-tenant deployments requires hypervisor-level isolation (e.g. gVisor, Firecracker, or Kata Containers).
- **Pre-installed Dependencies**: In this milestone, dependencies must either be bundled in the sandbox image or self-contained in the repository. Unrestricted network-based dependency installation is intentionally disabled.
- **Local Fallback Separation**: In local development mode (`EXECUTION_MODE=local`), host execution is permitted only for trusted developer repositories. Production deployments must set `EXECUTION_MODE=docker`.
- **Patch Correctness**: Generated patches are verified structurally and syntactically at Milestone 4, and validated with execution and test verification at Milestone 5.

---

## 6. Milestone 5: Self-Correction & Verification Loop Security Controls

Milestone 5 adds autonomous verification and looping while preserving all M1–M4 security guarantees:

### A. Deterministic Verification Authority
- The LLM **never** decides whether a repair is successful.
- Deterministic systems decide:
  - Process exit code (must be 0).
  - Test runner output parser (0 failed tests).
  - Regression detector (0 new failures compared to baseline).
  - Sandbox status (must be `completed` without timeout or resource limit trigger).
- Only when all deterministic criteria are satisfied is `job.status` set to `VERIFIED`.

### B. Human Review Boundary Enforcement
- If `PatchValidator` determines that a patch modifies protected infrastructure (`Dockerfile`, CI workflows, secrets), the patch is flagged with `REQUIRES_REVIEW`.
- The autonomous loop stops immediately and transitions the job to `REQUIRES_REVIEW`.
- The loop **never** bypasses human review or attempts to re-plan past protected file restrictions.

### C. Regression Detection & Mandatory Rollback
- If a patch causes new test failures (regressions), it is marked as `REGRESSION_DETECTED`.
- `PatchApplier.rollback()` automatically restores original files from `.fixforge_backups/` to prevent repository corruption before re-attempting repair.

### D. No Self-Modifying Agent Target
- The agent target is strictly the repository being repaired.
- The agent is never permitted to modify its own code, sandbox configuration, host system files, or CI credentials.

### E. Budget & Timeout Enforcement
- **Attempt Budget**: Default `MAX_REPAIR_ATTEMPTS=3`. Never loops indefinitely.
- **Time Budget**: Default `MAX_REPAIR_TIME=600` seconds. Halts execution and cleans up resources if exceeded.
- **LLM Call Budget**: Default `MAX_TOTAL_LLM_CALLS=10`. Halts execution if token/call limit is exceeded.
- **Duplicate Patch Suppression**: SHA-256 patch hashing prevents wasteful attempts with identical diffs.

---

## 7. Milestone 6: GitHub Integration Security & Safety Controls

Milestone 6 introduces GitHub publishing with defense-in-depth safety boundaries:

### A. Server-Side Secret Protection
- **`GITHUB_TOKEN` Isolation**: Tokens exist only on the Node backend via server environment variables.
- **No Token Exposure**: Tokens are never sent to the React frontend, never exposed in API responses, never written to SQLite, never committed to git, and never displayed in logs.
- **Sanitization Filter**: Any error messages returned from GitHub APIs or Git subprocesses are automatically sanitized by `GitHubProvider.sanitize()` to redact Authorization headers and bearer tokens.

### B. Verified-Only Publishing Gate
- Git branch creation, commit creation, and pull request creation are strictly blocked unless `repair.status === 'VERIFIED'`.
- Failed repairs, regressions, timeouts, and unreviewed patches cannot trigger Git or GitHub operations.

### C. Human Review Boundary & Automatic Merge Prohibition
- The FixForge workflow terminates strictly at `PR_CREATED` with the status `Awaiting Human Review`.
- The AI system is structurally prohibited from merging Pull Requests. Merging must be performed manually by an authorized developer via the GitHub web UI or CLI.

### D. Default Branch Protection
- FixForge never commits directly to `main`, `master`, or the configured default branch.
- A dedicated repair branch (e.g. `fixfixforge/repair-<id>`) is always created and checked out prior to staging or committing.

### E. Unrelated Change Protection
- Git staging uses explicit file paths (`git add -- <file>`) matching only the files modified by the verified repair.
- Any unrelated developer files, uncommitted workspace changes, or untracked documentation remain untouched in the working tree and are never staged or committed.