# FixForge Architecture

## 1. Service Boundaries

```text
React + Vite UI (port 3000)
    ↓ REST / Generated Zod APIs
Node.js + Express API (port 5000)
    ├── SQLite + Prisma (database/dev.db)
    │     ├── repair_jobs
    │     ├── sandbox_runs (Milestone 3)
    │     ├── activity_events
    │     └── projects & repositories
    ↓ HTTP Boundary (/agent/analyze, /sandbox/run, /sandbox/health)
Python FastAPI AI Service (port 8000)
    ├── LangGraph State Machine
    ├── Repository Analyzer & Workspace Security
    └── ExecutionRunner Interface
          ├── DockerSandboxRunner (Milestone 3 Production)
          │     ↓ Docker Engine API / CLI
          │   Isolated Docker Container (sandboxuser, no network, cgroups limits)
          └── LocalExecutionRunner (Development / Offline Test Mode)
```

The Node API owns persistence, users, projects, repair job lifecycle, and activity history.
The Python AI service owns agent orchestration, static repository analysis, and sandboxed test execution.

---

## 2. ExecutionRunner Abstraction

FixForge decouples execution mechanics from agent reasoning via `ExecutionRunner`:

```python
class ExecutionRunner(ABC):
    @abstractmethod
    async def run(
        self,
        command: str,
        workspace: Path,
        options: ExecutionOptions | None = None,
    ) -> ExecutionResult:
        pass
```

### Implementations:
1. **`DockerSandboxRunner` (`ai-agent/app/sandbox/docker_runner.py`)**:
   - Production runner executing commands inside isolated ephemeral Docker containers.
   - Enforces non-root user (`sandboxuser`), `--network none`, CPU/memory/PIDs limits, and output limits.
   - Guaranteed cleanup (`finally` block stopping and force-removing containers).
   - Returns structured `ExecutionResult` with `sandboxed=True` and `container_id`.

2. **`LocalExecutionRunner` (`ai-agent/app/runner.py`)**:
   - Host process runner with process timeout and command normalization (`sys.executable -m pytest`).
   - Reserved strictly for local development and test environments where Docker is not installed (`EXECUTION_MODE=local`).
   - Returns `ExecutionResult` with `sandboxed=False`.

Runner selection is resolved via `get_execution_runner(mode=None)`, defaulting to `EXECUTION_MODE` environment variable (`docker` in production).

---

## 3. Docker Sandbox Package Architecture

Located in `ai-agent/app/sandbox/`:

- **`config.py`**: Encapsulates `SandboxConfig` reading configurable limits from environment variables:
  - `SANDBOX_TIMEOUT` (default: 120s)
  - `SANDBOX_MEMORY` (default: 512m)
  - `SANDBOX_CPUS` (default: 1)
  - `SANDBOX_PIDS_LIMIT` (default: 128)
  - `SANDBOX_OUTPUT_LIMIT` (default: 5MB)
  - `SANDBOX_IMAGE` (default: `fixforge-sandbox:latest`)
  - `SANDBOX_USER` (default: `sandboxuser`)
  - `SANDBOX_NETWORK` (default: `none`)
  - `EXECUTION_MODE` (default: `docker`)

- **`security.py`**:
  - `validate_sandbox_workspace`: Ensures target repository path is strictly contained within allowed workspaces using `WorkspaceManager`.
  - `validate_sandbox_command`: Rejects empty or unsafe tokens while preserving standard test runner commands.
  - `build_sandbox_environment`: Completely purges host environment secrets; passes only explicitly approved runtime flags (`PYTHONUNBUFFERED=1`, etc.).

- **`lifecycle.py`**:
  - `generate_container_name`: Produces unique `fixforge-sandbox-{job_id}-{run_id}` names avoiding naming collisions in concurrent jobs.
  - `truncate_output`: Safely limits stdout/stderr bytes and appends truncation warning.
  - `build_docker_run_args`: Generates CLI argument array with security and resource flags (`--rm`, `--user`, `--network none`, `--memory`, `--cpus`, `--pids-limit`, volume mount).
  - `cleanup_container`: Guarantees container termination and removal via `docker rm -f`.

- **`docker_runner.py`**:
  - Orchestrates container lifecycle: validation → execution → timeout enforcement → output capture → guaranteed cleanup → normalized result.
  - Implements `is_docker_available` health check.

- **`errors.py`**:
  - Clean exception hierarchy: `SandboxUnavailable`, `SandboxTimeout`, `SandboxResourceLimit`, `SandboxWorkspaceViolation`, `SandboxStartupFailure`, `SandboxExecutionFailure`, `SandboxCleanupFailure`.

