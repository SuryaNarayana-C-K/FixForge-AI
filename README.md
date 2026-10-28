# FixForge AI

FixForge is an autonomous, verification-centric software repair platform designed around a fundamental engineering principle:

> **Generated is not fixed. Executed + tested + verified is fixed.**

Unlike LLM tools that produce unverified patches, FixForge pairs deep code intelligence with isolated execution runtimes. Every proposed fix undergoes static validation, multi-attempt sandboxed test execution, regression analysis, and strict human-in-the-loop governance before any pull request is opened.

---

## Architecture & System Overview

FixForge is structured as a decoupled, multi-service platform:

```
┌────────────────────────────────────────────────────────┐
│               Frontend Control Room                    │
│        (React 19, Vite 7, Tailwind CSS v4)            │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP / JSON
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Node.js API Server                    │
│      (Express 5, Prisma ORM, Enterprise RBAC)          │
│       - Auth, Projects, Repairs, GitHub Workflows      │
│       - Token Redaction, Rate Limiting, Audit Logs     │
└───────────────┬────────────────────────────┬───────────┘
                │                            │
        SQLite Database                      │ HTTP (Service Auth)
      (Isolated Persistent Data)             ▼
                                ┌────────────────────────┐
                                │     AI Repair Agent    │
                                │ (Python / LangGraph)   │
                                └────────────┬───────────┘
                                             │
                                   Execution Runner Boundary
                                             │
                                ┌────────────▼───────────┐
                                │  Docker Sandbox Worker │
                                │  (--network none, UID) │
                                └────────────────────────┘
```

### Component Responsibilities

1. **Frontend Control Room (`artifacts/fixforge/`)**:
   - Modern React/Vite dashboard providing real-time repair job monitoring.
   - Interactive attempt timeline, unified syntax-highlighted diff viewer, root cause analysis inspector, and manual patch approval controls.
2. **Backend API Gateway (`artifacts/api-server/`)**:
   - Express 5 REST API enforcing tenant isolation and role-based permissions (`ADMIN`, `MANAGER`, `DEVELOPER`, `VIEWER`).
   - GitHub integration engine: manages repair branches, stages only repair-owned files, enforces default branch protection, and opens human-approved pull requests.
   - Secret sanitization engine: redacts API keys and access tokens from all error streams and audit logs.
3. **Database Engine (`lib/db/`)**:
   - SQLite backed by Prisma ORM (`dev.db` locally, persistent volume mount at `/data/fixforge.db` in containers).
   - Hot backups via atomic `VACUUM INTO` and tenant migration auditing.
4. **AI Repair Agent (`ai-agent/`)**:
   - Python FastAPI application running a deterministic LangGraph repair state machine:
     `INIT` → `REPOSITORY_ANALYSIS` → `BASELINE_TESTING` → `FAILURE_DETECTION` → `ROOT_CAUSE_ANALYSIS` → `PATCH_PLANNING` → `PATCH_GENERATION` → `PATCH_VALIDATION` → `PATCH_APPLICATION` → `VERIFICATION_TESTING` → (Rollback / Retry / Verified).
   - Pluggable LLM providers (Google Gemini with strict redaction or offline `MockLLMProvider` for deterministic CI).
5. **Sandbox Worker (`sandbox-worker/` & `sandbox/`)**:
   - Ephemeral container runner with execution timeouts, memory limits, network isolation (`--network none`), non-root execution (`sandboxuser`, UID 1000), and guaranteed container cleanup.

---

## Core Features That Genuinely Exist

- **Multi-Attempt Self-Correction Loop**: Bounded repair loop (up to 3 attempts) that rolls back regressive patches, injects previous failure signatures into subsequent prompts, and detects duplicate patches via SHA-256 diff hashing.
- **Multi-Language Test Discovery**: Built-in support for **Python** (`pytest`, `unittest`) and **JavaScript** (`jest`, `vitest`).
- **Human-in-the-Loop PR Governance**: Unverified or regressive patches are strictly blocked from Git operations. Verified patches can be inspected and approved before automated branch creation, commit, and PR submission.
- **Enterprise Security & Audit Logging**: Append-only `AuditLog` table capturing logins, repair operations, PR events, and policy violations with automatic secret masking.
- **Durable Job State Recovery**: Server restarts automatically detect interrupted jobs in running state and mark them for safe recovery or cancellation.
- **Deterministic Offline Evaluation**: Complete offline testing matrix using mock providers and packaged test fixtures without external API costs.

---

## Technology Stack

- **Frontend**: React 19, Vite 7, Tailwind CSS v4, Radix UI, TanStack Query, Lucide React
- **Backend API**: Node.js 20+, Express 5, Prisma ORM, Pino Logger, bcryptjs, jsonwebtoken
- **AI Agent**: Python 3.11+, FastAPI, LangGraph, Pydantic, google-genai
- **Database**: SQLite (Node.js built-in `node:sqlite` runtime & Prisma client)
- **Containerization**: Docker, Docker Compose, ephemeral sandbox containers
- **Package Management**: npm workspaces, uv / pip

