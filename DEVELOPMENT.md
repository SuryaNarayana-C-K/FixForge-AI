# FixForge Development

## 1. Principles

- Implement milestone by milestone.
- Inspect before editing.
- Keep OpenAPI, generated clients, and server handlers in sync.
- Do not claim a repair is verified without test evidence.
- Untrusted repository code must never execute on the host in production.
- Keep the agent loop bounded by iteration, model-call, output, repository-size, file-size, and duration limits.

---

## 2. Docker Sandbox Setup

FixForge uses a lightweight, hardened Docker image for repository testing:

### Building the Sandbox Image
From the repository root:
```bash
docker build -t fixforge-sandbox:latest -f sandbox/Dockerfile .
```
or on Linux/macOS:
```bash
chmod +x sandbox/scripts/build.sh
./sandbox/scripts/build.sh
```

### Environment Variables
Configure sandbox execution parameters in `ai-agent/.env` or shell:
- `EXECUTION_MODE`: `docker` (default for production) or `local` (development fallback).
- `SANDBOX_TIMEOUT`: Maximum execution time in seconds (default: `120`).
- `SANDBOX_MEMORY`: Container memory limit (default: `512m`).
- `SANDBOX_CPUS`: Container CPU limit (default: `1`).
- `SANDBOX_PIDS_LIMIT`: Max processes per container (default: `128`).
- `SANDBOX_OUTPUT_LIMIT`: Max output capture bytes (default: `5242880` / 5MB).
- `SANDBOX_IMAGE`: Image tag to run (default: `fixforge-sandbox:latest`).

### Docker Troubleshooting
1. **Docker CLI not found / Daemon not running**:
   - `GET /sandbox/health` returns `docker_available: false`.
   - If running locally without Docker, set `EXECUTION_MODE=local` for development and demo testing.
2. **Permission denied mounting volume**:
   - Ensure the repository workspace directory is accessible by the Docker daemon.
   - The container runs as non-root UID 1000 (`sandboxuser`).

---

## 3. Running Checks and Tests

### 1. Python AI Agent Tests (Unit, Security, Lifecycle, Runner, Context, Patching, Self-Correction)
```bash
cd ai-agent
py -m pytest tests -v
```
All 78 tests covering workspace traversal, sandbox configuration, security sanitization, output truncation, container lifecycle, Docker runner arguments, context selection, root-cause schemas, provider abstraction, patch validation, transactional patch applier, multi-attempt self-correction, regression rollback, duplicate patch suppression, and LangGraph integration must pass.

### 2. Backend API Server Tests
```bash
npm --workspace=@workspace/api-server run test
```
All tests covering health, projects, repairs, sandbox run, root cause, patch, autonomous repair loop, attempt history, and verify endpoints must pass.

### 3. Frontend Production Build
```bash
npm --workspace=@workspace/fixforge run build
```

### 4. Database Schema Sync
```bash
npm --workspace=@workspace/db run db:generate
npm --workspace=@workspace/db run db:push
```

---

## 4. LLM Provider Configuration & Scenarios

FixForge uses a provider abstraction (`ai-agent/app/providers/`):

### Offline / CI Deterministic Scenarios (Default)
In CI and unit test environments, no external API key is required:
```bash
export LLM_PROVIDER=mock
```
The deterministic `MockLLMProvider` supports simulated self-correction scenarios via `MOCK_SCENARIO`:
- `two_attempts_success`: Attempt 1 fails verification; Attempt 2 receives feedback and succeeds.
- `regression`: Generated patch introduces regression, triggering automatic rollback.
- `all_fail`: All 3 attempts fail; halts at max attempts.
- `duplicate`: Second attempt generates identical patch, caught by duplicate patch detector.
- `requires_review`: Generates patch touching protected files (Dockerfile), halting for human review.

### Real Model Integration
To use live LLMs (e.g. OpenAI, DeepSeek, Ollama, Nvidia NIM):
```bash
export LLM_PROVIDER=openai
export LLM_MODEL=gpt-4o-mini  # or deepseek-coder, llama3, etc.
export LLM_API_KEY=your_api_key_here
export LLM_BASE_URL=https://api.openai.com/v1  # or your custom endpoint
```

---

## 5. Next Milestone

**MILESTONE 6 — GITHUB INTEGRATION & VERIFICATION REPORTS**
- Automatic GitHub branch creation, commits, and pull requests.
- Human review and pull request approval workflows.
- Comprehensive verification reports for pull request descriptions.