---

## 4. Sandbox Image

Defined in `sandbox/Dockerfile`:
- Base: `python:3.11-slim`
- User: `sandboxuser` (UID 1000, non-root)
- Dependencies: Pre-installed `pytest==8.3.4` and essential Python tooling
- Workdir: `/workspace`

---

## 5. Database Schema & Persistence

SQLite schema (`lib/db/prisma/schema.prisma`) includes:

```prisma
model SandboxRun {
  id          String    @id
  repairJobId String    @map("repair_job_id")
  command     String
  status      String    // completed, failed, timeout
  exitCode    Int?      @map("exit_code")
  stdout      String?
  stderr      String?
  duration    Float
  timedOut    Boolean   @default(false) @map("timed_out")
  sandboxed   Boolean   @default(false)
  containerId String?   @map("container_id")
  createdAt   DateTime  @default(now()) @map("created_at")

  repairJob   RepairJob @relation(fields: [repairJobId], references: [id], onDelete: Cascade)
  @@map("sandbox_runs")
}
```

A `RepairJob` has a 1-to-many relationship with `SandboxRun`, laying the foundation for tracking multiple test execution attempts in future self-correction loops.

---

## 6. LangGraph State Machine

### Milestone 4 Extended Pipeline
```text
INIT
  ↓
REPOSITORY_ANALYSIS
  ↓
BASELINE_TESTING
  ↓
FAILURE_DETECTION
  ↓
ROOT_CAUSE_ANALYSIS
  ↓
PATCH_PLANNING
  ↓
PATCH_GENERATION
  ↓
PATCH_VALIDATION
  ↓
PATCH_APPLICATION (Optional / Controlled)
  ↓
END
```

- `BASELINE_TESTING`: Uses `get_execution_runner()` to execute tests. In production, this executes securely inside the Docker container.
- `ROOT_CAUSE_ANALYSIS`: Context-aware root-cause debugging node generating structured fact vs hypothesis analysis.
- `PATCH_PLANNING`: Produces an actionable, minimal repair plan before diff generation.
- `PATCH_GENERATION`: Generates unified diffs obeying minimal patch principles.
- `PATCH_VALIDATION`: Deterministic security and syntactic gatekeeper before disk writes.
- `PATCH_APPLICATION`: Transactional patch applier creating snapshots with automatic rollback.

---

## 7. AI Root Cause Analysis & Structured Debugging

FixForge treats root cause analysis not as conversational prompting, but as structured evidence synthesis:

### Fact vs Hypothesis Separation
1. **Observed Facts**: Real output from baseline test execution (exact assertion error, returned value, expected value, stack frame).
2. **AI Hypotheses**: The model's deductive reasoning explaining why the code triggered the observed error.
3. **Source Evidence**: Verified repository files and line numbers where the faulty logic resides.
4. **Confidence**: Scaled 0.0 to 1.0 representing AI confidence (not mathematical correctness probability).

### Schema (`RootCauseAnalysis`)
```python
class RootCauseAnalysis(BaseModel):
    summary: str
    failure_type: str
    root_cause: str
    observed: str
    hypothesis: str
    evidence: list[RootCauseEvidence]
    confidence: float
```

Evidence files are deterministically checked against the real workspace before accepting the output to prevent hallucination of non-existent files.

---

## 8. Context Selection & Context Budget

Located in `ai-agent/app/context/`:
- **Context Budget (`config.py`)**: Configurable thresholds to prevent overflowing the LLM context window:
  - `MAX_CONTEXT_FILES`: default 5
  - `MAX_FILE_SIZE`: default 64KB
  - `MAX_CONTEXT_CHARS`: default 32,000 characters
  - `MAX_TRACEBACK_SIZE`: default 4,000 characters
- **Smart Context Selector (`context_selector.py`)**:
  1. Captures focal failure tracebacks.
  2. Extracts failing test file and lines.
  3. Extracts source file references from stack traces.
  4. Resolves imported modules and source mappings (e.g. `test_calculator.py` → `calculator.py`).
  5. Assembles token-efficient line windows with line numbers.

---

## 9. Model Provider Abstraction

Located in `ai-agent/app/providers/`:
- **`LLMProvider` (ABC)**: Abstract interface exposing `complete()` and `generate_structured()`.
- **`MockLLMProvider`**: Deterministic provider for CI testing and offline evaluation without API keys.
- **`OpenAICompatibleProvider`**: Universal provider compatible with OpenAI, Ollama, DeepSeek, vLLM, and Nvidia NIM via OpenAI-compatible REST endpoints.
- **`get_llm_provider()`**: Factory dynamically selecting the active provider based on `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_API_KEY`.

