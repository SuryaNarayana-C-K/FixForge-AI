# FixForge API

The API is served by the Node/Express service under the `/api` prefix and by the Python AI service under its own port.

---

## Node / Express API (`http://localhost:5000/api`)

### Health
- `GET /api/healthz` — Node API liveness.
- `GET /api/services/health` — Node API, SQLite, and AI service status.
- `GET /api/sandbox/health` — Sandbox health status (checks Docker availability and active runner mode).

#### Sandbox Health Response (`GET /api/sandbox/health`)
```json
{
  "docker_available": true,
  "runner": "docker",
  "version": "Docker version 27.0.3, build 7d4bed8",
  "error": null
}
```

### Dashboard
- `GET /api/dashboard/summary` — active, completed, failed, success rate, and iteration metrics.
- `GET /api/activity?limit=8` — recent repair activity events.

### Projects
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`

### Repairs
- `GET /api/repairs`
- `POST /api/repairs`
- `GET /api/repairs/:repairId` — Returns repair job including associated `sandboxRuns` and `patches`.
- `POST /api/repairs/:repairId/analyze` — Run repository structure analysis and baseline testing workflow.
- `POST /api/repairs/:repairId/sandbox/run` — Execute a command in the sandbox for the repair job.
- `GET /api/repairs/:repairId/sandbox/runs` — Fetch sandbox execution history for the repair job.
- `POST /api/repairs/:repairId/root-cause` — Trigger AI root cause analysis and context selection.
- `POST /api/repairs/:repairId/patch` — Generate patch plan and unified diff from root cause analysis.
- `GET /api/repairs/:repairId/patch` — Retrieve the latest generated patch and validation record.
- `POST /api/repairs/:repairId/repair` — Trigger autonomous multi-attempt self-correction loop (max attempts, test verification, rollback, duplicate prevention).
- `GET /api/repairs/:repairId/attempts` — Fetch full repair attempt history with diffs, verification outputs, and rollback indicators.
- `GET /api/repairs/:repairId/events` — Stream activity events for the repair job.
- `POST /api/repairs/:repairId/verify` — Run on-demand test verification against current repository state in sandbox.

#### Autonomous Repair Request (`POST /api/repairs/:repairId/repair`)
```json
{
  "maxAttempts": 3
}
```

#### Autonomous Repair Response (`POST /api/repairs/:repairId/repair`)
```json
{
  "job_id": "9b8e8a50-a7ab-4f8a-984f-545f9b685276",
  "status": "verified",
  "is_verified": true,
  "attempt_count": 2,
  "final_status": "VERIFIED",
  "attempt_history": [
    {
      "attempt": 1,
      "result": "FAILED",
      "rollback_performed": true,
      "failures": [{"test_name": "test_divide_by_zero_is_safe"}]
    },
    {
      "attempt": 2,
      "result": "VERIFIED",
      "rollback_performed": false,
      "failures": []
    }
  ],
  "verification_result": {
    "status": "PASSED",
    "passed": 5,
    "failed": 0,
    "total": 5,
    "exit_code": 0,
    "regression_detected": false
  }
}
```

#### Run in Sandbox Request (`POST /api/repairs/:repairId/sandbox/run`)
```json
{
  "command": "pytest"
}
```

#### Run in Sandbox Response (`POST /api/repairs/:repairId/sandbox/run`)
```json
{
  "id": "c1f77d34-77bf-4e9e-bb44-6725287e0ce3",
  "repairJobId": "9b8e8a50-a7ab-4f8a-984f-545f9b685276",
  "command": "pytest",
  "status": "completed",
  "exitCode": 0,
  "stdout": "============================= test session starts =============================\n...",
  "stderr": "",
  "duration": 2.31,
  "timedOut": false,
  "sandboxed": true,
  "containerId": "fixforge-sandbox-9b8e8a50-a7ab-4f8a-984f-545f9b685276-c1f77d34",
  "createdAt": "2026-09-29T11:45:00.000Z"
}
```

---

## AI Service (FastAPI — `http://localhost:8000`)

- `GET /health` — AI service status.
- `GET /sandbox/health` — Checks Docker CLI availability, Docker version, and active runner mode.
- `POST /agent/analyze` — Execute LangGraph repository analysis and baseline testing workflow.
- `POST /sandbox/run` — Direct sandbox execution endpoint.

#### Sandbox Run Request (`POST /sandbox/run`)
```json
{
  "job_id": "repair-job-uuid",
  "repository_path": "examples/buggy-python-project",
  "command": "pytest",
  "timeout": 120
}
```

