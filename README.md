# FixForge

FixForge is an autonomous software repair platform foundation. It is designed around a strict rule:

> Generated is not fixed. Executed + tested + verified is fixed.

FixForge provides a React/Vite control room, a Node/Express API, a local SQLite database, and a FastAPI/LangGraph AI service boundary.

---

## Milestone 1, 2 & 3 Summary

### Milestone 1: Platform Foundation
- React/Vite frontend (ESM + JavaScript + Tailwind CSS).
- Node.js + Express backend with structured logging.
- SQLite + Prisma database with models for Projects, RepairJobs, and ActivityEvents.
- FastAPI AI service stub with health monitoring.

### Milestone 2: Repository Analysis & Baseline Testing
- **Workspace Security**: `WorkspaceManager` preventing directory traversal (`../`) and symlink escapes.
- **Repository Analyzer**: Recursive file discovery, filtering `.git`/`.venv`/`__pycache__`, auto-detecting Python version, manifests, and test frameworks (`pytest`, `unittest`).
- **Normalized Failure Signatures**: Extracting test name, error type, message, file reference, and stack traceback.
- **LangGraph State Graph**: `INIT` → `REPOSITORY_ANALYSIS` → `BASELINE_TESTING` → `FAILURE_DETECTION`.

### Milestone 3: Docker Sandbox + Safe Execution Runner
- **ExecutionRunner Interface**: Extensible abstraction with `DockerSandboxRunner` and `LocalExecutionRunner`.
- **Docker Sandbox Architecture (`ai-agent/app/sandbox/`)**:
  - `DockerSandboxRunner`: Ephemeral container runner with timeout enforcement, process limits, and guaranteed cleanup.
  - `SandboxConfig`: Configurable parameters (`SANDBOX_TIMEOUT`, `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `SANDBOX_PIDS_LIMIT`, `SANDBOX_OUTPUT_LIMIT`).
  - `SandboxSecurity`: Workspace containment checks, command sanitization, and strict environment filtering.
  - `SandboxLifecycle`: Unique container naming (`fixforge-sandbox-{job_id}-{run_id}`), output truncation with warning banner, and `finally` cleanup.
  - Non-root user `sandboxuser` (UID 1000).
  - Network isolation (`--network none`).
- **Dedicated Sandbox Image**: `sandbox/Dockerfile` (Python 3.11-slim, pytest, minimal tooling).
- **Database Persistence**: `SandboxRun` model linked to `RepairJob`.
- **Frontend Control Room**:
  - "Run in Sandbox" action button.
  - Sandbox Execution card with `SANDBOXED ✓` / `LOCAL EXECUTION` indicator, duration, exit code, and tabbed stdout/stderr output viewer.
  - Execution History timeline displaying previous runs.

### Milestone 4: AI Root Cause Analysis + Patch Generation
- **Structured Debugging Node**: Distinguishes OBSERVED FACTS from AI HYPOTHESES and SOURCE EVIDENCE with structured confidence.
- **Context Selection & Budget**: Controlled context window enforcing `MAX_CONTEXT_FILES`, `MAX_FILE_SIZE`, and `MAX_CONTEXT_CHARS` to prevent sending massive repos to the LLM.
- **Provider Abstraction**: Decoupled `LLMProvider` interface with deterministic `MockLLMProvider` for offline CI and `OpenAICompatibleProvider` (supporting OpenAI, Ollama, DeepSeek, Nvidia NIM).
- **Patch Planning & Generation**: Generates minimal unified diffs adhering to the minimal patch principle (1–5 line modifications preferred).
- **Deterministic Patch Validation**:
  - Rejects patches modifying test files (tests are read-only during repair).
  - Rejects directory traversal (`../`) and path escapes outside the workspace.
  - Requires review for critical infrastructure/security files (Dockerfiles, CI, `.env`).
- **Safe Patch Application**: Automatic backup snapshots in `.fixforge_backups/`, transactional hunk application, atomic rollback on failure, and git diff tracking before/after.
- **Prisma & SQLite Persistence**: `Patch` model recording diffs, affected files, root cause, plan, validation, and application status.
- **Frontend Control Room**:
  - Root Cause Analysis card with observed facts, hypothesis, evidence, and AI confidence.
  - Patch Plan card with objective, planned file changes, and risk warnings.
  - Unified Diff Viewer with syntax highlighting.
  - Safe `[ Apply Patch ]` action with validation warnings and status indicators.
  - Agent Timeline reflecting the 7 repair progression stages.

### Milestone 5: Self-Correction Loop & Verification Timeline
- **Multi-Attempt Autonomous Repair**: Bounded repair loop with configurable `MAX_REPAIR_ATTEMPTS=3`, `MAX_REPAIR_TIME=600`, and `MAX_TOTAL_LLM_CALLS=10`.
- **LangGraph Conditional Looping**: State machine with conditional edge routing on verification outcome (`should_verify_or_rollback`) and retry limits (`check_retry_condition`).
- **Real Verification Testing**: Executes post-patch repository using `ExecutionRunner` (`DockerSandboxRunner` in production). Success strictly requires exit code 0, 0 test failures, and 0 regressions.
- **Regression Detection**: Analyzes post-patch test failures against baseline failure signatures; automatically rejects regressive patches and flags `REGRESSION_DETECTED`.
- **Transactional Rollback**: Restores original repository state from `.fixforge_backups/` using `PatchApplier.rollback()` before initiating new analysis attempts.
- **Previous Attempt Memory**: Injects structured historical failure evidence (previous hypothesis, previous patch, verification stderr, regressions) into the root cause analyzer prompt on subsequent attempts.
- **Duplicate Patch Prevention**: Computes deterministic SHA-256 hashes of generated patches to detect and reject identical patches (`DUPLICATE_PATCH_DETECTED`), requesting alternative repair strategies.
- **Database Persistence**: `RepairAttempt` model in SQLite Prisma schema recording attempt numbers, status, root cause, patch diffs, patch hashes, verification results, duration, and rollback status.
- **Frontend Timeline & Control Room**:
  - `[ Start Autonomous Repair ]` action button.
  - Verified Repair Summary card (Attempts, Tests passing, Regressions, Docker Sandbox verification).
  - Expandable Attempt Cards (Attempt 1, 2, 3 with status, diff, verification output, and rollback indicators).
  - Real-time agent event stream.

> **Scope Notice**: GitHub automatic PR creation, git push, and distributed job queues are reserved for Milestone 6.

---

## Running the Services

### 1. Python AI Agent
```bash
cd ai-agent
py -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 2. Node API Server
```bash
npm --workspace=@workspace/api-server run dev
```

### 3. Frontend Web App
```bash
npm --workspace=@workspace/fixforge run dev
```

---

## Verifying Tests

```bash
# Python AI agent tests
cd ai-agent
py -m pytest tests -v

# Node backend tests
npm --workspace=@workspace/api-server test

# Frontend production build
npm --workspace=@workspace/fixforge run build
```

---

## Roadmap

1. Milestone 1 — Core Architecture & Database Cleanup ✓
2. Milestone 2 — Repository Analysis & Baseline Test Execution ✓
3. Milestone 3 — Docker Sandbox & Safe Execution Runner ✓
4. Milestone 4 — AI Root Cause Analysis & Patch Generation ✓
5. Milestone 5 — Self-Correction Loop & Verification Timeline ✓
6. Milestone 6 — Verification Reports & Human-Approved PR Creation