---

## 10. Patch Planning & Minimal Patch Principle

Located in `ai-agent/app/patch_schemas.py` and `ai-agent/app/graph/nodes/patching.py`:
- **Patch Plan**: Generated prior to diff generation. Outlines objective, files to modify, specific changes per location, and risk factors.
- **Minimal Patch Principle**: Instructs LLM to generate the smallest possible changeset (1–5 lines preferred). Full file rewrites are strictly avoided.
- **Unified Diff Format**: Diff is captured separately from explanation without natural-language commentary inside the diff text.

---

## 11. Deterministic Patch Validation

Located in `ai-agent/app/patch/validator.py`:
- **Test File Protection**: Strictly rejects any patch attempting to modify test files (`tests/`, `*_test.py`, `test_*.py`). Tests are read-only during repair.
- **Workspace Containment**: Prevents directory traversal (`../`) and path escapes outside the approved repository.
- **Protected File Policy**: Marks patches modifying critical infrastructure (`Dockerfile`, `.env`, CI configurations) as `REQUIRES_REVIEW`.
- **Dry-Run Syntax & Line Matching**: Verifies unified diff headers (`--- a/...`, `+++ b/...`) and confirms target lines exist in the target file before writing to disk.

---

## 12. Safe Patch Application Engine

Located in `ai-agent/app/patch/applier.py`:
1. **Validation Check**: Pre-application structural validation.
2. **Snapshot Creation**: Stores backup copy of target files under `.fixforge_backups/` before modifying anything.
3. **Transactional Apply**: Applies hunks file-by-file; on any error, automatically restores original files from snapshot.
4. **Git Diff Recording**: Captures `git diff` before and after patch application to track exact repo mutations.
5. **Persistence**: Records diff, changed files, lines added/removed, and application status in the SQLite `patches` table via Prisma.

---

## 13. Self-Correction & Verification Loop (Milestone 5)

FixForge transforms repair from a linear pipeline into an evidence-driven self-correction loop:

```text
INIT
  ↓
REPOSITORY_ANALYSIS
  ↓
BASELINE_TESTING
  ↓
FAILURE_DETECTION
  ↓
┌────────────────────────────────────────────────────────┐
│ ATTEMPT LOOP (maxAttempts = 3)                         │
│                                                        │
│  ROOT_CAUSE_ANALYSIS (with Attempt History context)    │
│    ↓                                                   │
│  PATCH_PLANNING                                        │
│    ↓                                                   │
│  PATCH_GENERATION (detects duplicate hashes)           │
│    ↓                                                   │
│  PATCH_VALIDATION (checks human review boundary)       │
│    ↓                                                   │
│  PATCH_APPLICATION (creates transactional backup)       │
│    ↓                                                   │
│  VERIFICATION_TESTING (executes Docker Sandbox)        │
│    ↓                                                   │
│  VERIFICATION_ANALYSIS                                 │
│    ↓                                                   │
│  Decision:                                             │
│    ├─ PASS (0 failures, 0 regressions) → VERIFIED ────┼──→ END
│    │                                                   │
│    └─ FAIL / REGRESSION → ROLLBACK                     │
│                             ↓                          │
│                           Under limit?                 │
│                             ├─ YES → Loop Back ────────┤
│                             └─ NO  → FAILED ───────────┼──→ END
└────────────────────────────────────────────────────────┘
```

The repair loop is controlled by LangGraph conditional edges (`should_verify_or_rollback` and `check_retry_condition`), not an infinite while-loop.

---

## 14. Verification Testing Engine

Located in `ai-agent/app/graph/nodes/verification.py`:
- **Real Execution**: Verification executes tests strictly through `ExecutionRunner` (`DockerSandboxRunner` in production).
- **Strict Success Criteria**:
  1. Test execution completed with exit code == 0.
  2. All relevant failing tests now pass.
  3. No new failing tests introduced (regression count == 0).
  4. Test output parser (`PytestOutputParser` / `UnittestOutputParser`) confirms 0 failures.
  5. Sandbox execution completed without timeout or resource failure.
- **VerificationResult Schema**:
  ```json
  {
    "status": "PASSED",
    "exit_code": 0,
    "passed": 5,
    "failed": 0,
    "skipped": 0,
    "total": 5,
    "regression_detected": false
  }
  ```

---

## 15. Regression Detection Engine