#### Sandbox Run Response (`POST /sandbox/run`)
```json
{
  "status": "completed",
  "command": "pytest",
  "exit_code": 0,
  "stdout": "============================= test session starts =============================\n...",
  "stderr": "",
  "duration": 2.31,
  "timed_out": false,
  "sandboxed": true,
  "container_id": "fixforge-sandbox-repair-job-uuid-c1f77d34"
}
```

For timeout:
```json
{
  "status": "timeout",
  "command": "pytest",
  "exit_code": null,
  "stdout": "",
  "stderr": "Execution timed out after 120.0 seconds",
  "duration": 120.0,
  "timed_out": true,
  "sandboxed": true,
  "container_id": "fixforge-sandbox-..."
}
```

### Milestone 4 AI Agent Endpoints
- `POST /agent/root-cause` — Runs context selection and root-cause analysis on detected failures.
- `POST /agent/plan` — Generates a minimal patch plan given root-cause analysis.
- `POST /agent/patch` — Generates a unified diff adhering to the minimal patch principle and structurally validates it.
- `POST /agent/apply-patch` — Validates and applies a unified diff safely with pre-flight backup snapshot and rollback on error.
- `POST /agent/repair-workflow` — Runs the complete Milestone 4 repair graph (`INIT` through `PATCH_VALIDATION` or optional application).

### Milestone 5 AI Agent Endpoints
- `POST /agent/self-correction` — Executes the complete multi-attempt LangGraph self-correction loop with verification, regression detection, rollback, attempt memory, and budget controls.
- `POST /agent/verify` — Executes on-demand test verification in the execution runner and returns structured `VerificationResult`.

---

## Milestone 6: GitHub Integration Endpoints

### 1. Create Pull Request (`POST /api/repairs/:repairId/github/pr`)
Executes the verified-only GitHub workflow: creates an isolated repair branch, stages only repair-owned files, creates a structured commit, pushes to remote, and creates a GitHub Pull Request awaiting human review.

#### Request Body
```json
{
  "createBranch": true,
  "createCommit": true,
  "createPullRequest": true,
  "owner": "optional-override-owner",
  "repository": "optional-override-repo",
  "defaultBranch": "main"
}
```

#### Success Response (`200 OK`)
```json
{
  "id": "c3e98124-7b64-4e92-96ab-23490fd38ea1",
  "repairJobId": "5b1c4152-ad12-417e-99dc-9126c7da4c9d",
  "provider": "github",
  "owner": "example-org",
  "repository": "calculator-demo",
  "defaultBranch": "main",
  "repairBranch": "fixfixforge/repair-5b1c4152",
  "commitSha": "e4f8d21b7a9042b589c314051a8f9cd3e5621a0f",
  "commitMessage": "Fix: handle divide-by-zero safely\n\nFixForge repair: 5b1c4152...",
  "pullRequestNumber": 42,
  "pullRequestUrl": "https://github.com/example-org/calculator-demo/pull/42",
  "status": "PR_CREATED",
  "error": null,
  "createdAt": "2026-10-07T04:20:00.000Z",
  "updatedAt": "2026-10-07T04:20:05.000Z"
}
```

#### Error Codes
- `400 UNVERIFIED_REPAIR_BLOCKED`: The repair is not `verified`. Only `verified` repairs may proceed to Git/GitHub operations.
- `400 GITHUB_REPOSITORY_NOT_CONFIGURED`: Neither the project nor the request provides valid GitHub `owner` and `repository`.
- `400 GIT_IDENTITY_NOT_CONFIGURED`: Git `user.name` or `user.email` is not configured on the local system.
- `400 DEFAULT_BRANCH_PROTECTION`: Attempted to commit directly to the default branch (`main`/`master`).
- `401 GITHUB_AUTH_FAILED`: Invalid or expired `GITHUB_TOKEN`.
- `429 GITHUB_RATE_LIMITED`: GitHub API rate limit reached.

#### Idempotency
Calling this endpoint multiple times for the same repair returns the existing `GitHubIntegration` record without duplicate branches, commits, or pull requests.

---

### 2. Get GitHub Integration Status (`GET /api/repairs/:repairId/github`)
Retrieves current GitHub publication status, branch, commit, PR metadata, and event history for a repair.

#### Response (`200 OK`)
```json
{
  "configured": true,
  "owner": "example-org",
  "repository": "calculator-demo",
  "defaultBranch": "main",
  "integration": {
    "repairBranch": "fixfixforge/repair-5b1c4152",
    "commitSha": "e4f8d21b",
    "pullRequestNumber": 42,
    "pullRequestUrl": "https://github.com/example-org/calculator-demo/pull/42",
    "status": "PR_CREATED"
  },
  "history": [...]
}
```

---

### 3. Get Verification Report (`GET /api/repairs/:repairId/github/report`)
Generates comprehensive human-readable Markdown and structured metadata summarizing diagnosis, changes, baseline vs final verification evidence, and attempt counts.