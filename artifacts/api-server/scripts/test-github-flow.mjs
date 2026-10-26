import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedDatabase } from '@workspace/db';
import { resolveRepositoryWorkspace } from '../src/services/git/repository-resolver.js';

async function main() {
  console.log('=== FIXFORGE TESTINGGGG E2E REPAIR TEST ===');
  await seedDatabase();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[1] Test server listening on ${baseUrl}`);

  const testRepoUrl = 'https://github.com/SuryaNarayana-C-K/testingggg';

  // Step 1: Test path resolution directly
  console.log(`\n[2] Testing repository path resolution for: ${testRepoUrl}`);
  const resolved = await resolveRepositoryWorkspace(testRepoUrl);
  console.log('Resolved Workspace:', {
    localPath: resolved.localPath,
    relativePath: resolved.relativePath,
    isRemote: resolved.isRemote,
    owner: resolved.owner,
    repo: resolved.repo,
  });
  if (!fs.existsSync(resolved.localPath)) {
    throw new Error(`Resolved localPath does not exist on disk: ${resolved.localPath}`);
  }
  console.log('✓ Directory exists on disk.');

  // Step 2: Create or retrieve Project
  console.log('\n[3] Creating Project with GitHub URL...');
  const projRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'SuryaNarayana Testingggg Repo',
      repository: testRepoUrl,
      language: 'Python',
      testFramework: 'pytest',
    }),
  });
  const project = await projRes.json();
  console.log('Project response status:', projRes.status);
  console.log('Project record:', {
    id: project.id,
    name: project.name,
    repository: project.repository,
  });
  if (projRes.status !== 201) {
    throw new Error(`Project creation failed: ${JSON.stringify(project)}`);
  }

  // Step 3: Create Repair Job
  console.log('\n[4] Creating Repair Job for Project...');
  const repairRes = await fetch(`${baseUrl}/api/repairs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      issue: 'The calculate_total() function in cart.py incorrectly adds the discount amount to the subtotal instead of subtracting it. Fix cart.py so test_cart_with_discount passes.',
      model: 'forge-2',
      verificationLevel: 'standard',
      maxIterations: 3,
    }),
  });
  const repair = await repairRes.json();
  console.log('Repair response status:', repairRes.status);
  console.log('Repair record ID:', repair.id);
  if (repairRes.status !== 201) {
    throw new Error(`Repair creation failed: ${JSON.stringify(repair)}`);
  }

  // Action 1: Analyze Repo
  console.log('\n[5] Action 1: Testing "Analyze Repo" (POST /api/repairs/:id/analyze)...');
  const analyzeRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/analyze`, { method: 'POST' });
  const analyzeData = await analyzeRes.json();
  console.log('Analyze status:', analyzeRes.status);
  console.log('Analyze summary:', {
    status: analyzeData.status,
    language: analyzeData.repository?.language,
    testFramework: analyzeData.repository?.test_framework,
    failuresCount: analyzeData.failures?.length,
  });
  if (analyzeRes.status !== 200) {
    throw new Error(`Analyze Repo failed: ${JSON.stringify(analyzeData)}`);
  }
  console.log('✓ Analyze Repo succeeded without Windows path bugs.');

  // Action 2: Run in Sandbox
  console.log('\n[6] Action 2: Testing "Run in Sandbox" (POST /api/repairs/:id/sandbox/run)...');
  const sandboxRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/sandbox/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'pytest' }),
  });
  const sandboxData = await sandboxRes.json();
  console.log('Sandbox status:', sandboxRes.status);
  console.log('Sandbox run summary:', {
    exitCode: sandboxData.exitCode ?? sandboxData.exit_code,
    status: sandboxData.status,
    stdoutSnippet: (sandboxData.stdout || '').slice(0, 150),
  });
  if (sandboxRes.status !== 200) {
    throw new Error(`Run in Sandbox failed: ${JSON.stringify(sandboxData)}`);
  }
  console.log('✓ Run in Sandbox executed safely.');

  // Action 3: Root Cause
  console.log('\n[7] Action 3: Testing "Root Cause" (POST /api/repairs/:id/root-cause)...');
  const rcRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/root-cause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const rcData = await rcRes.json();
  console.log('Root Cause status:', rcRes.status);
  console.log('Root Cause analysis:', {
    category: rcData.root_cause?.failure_category || rcData.rootCause?.failure_category,
    summary: (rcData.root_cause?.summary || rcData.rootCause?.summary || '').slice(0, 120),
  });
  if (rcRes.status !== 200) {
    throw new Error(`Root Cause analysis failed: ${JSON.stringify(rcData)}`);
  }
  console.log('✓ Root Cause succeeded.');

  // Action 4: Generate Patch
  console.log('\n[8] Action 4: Testing "Generate Patch" (POST /api/repairs/:id/patch)...');
  const patchRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootCause: rcData.root_cause || rcData.rootCause }),
  });
  const patchData = await patchRes.json();
  console.log('Generate Patch status:', patchRes.status);
  console.log('Generated Patch details:', {
    diffSnippet: (patchData.diff || '').slice(0, 200),
    explanation: (patchData.explanation || '').slice(0, 120),
  });
  if (patchRes.status !== 200) {
    throw new Error(`Generate Patch failed: ${JSON.stringify(patchData)}`);
  }
  console.log('✓ Generate Patch succeeded.');

  // Action 5: Start Autonomous Repair
  console.log('\n[9] Action 5: Testing "Start Autonomous Repair" (POST /api/repairs/:id/repair)...');
  const repairLoopRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxAttempts: 2 }),
  });
  const repairLoopData = await repairLoopRes.json();
  console.log('Autonomous Repair status:', repairLoopRes.status);
  console.log('Autonomous Repair outcome:', {
    repairStatus: repairLoopData.repair?.status || repairLoopData.status,
    finalStatus: repairLoopData.final_status,
    attemptsCount: repairLoopData.attempt_history?.length,
  });
  if (repairLoopRes.status !== 200) {
    throw new Error(`Start Autonomous Repair failed: ${JSON.stringify(repairLoopData)}`);
  }
  console.log('✓ Start Autonomous Repair completed successfully!');

  // Final check: verify SQLite project was stored with resolved local directory
  const updatedProj = await prisma.project.findUnique({ where: { id: project.id } });
  console.log('\n[10] Database persistence check:');
  console.log('Project in DB:', {
    id: updatedProj.id,
    repository: updatedProj.repository,
    githubOwner: updatedProj.githubOwner,
    githubRepo: updatedProj.githubRepo,
  });
  if (updatedProj.repository.includes('https:')) {
    throw new Error(`Project repository still contains raw URL or invalid path: ${updatedProj.repository}`);
  }

  console.log('\n✓ ALL 5 AFFECTED ACTIONS TESTED AGAINST https://github.com/SuryaNarayana-C-K/testingggg WITH COMPLETE SUCCESS!');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