- Compares baseline test failure signatures (`test_name`, `error_type`, `file`) with post-patch test failures.
- If post-patch failures contain tests not in the baseline set or if failed test count exceeds baseline:
  - `regression_detected` is marked `True`.
  - Attempt status is set to `REGRESSION_DETECTED`.
  - The patch is rolled back immediately.
  - New failure signatures are passed to the next root cause analysis.

---

## 16. Transactional Rollback

Located in `ai-agent/app/patch/applier.py` and `verification.py`:
- `PatchApplier.rollback(backup_id)` restores original file contents from `.fixforge_backups/{backup_id}/`.
- When verification fails or regresses, the repository is automatically rolled back to its known pre-patch state.
- Rollback execution is recorded on the `RepairAttempt` model (`rollbackPerformed = True`).

---

## 17. Attempt Memory & Duplicate Patch Prevention

- **Attempt History**: Each retry includes:
  - Previous hypothesis and root cause.
  - Previous patch diff.
  - Post-patch failure evidence and stderr/stdout.
  - Regressions detected.
- **Duplicate Patch Detection**:
  - Deterministic SHA-256 hash of patch diff.
  - If a generated patch matches any previous attempt's patch hash:
    - Flagged as `DUPLICATE_PATCH_DETECTED`.
    - Prohibits applying the duplicate.
    - Prompts the model for an alternative repair strategy.

---

## 18. Repair Budgets & Human Review Boundaries

- **Configurable Limits**:
  - `MAX_REPAIR_ATTEMPTS` (default: 3)
  - `MAX_REPAIR_TIME` (default: 600s)
  - `MAX_TOTAL_LLM_CALLS` (default: 10)
- **Budget Exceeded**: If any budget is exhausted, loop terminates with `REPAIR_BUDGET_EXCEEDED` or `TIMEOUT`.
- **Human Review Boundary**: If `PatchValidator` flags a patch with `REQUIRES_REVIEW` (e.g. Dockerfile or CI workflow changes), the loop stops immediately with `status = "REQUIRES_REVIEW"` without automatic application.

---

## 19. Persistence & Activity Streaming

- **Prisma `RepairAttempt` Model**:
  - Stores `attemptNumber`, `status`, `failureSummary`, `rootCause`, `patchDiff`, `patchHash`, `rollbackPerformed`, `verificationResult`, `duration`.
- **Live Event Stream**: Emits real-time progression events (`REPAIR_STARTED`, `ROOT_CAUSE_ANALYSIS_STARTED`, `PATCH_GENERATED`, `VERIFICATION_STARTED`, `VERIFICATION_COMPLETED`, `ROLLBACK_COMPLETED`, `REPAIR_VERIFIED`, `REPAIR_FAILED`).
- **REST Endpoints**:
  - `POST /api/repairs/:repairId/repair`
  - `GET /api/repairs/:repairId/attempts`
  - `GET /api/repairs/:repairId/events`
  - `POST /api/repairs/:repairId/verify`

---

## 20. Milestone 6: GitHub Integration & Pull Request Workflow

Milestone 6 builds directly on top of the verified autonomous repair engine, enabling VERIFIED repairs to safely publish branches and Pull Requests to GitHub.

```text
FixForge Repair
      ↓
Verification (Tests Pass: 100%)
      ↓
🎯 Status: VERIFIED
      ↓
Git Provider Abstraction (GitProvider / GitHubProvider / MockGitProvider)
      ↓
Create Fix Branch (fixfixforge/repair-<id>)
      ├── Default Branch Protection (main / master cannot be committed directly)
      ↓
Commit Verified Changes
      ├── Unrelated Change Protection (stages only repair-owned files)
      ├── Structured Commit Message
      ↓
Push Branch to Remote
      ├── Network Failure Isolation (failure leaves COMMITTED state, retryable)
      ↓
Create GitHub Pull Request
      ├── Professional PR Title & Summary
      ├── Full Verification Evidence Attached (baseline vs final, attempt counts)
      ↓
👤 Human Review Boundary
      └── Status: "Awaiting Human Review" (Automatic merge strictly forbidden)
```

### Components
1. **`GitProvider` Abstraction**: Abstract interface decoupling FixForge from specific Git hosts (future extensible to GitLab, Bitbucket).
2. **`GitHubProvider`**: Official GitHub REST API implementation with sanitized error handling and rate-limit backoff.
3. **`LocalGitService`**: Subprocess-safe Git execution using argument arrays (`child_process.execFile`) preventing shell injection.
4. **`GitHubWorkflowService`**: End-to-end orchestrator enforcing verified-only checks, idempotency, default branch protection, and audit logging.