---

## Quick Start & Installation

### Prerequisites

- **Node.js**: v20.x or higher
- **npm**: v10.x or higher
- **Python**: v3.11 or higher
- **Docker**: (Optional for local development; required for containerized sandbox execution)

### 1. Clone the Repository

```bash
git clone https://github.com/SuryaNarayana-C-K/FixForge-AI.git
cd FixForge-AI
```

### 2. Environment Configuration

Copy the example environment template:

```bash
cp .env.example .env
```

Key environment variables:
| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | API Server port | `5000` |
| `DATABASE_URL` | SQLite database file location | `file:./dev.db` |
| `JWT_SECRET` | 256-bit secret for user tokens | *(Set a secure string)* |
| `AI_SERVICE_URL` | Endpoint of the Python AI Agent | `http://127.0.0.1:8000` |
| `LLM_PROVIDER` | AI provider (`gemini` or `mock`) | `gemini` |
| `GEMINI_API_KEY` | Google Gemini API key (if using `gemini`) | *(Your API Key)* |
| `EXECUTION_MODE` | Sandbox execution mode (`local` or `docker`) | `local` |
| `GIT_PROVIDER` | Git integration mode (`github` or `mock`) | `mock` |

### 3. Install Dependencies & Initialize Database

```bash
# Install Node dependencies across workspaces
npm install

# Generate Prisma client and create database tables
npm run db:generate
npm run db:push

# Seed the database with initial demonstration projects and users
npm run db:seed
```

---

## Running the Services

### Start All Services Locally

#### Terminal 1 — AI Repair Agent
```bash
cd ai-agent
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

#### Terminal 2 — Node.js API Gateway
```bash
npm --workspace=@workspace/api-server run dev
```

#### Terminal 3 — Frontend Control Room
```bash
npm --workspace=@workspace/fixforge run dev
```

Open your browser at `http://localhost:3000` to access the FixForge Control Room.

---

## Running Tests

FixForge contains extensive, deterministic automated test suites covering all architectural layers.

### 1. API Server & Integration Tests
Runs API routes, GitHub workflow integration, multi-language validation, security RBAC, and error sanitization:
```bash
npm test
# Or specifically:
npm --workspace=@workspace/api-server test
```

### 2. Python AI Agent & Graph Tests
```bash
cd ai-agent
python -m pytest tests/ -v
```

### 3. Frontend Production Build Validation
Validates frontend assets, TypeScript types, and Tailwind v4 bundle compilation:
```bash
npm --workspace=@workspace/fixforge run build
```

### 4. End-to-End Demo Workflow
Executes end-to-end autonomous repair flows against packaged fixtures:
```bash
node scripts/m10-e2e-demo.js
```

---

## Docker & Container Deployment

For staging and production deployments, FixForge provides complete Docker Compose configurations:

### Staging Deployment (Isolated Network)
```bash
cp .env.staging.example .env.staging
docker compose -f docker-compose.staging.yml up -d --build
```

### Private Pilot Deployment (HTTPS + Caddy)
```bash
cp .env.pilot.example .env.pilot
bash scripts/generate-pilot-secrets.sh
docker compose -f docker-compose.pilot.yml up -d --build
```

---

## Security Model & Sandbox Containment

1. **Read-Only Test Suites**: Patches targeting test files (`test_*.py`, `*.test.js`) are rejected by policy to prevent AI agents from "fixing" defects by deleting assertions.
2. **Filesystem Containment**: `WorkspaceManager` blocks directory traversal (`../`) and rejects symlinks that escape repository boundaries.
3. **Network Isolation**: When running in `docker` mode, test execution containers are started with `--network none` to prevent unauthorized egress.
4. **Credential Redaction**: `GitHubProvider` and `classifyAndSanitizeError` enforce automated regex scrubbing on all error strings and logs to redact GitHub tokens (`ghp_*`), Google keys (`AIza*`), and Authorization headers.
5. **Default Branch Safeguard**: Automated repair commits are strictly made to dedicated feature branches (`fixforge/repair-*`); direct commits to default branches (`main`, `master`) are rejected.

---

## Known Limitations

- **Docker in Local Windows Environments**: Running the sandbox in true `docker` mode requires Docker Desktop. For environments without Docker, set `EXECUTION_MODE=local` to execute tests via isolated local subprocesses.
- **GitHub Token Permissions**: Autonomous PR creation requires a GitHub Personal Access Token or GitHub App with repository `Contents: Read and Write` and `Pull Requests: Read and Write` scopes. Set `GIT_PROVIDER=mock` for offline evaluation.
- **LLM Rate Limits**: When using public Gemini API tiers, repair jobs with high retry counts may encounter rate limits; FixForge automatically captures HTTP 429 status codes and presents clear retry advice in the UI.

---

## License

This project is licensed under the MIT License.