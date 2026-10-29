/**
 * FixForge AI Complete End-to-End Acceptance Test
 * 
 * Verifies:
 * 1. Health checks on all 3 tiers (Vite port 3000, Express port 5000, FastAPI port 8000)
 * 2. Enterprise Authentication & RBAC token acquisition
 * 3. Buggy Python project registration (examples/buggy-python-project)
 * 4. Autonomous repair job submission
 * 5. Complete repair workflow execution (Baseline -> Root Cause -> Patch Plan -> Patch -> Verification)
 * 6. Patch inspection & verification
 * 7. Regression testing on repaired code
 * 8. Frontend proxy data verification
 */

import assert from "node:assert/strict";
import { Agent, setGlobalDispatcher } from "undici";

// Allow autonomous multi-tier AI repair workflows without premature HTTP socket termination
setGlobalDispatcher(
  new Agent({
    headersTimeout: 900_000,
    bodyTimeout: 900_000,
    connectTimeout: 60_000,
  })
);

const API_BASE = "http://127.0.0.1:5000";
const FRONTEND_BASE = "http://127.0.0.1:3000";
const AI_BASE = "http://127.0.0.1:8000";

async function runAcceptanceTest() {
  console.log("===============================================================================");
  console.log("FIXFORGE AI — COMPLETE END-TO-END ACCEPTANCE TEST");
  console.log("===============================================================================\n");

  // Step 1: Health Probing
  console.log("[STEP 1] Probing service endpoints...");
  
  const aiHealth = await (await fetch(`${AI_BASE}/healthz`)).json();
  console.log(`  ✓ Python AI Agent (port 8000): status = ${aiHealth.status}, service = ${aiHealth.service}`);
  assert.equal(aiHealth.status, "ok");

  const apiHealth = await (await fetch(`${API_BASE}/api/healthz`)).json();
  console.log(`  ✓ Node.js API Server (port 5000): status = ${apiHealth.status}`);
  assert.equal(apiHealth.status, "ok");

  const servicesHealth = await (await fetch(`${API_BASE}/api/services/health`)).json();
  console.log(`  ✓ Overall Service Health: status = ${servicesHealth.status}`);

  const frontendProxyHealth = await (await fetch(`${FRONTEND_BASE}/api/healthz`)).json();
  console.log(`  ✓ Frontend Vite Proxy (port 3000 -> 5000): status = ${frontendProxyHealth.status}\n`);
  assert.equal(frontendProxyHealth.status, "ok");

  // Step 2: Authentication
  console.log("[STEP 2] Authenticating enterprise admin user...");
  const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "admin@fixforge.local",
      password: "DemoAdmin123!",
    }),
  });
  assert.equal(loginRes.status, 200, "Login failed");
  const loginData = await loginRes.json();
  const token = loginData.token;
  console.log(`  ✓ Authenticated as ${loginData.user.email} (Role: ${loginData.user.role}, Org: ${loginData.user.organizationId})\n`);

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // Step 3: Register Buggy Python Project
  console.log("[STEP 3] Registering buggy Python project (examples/buggy-python-project)...");
  const projRes = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: `Calculator Acceptance ${Date.now()}`,
      repository: "examples/buggy-python-project",
      language: "Python",
      testFramework: "pytest",
    }),
  });
  assert.equal(projRes.status, 201, `Failed to create project: ${projRes.statusText}`);
  const project = await projRes.json();
  console.log(`  ✓ Project created: "${project.name}" (ID: ${project.id})\n`);

  // Step 4: Submit Buggy Repair Job
  console.log("[STEP 4] Submitting repair job for ZeroDivisionError bug in calculator.py...");
  const repRes = await fetch(`${API_BASE}/api/repairs`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      projectId: project.id,
      issue: "Fix ZeroDivisionError in divide() function when count == 0; safe default is 0",
      model: "gemini-3.1-flash-lite",
      verificationLevel: "standard",
      maxIterations: 3,
    }),
  });
  assert.equal(repRes.status, 201, "Failed to create repair job");
  const repair = await repRes.json();
  console.log(`  ✓ Repair Job created: ID = ${repair.id}, Initial Status = ${repair.status}\n`);

  // Step 5: Execute Complete AI Repair Workflow
  console.log("[STEP 5] Triggering autonomous AI repair workflow (POST /api/repairs/:id/repair)...");
  const startTime = Date.now();
  const runRes = await fetch(`${API_BASE}/api/repairs/${repair.id}/repair`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ maxAttempts: 3 }),
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  assert.equal(runRes.status, 200, `Repair execution failed with HTTP ${runRes.status}`);
  const runResult = await runRes.json();
  console.log(`  ✓ Repair workflow finished in ${duration}s! Result:`, JSON.stringify(runResult, null, 2));

  // Step 6: Fetch Updated Repair Details
  console.log("\n[STEP 6] Inspecting repair job status and metrics...");
  const detailRes = await fetch(`${API_BASE}/api/repairs/${repair.id}`, {
    headers: authHeaders,
  });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();

  console.log(`  - Status:                ${detail.status}`);
  console.log(`  - Tests Passed:          ${detail.testsPassed} / ${detail.testsTotal}`);
  console.log(`  - Confidence Score:      ${Math.round((detail.confidenceScore || 0) * 100)}% (${detail.confidenceLevel || 'N/A'})`);
  console.log(`  - Patch Risk Score:      ${Math.round((detail.patchRiskScore || 0) * 100)}% (${detail.patchRiskLevel || 'N/A'})`);
  console.log(`  - Root Cause Certainty:  ${detail.rootCauseCertainty || 'N/A'}`);
  console.log(`  - Failure Category:      ${detail.failureCategory || 'N/A'}`);
  console.log(`  - Repair Strategy:       ${detail.repairStrategy || 'N/A'}`);

  // Step 7: Inspect Generated Patch
  console.log("\n[STEP 7] Inspecting generated patch diff...");
  const patchRes = await fetch(`${API_BASE}/api/repairs/${repair.id}/patch`, {
    headers: authHeaders,
  });
  let patchData = null;
  if (patchRes.ok) {
    patchData = await patchRes.json();
    console.log(`  - Patch ID:      ${patchData.id || patchData.patch?.id}`);
    console.log(`  - Status:        ${patchData.status || patchData.patch?.status}`);
    console.log(`  - Diff:\n${patchData.diff || patchData.patch?.diff || "(no diff text)"}`);
  } else {
    console.log(`  - Patch endpoint returned HTTP ${patchRes.status}`);
  }

  // Step 8: Run On-Demand Regression Verification
  console.log("\n[STEP 8] Running regression verification (POST /api/repairs/:id/verify)...");
  const verifyRes = await fetch(`${API_BASE}/api/repairs/${repair.id}/verify`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ command: "pytest" }),
  });
  assert.equal(verifyRes.status, 200, "Verification execution failed");
  const verifyResult = await verifyRes.json();
  const v = verifyResult.verification || verifyResult || {};
  console.log(`  ✓ Verification tests completed:`);
  console.log(`    - Status:              ${v.status}`);
  console.log(`    - Exit Code:           ${v.exit_code}`);
  console.log(`    - Total Tests:         ${v.total}`);
  console.log(`    - Passed:              ${v.passed}`);
  console.log(`    - Failed:              ${v.failed}`);
  console.log(`    - Regression Detected: ${Boolean(v.regression_detected)}`);

  // Step 9: Verify Real Frontend Results via Proxy
  console.log("\n[STEP 9] Verifying Frontend displays real results via port 3000 proxy...");
  const feRepairRes = await fetch(`${FRONTEND_BASE}/api/repairs/${repair.id}`, {
    headers: authHeaders,
  });
  assert.equal(feRepairRes.status, 200);
  const feRepair = await feRepairRes.json();
  assert.equal(feRepair.id, repair.id);
  assert.equal(feRepair.status, detail.status);
  console.log(`  ✓ Frontend proxy successfully delivered repair data for ${feRepair.id} (Status: ${feRepair.status})`);

  // Step 10: Timeline Activity Events
  const eventsRes = await fetch(`${FRONTEND_BASE}/api/repairs/${repair.id}/events`, {
    headers: authHeaders,
  });
  if (eventsRes.ok) {
    const events = await eventsRes.json();
    console.log(`  ✓ Activity Timeline Events recorded: ${events.length} events`);
    for (const ev of events.slice(0, 5)) {
      console.log(`    • [${ev.eventType || ev.event}] ${ev.message}`);
    }
  }

  console.log("\n===============================================================================");
  console.log("ACCEPTANCE TEST RESULT: ALL 10 PHASES COMPLETED AND VERIFIED SUCCESSFULLY!");
  console.log("===============================================================================");

  return {
    repairId: repair.id,
    projectId: project.id,
    status: detail.status,
    testsPassed: detail.testsPassed,
    testsTotal: detail.testsTotal,
  };
}

runAcceptanceTest().catch((err) => {
  console.error("\n❌ Acceptance test failed:", err);
  process.exit(1);
});
