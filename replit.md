# FixForge

FixForge is an autonomous software repair platform foundation that records repair jobs, exposes execution evidence, and will grow into a bounded self-correcting agent loop.

## Run & Operate

- `artifacts/fixforge: web` — React/Vite frontend at `/`
- `artifacts/api-server: API Server` — Node/Express API under `/api`
- `FixForge AI Agent` — FastAPI internal service on port 8000
- `npm --workspace=@workspace/scripts run typecheck` — full TypeScript check
- `npm --workspace=@workspace/api-server start` — API server start
- `npm --workspace=@workspace/api-spec run codegen` — regenerate API hooks and Zod schemas
- `PYTHONPATH=ai-agent python -m compileall -q ai-agent` — Python syntax check

## Stack

- npm workspace, Node.js 24, TypeScript 5.9
- Frontend: React, Vite, Tailwind CSS, Wouter, TanStack React Query
- API: Express 5, JavaScript/TypeScript source, generated Zod validation
- Database: SQLite via Node 24 `node:sqlite`, stored at `database/dev.db`
- AI service: Python 3.13, FastAPI, Pydantic, LangGraph dependency
- API contracts: OpenAPI + Orval

## Where things live

- `artifacts/fixforge/` — user-facing web app
- `artifacts/api-server/` — shared Node API
- `lib/api-spec/openapi.yaml` — API source of truth
- `lib/api-client-react/` — generated React Query client
- `lib/api-zod/` — generated request/response schemas
- `lib/db/` — SQLite initialization, schema, and query handles
- `ai-agent/` — Python agent service boundary
- `docs` and top-level markdown files — architecture, security, API, and development notes

## Architecture decisions

- Keep the Node API independent from LangGraph internals; communicate with the Python service over HTTP.
- Treat generated code as the API contract boundary; server routes validate both input and output.
- Use SQLite for the local-first milestone, matching the product specification instead of silently adopting the scaffold's original database choice.
- Seed only one small demo project and repair job so the dashboard is demonstrable without implying the repair engine is complete.

## Product

Milestone 1 provides service health, project records, repair-job records, dashboard metrics, and activity. The repair engine, Docker sandbox, live WebSocket timeline, and authentication are intentionally later milestones.

## User preferences

None recorded.

## Gotchas

- After changing `lib/api-spec/openapi.yaml`, run codegen before using new hooks or schemas.
- The first SQLite connection initializes the local schema and seeds the demo data when empty.
- `VERIFIED` must only be emitted after actual sandbox execution evidence is implemented.

## Pointers

- See `package.json` for npm workspace conventions.
- See `README.md` for the Milestone 1 scope.