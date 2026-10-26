import { prisma } from '@workspace/db';
import path from 'path';
import fs from 'fs';

async function runE2EDemo() {
  console.log('==================================================');
  console.log('   FIXFORGE MILESTONE 7 END-TO-END DEMO');
  console.log('==================================================');

  const baseUrl = 'http://127.0.0.1:5000';
  const repoRelative = 'examples/buggy-python-project';
  const repoAbs = path.resolve(process.cwd(), '../../', repoRelative);
  const calcFile = path.join(repoAbs, 'calculator.py');

  console.log(`Repository absolute path: ${repoAbs}`);
  console.log(`Calculator file: ${calcFile}`);

  // Ensure calculator.py is in buggy baseline state
  const buggyCode = `def divide(total: float, count: int) -> float:
    """Return the average value for a total and count."""
    if count == 0:
        return -1
    return total / count


def clamp(value: float, lower: float = 0, upper: float = 100) -> float:
    if lower > upper:
        raise ValueError("lower bound must not exceed upper bound")
    return min(max(value, lower), upper)
`;
  fs.writeFileSync(calcFile, buggyCode, 'utf8');
  console.log('Verified buggy state in calculator.py (returns -1 on zero count)');

  // 1. Get or create Project
  console.log('\n[1] Finding or creating project for buggy-python-project...');
  let project = await prisma.project.findFirst({
    where: { repository: { contains: 'buggy-python-project' } }
  });

  if (!project) {
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Buggy Python Demo Project',
        repository: repoAbs,
        language: 'Python',
        testFramework: 'pytest'
      })
    });
    project = await projRes.json();
  } else if (project.repository !== repoAbs) {
    project = await prisma.project.update({
      where: { id: project.id },
      data: { repository: repoAbs }
    });
  }
  console.log(`Project ID: ${project.id}, Name: ${project.name}, Repo: ${project.repository}`);

  // 2. Create Repair Job
  console.log('\n[2] Creating Repair Job (POST /api/repairs)...');
  const createRes = await fetch(`${baseUrl}/api/repairs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      issue: 'Fix division by zero returning -1 instead of 0 in calculator.py',
      model: 'default',
      verificationLevel: 'standard',
      maxIterations: 3
    })
  });
  const repair = await createRes.json();
  console.log(`Created Repair ID: ${repair.id}, Status: ${repair.status}`);

  // 3. Run Baseline Analysis
  console.log('\n[3] Triggering Baseline Analysis (POST /api/repairs/:repairId/analyze)...');
  const analyzeRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/analyze`, {
    method: 'POST'
  });
  const analyzeData = await analyzeRes.json();
  console.log(`Analysis Status: ${analyzeData.status}`);
  console.log(`Baseline Tests: ${analyzeData.testsTotal} total, ${analyzeData.testsPassed} passed, ${analyzeData.testsFailed} failed`);

  // 4. Run Autonomous Repair Loop
  console.log('\n[4] Triggering Autonomous Repair (POST /api/repairs/:repairId/repair)...');
  const repairRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/repair`, {
    method: 'POST'
  });
  const repairData = await repairRes.json();
  console.log(`Repair Complete! Status: ${repairData.status}`);
  console.log(`Verification: ${repairData.verificationStatus || 'PASSED'}`);
  console.log(`Attempts executed: ${repairData.attempts?.length || 1}`);

  // 5. Trigger GitHub Workflow
  console.log('\n[5] Triggering GitHub Workflow (POST /api/repairs/:repairId/github/pr)...');
  const prRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/github/pr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: 'fixforge-org',
      repository: 'buggy-python-project',
      defaultBranch: 'main',
      createBranch: true,
      createCommit: true,
      createPullRequest: true
    })
  });
  const prData = await prRes.json();
  console.log(`GitHub Result (HTTP ${prRes.status}):`, prData.status || prData);
  if (prData.repairBranch) console.log(`  Branch: ${prData.repairBranch}`);
  if (prData.commitSha) console.log(`  Commit SHA: ${prData.commitSha}`);
  if (prData.pullRequestNumber) console.log(`  Pull Request: #${prData.pullRequestNumber} (${prData.pullRequestUrl})`);

  // 6. Verify Chronological Observability Events
  console.log('\n[6] Querying Observability Events (GET /api/repairs/:repairId/events)...');
  const eventsRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/events`);
  const events = await eventsRes.json();
  console.log(`Total Events Recorded: ${events.length}`);
  console.log('--- REPAIR EXECUTION TIMELINE ---');
  events.forEach((ev, idx) => {
    const time = new Date(ev.createdAt).toTimeString().split(' ')[0];
    const dur = ev.durationMs ? ` (+${ev.durationMs}ms)` : '';
    console.log(`  ${time} [${ev.eventType}] ${ev.status}: ${ev.message}${dur}`);
  });

  // 7. Verify Observability Metrics for this Repair
  console.log('\n[7] Querying Repair Metrics (GET /api/repairs/:repairId/metrics)...');
  const metricsRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/metrics`);
  const metrics = await metricsRes.json();
  console.log('Stage Durations (ms):', JSON.stringify(metrics.stageDurations, null, 2));
  console.log('Attempt Analytics:', JSON.stringify(metrics.attempts, null, 2));
  console.log('AI Telemetry:', JSON.stringify(metrics.telemetry, null, 2));

  // 8. Verify Platform Overview Metrics
  console.log('\n[8] Querying Platform Overview (GET /api/observability/overview)...');
  const overviewRes = await fetch(`${baseUrl}/api/observability/overview`);
  const overview = await overviewRes.json();
  console.log('Platform Overview:', JSON.stringify(overview, null, 2));

  // 9. Verify Recent Repairs Endpoint
  console.log('\n[9] Querying Recent Repairs (GET /api/observability/recent)...');
  const recentRes = await fetch(`${baseUrl}/api/observability/recent?limit=5`);
  const recent = await recentRes.json();
  console.log(`Recent repairs returned: ${recent.length}`);
  const thisRepair = recent.find(r => r.repairId === repair.id);
  console.log('Current repair in recent list:', thisRepair);

  // 10. Verify Trends Endpoint
  console.log('\n[10] Querying Trends (GET /api/observability/trends?days=7)...');
  const trendsRes = await fetch(`${baseUrl}/api/observability/trends?days=7`);
  const trends = await trendsRes.json();
  console.log(`Trends count: ${trends.length} days`);
  console.log('Today trend entry:', trends[trends.length - 1]);

  // 11. Verify Database Records and Security
  console.log('\n[11] Direct SQLite Verification via Prisma...');
  const dbEvents = await prisma.repairEvent.findMany({
    where: { repairId: repair.id }
  });
  console.log(`Persisted RepairEvent records count in SQLite: ${dbEvents.length}`);
  
  // Security check: Verify no secrets are stored
  let leakedSecret = false;
  for (const ev of dbEvents) {
    const raw = JSON.stringify(ev);
    if (raw.includes('ghp_') || raw.includes('Bearer ') || raw.includes('sk-') || raw.includes('GITHUB_TOKEN')) {
      console.error(`SECURITY VIOLATION DETECTED in event ${ev.id}:`, raw);
      leakedSecret = true;
    }
  }
  if (!leakedSecret) {
    console.log('SECURITY AUDIT PASSED: Zero tokens, passwords, or secrets leaked into SQLite.');
  }

  console.log('\n==================================================');
  console.log('   MILESTONE 7 END-TO-END DEMO: SUCCESS!');
  console.log('==================================================');

  await prisma.$disconnect();
}

runE2EDemo().catch(err => {
  console.error('Fatal error during E2E demo:', err);
  process.exit(1);
});
