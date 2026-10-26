import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { prisma, seedDatabase } from "@workspace/db";
import { enableTestAuthMock } from "../src/middlewares/auth.js";

describe("FixForge Node API Server", () => {
  let server;
  let baseUrl;

  before(async () => {
    enableTestAuthMock(true);
    await seedDatabase();
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    enableTestAuthMock(false);
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  async function getValidRepairId() {
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    const validProject = projects.find((p) => p.name === "Buggy Python Demo" || p.repository === "examples/buggy-python-project") || projects[0];
    const repairs = await (await fetch(`${baseUrl}/api/repairs`)).json();
    const validRepair = repairs.find((r) => r.projectId === validProject?.id);
    return validRepair ? validRepair.id : repairs[0].id;
  }

  it("GET /api/healthz returns status ok", async () => {
    const res = await fetch(`${baseUrl}/api/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
  });

  it("GET /api/services/health returns service health information", async () => {
    const res = await fetch(`${baseUrl}/api/services/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(["operational", "degraded"].includes(body.status));
    assert.equal(body.services.length, 3);
  });

  it("GET /api/dashboard/summary returns summary stats", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/summary`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.activeRepairs, "number");
    assert.equal(typeof body.completedRepairs, "number");
    assert.equal(typeof body.failedRepairs, "number");
    assert.equal(typeof body.successRate, "number");
  });

  it("GET /api/activity returns recent events", async () => {
    const res = await fetch(`${baseUrl}/api/activity?limit=5`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 1);
  });

  it("GET /api/projects returns seeded project", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 1);
    assert.equal(body[0].language.toLowerCase(), "python");
  });

  it("POST /api/projects creates a new project", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Project",
        repository: "examples/buggy-python-project",
        language: "Python",
        testFramework: "pytest",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, "Test Project");
    assert.equal(body.status, "ready");
    assert.ok(body.id);
  });

  it("GET /api/repairs returns seeded repair job", async () => {
    const res = await fetch(`${baseUrl}/api/repairs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 1);
    assert.ok(body.some((r) => r.issue.includes("calculator")));
  });

  it("POST /api/repairs queues a new repair job", async () => {
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    const projectId = projects[0].id;

    const res = await fetch(`${baseUrl}/api/repairs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        issue: "Regression test failure in calculator.py",
        model: "default",
        verificationLevel: "standard",
        maxIterations: 5,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, "queued");
    assert.equal(body.projectId, projectId);
  });

  it("GET /api/repairs/:repairId returns repair details", async () => {
    const repairs = await (await fetch(`${baseUrl}/api/repairs`)).json();
    const repairId = repairs[0].id;

    const res = await fetch(`${baseUrl}/api/repairs/${repairId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, repairId);
    assert.ok(body.issue);
  });

  it("POST /api/repairs/:repairId/analyze returns 404 for unknown repair", async () => {
    const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/analyze`, {
      method: "POST",
    });
    assert.equal(res.status, 404);
  });

  it("POST /api/repairs/:repairId/analyze handles AI service offline gracefully", async () => {
    const repairId = await getValidRepairId();

    // Use a port where AI service is not listening
    const origUrl = process.env.AI_SERVICE_URL;
    process.env.AI_SERVICE_URL = "http://127.0.0.1:59999";
    try {
      const res = await fetch(`${baseUrl}/api/repairs/${repairId}/analyze`, {
        method: "POST",
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.ok(body.error.includes("AI service error"));

      // Verify the repair status was updated without crashing
      const checkRes = await fetch(`${baseUrl}/api/repairs/${repairId}`);
      const updated = await checkRes.json();
      assert.equal(updated.status, "failed");
    } finally {
      process.env.AI_SERVICE_URL = origUrl;
    }
  });

  it("GET /api/sandbox/health returns sandbox health status", async () => {
    const res = await fetch(`${baseUrl}/api/sandbox/health`);
    assert.ok([200, 503].includes(res.status));
    const body = await res.json();
    assert.equal(typeof body.docker_available, "boolean");
    assert.ok(body.runner);
  });

  it("POST /api/repairs/:repairId/sandbox/run returns 404 for unknown repair", async () => {
    const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/sandbox/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pytest" }),
    });
    assert.equal(res.status, 404);
  });

  it("GET /api/repairs/:repairId/sandbox/runs returns array of sandbox runs", async () => {
    const repairs = await (await fetch(`${baseUrl}/api/repairs`)).json();
    const repairId = repairs[0].id;

    const res = await fetch(`${baseUrl}/api/repairs/${repairId}/sandbox/runs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("POST /api/repairs/:repairId/sandbox/run handles AI service offline gracefully", async () => {
    const repairId = await getValidRepairId();

    const origUrl = process.env.AI_SERVICE_URL;
    process.env.AI_SERVICE_URL = "http://127.0.0.1:59999";
    try {
      const res = await fetch(`${baseUrl}/api/repairs/${repairId}/sandbox/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pytest" }),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.ok(body.error.includes("Sandbox execution failed") || body.error.includes("AI service"));
    } finally {
      process.env.AI_SERVICE_URL = origUrl;
    }
  });

  it("POST /api/repairs/:repairId/root-cause returns 404 for unknown repair", async () => {
    const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/root-cause`, {
      method: "POST",
    });
    assert.equal(res.status, 404);
  });

  it("POST /api/repairs/:repairId/patch returns 404 for unknown repair", async () => {
    const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/patch`, {
      method: "POST",
    });
    assert.equal(res.status, 404);
  });

  it("POST /api/repairs/:repairId/apply-patch returns 404 for unknown repair", async () => {
    const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/apply-patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diff: "mock" }),
    });
    assert.equal(res.status, 404);
  });

  it("GET /api/repairs/:repairId/patch returns 404 when no patch exists yet", async () => {
    const repairs = await (await fetch(`${baseUrl}/api/repairs`)).json();
    const repairId = repairs[0].id;

    const res = await fetch(`${baseUrl}/api/repairs/${repairId}/patch`);
    assert.ok([200, 404].includes(res.status));
  });

  it("POST /api/repairs/:repairId/root-cause handles AI service offline gracefully", async () => {
    const repairId = await getValidRepairId();

    const origUrl = process.env.AI_SERVICE_URL;
    process.env.AI_SERVICE_URL = "http://127.0.0.1:59999";
    try {
      const res = await fetch(`${baseUrl}/api/repairs/${repairId}/root-cause`, {
        method: "POST",
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.ok(body.error.includes("failed"));
    } finally {
      process.env.AI_SERVICE_URL = origUrl;
    }
  });
  it("POST /api/repairs/:repairId/repair returns 404 for unknown repair", async () => {
    const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxAttempts: 3 }),
    });
    assert.equal(res.status, 404);
  });

  it("GET /api/repairs/:repairId/attempts returns array of attempts", async () => {
    const repairs = await (await fetch(`${baseUrl}/api/repairs`)).json();
    const repairId = repairs[0].id;

    const res = await fetch(`${baseUrl}/api/repairs/${repairId}/attempts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/repairs/:repairId/events returns array of activity events", async () => {
    const repairs = await (await fetch(`${baseUrl}/api/repairs`)).json();
    const repairId = repairs[0].id;

    const res = await fetch(`${baseUrl}/api/repairs/${repairId}/events`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("POST /api/repairs/:repairId/verify returns 404 for unknown repair", async () => {
    const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/verify`, {
      method: "POST",
    });
    assert.equal(res.status, 404);
  });

  it("POST /api/repairs/:repairId/verify handles AI service offline gracefully", async () => {
    const repairId = await getValidRepairId();

    const origUrl = process.env.AI_SERVICE_URL;
    process.env.AI_SERVICE_URL = "http://127.0.0.1:59999";
    try {
      const res = await fetch(`${baseUrl}/api/repairs/${repairId}/verify`, {
        method: "POST",
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.ok(body.error.includes("failed"));
    } finally {
      process.env.AI_SERVICE_URL = origUrl;
    }
  });

  it("POST /api/repairs/:repairId/repair handles AI service offline gracefully", async () => {
    const repairId = await getValidRepairId();

    const origUrl = process.env.AI_SERVICE_URL;
    process.env.AI_SERVICE_URL = "http://127.0.0.1:59999";
    try {
      const res = await fetch(`${baseUrl}/api/repairs/${repairId}/repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxAttempts: 3 }),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.ok(body.error.includes("failed"));
    } finally {
      process.env.AI_SERVICE_URL = origUrl;
    }
  });

  it("POST /api/repairs/:repairId/repair completes without totalRepairDurationMs ReferenceError when AI service responds", async () => {
    const repairId = await getValidRepairId();
    let mockAiServer;
    const mockAiPort = await new Promise((resolve) => {
      mockAiServer = http.createServer((req, res) => {
        if (req.url === "/agent/self-correction" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            job_id: repairId,
            status: "FAILED",
            is_verified: false,
            attempt_count: 1,
            final_status: "FAILED",
            attempt_history: [],
            agent_events: [],
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockAiServer.listen(0, "127.0.0.1", () => {
        resolve(mockAiServer.address().port);
      });
    });

    const origUrl = process.env.AI_SERVICE_URL;
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${mockAiPort}`;
    try {
      const res = await fetch(`${baseUrl}/api/repairs/${repairId}/repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxAttempts: 1 }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.job_id, repairId);
      assert.equal(body.status, "failed");
      assert.equal(body.is_verified, false);
      assert.ok(typeof body.repair === "object");
    } finally {
      process.env.AI_SERVICE_URL = origUrl;
      await new Promise((resolve) => mockAiServer.close(resolve));
    }
  });
});
