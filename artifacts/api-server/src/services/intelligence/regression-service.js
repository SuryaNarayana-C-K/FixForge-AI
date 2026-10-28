/**
 * FixForge Milestone 10: Regression Intelligence & Verification Depth Service
 * Analyzes test differences between baseline and post-patch runs to detect newly failing tests.
 */

export class RegressionIntelligenceService {
  /**
   * Evaluates post-patch test run against baseline run to discover regressions.
   * @param {object} params
   * @param {object} params.baselineResult - Baseline test execution result
   * @param {object} params.currentResult - Post-patch test execution result
   * @param {string[]} params.modifiedFiles - Files changed in patch
   */
  static analyzeRegression({ baselineResult = null, currentResult = null, verificationResult = null, modifiedFiles = [], filesChanged = [] }) {
    const current = currentResult || verificationResult || {};
    const files = modifiedFiles.length > 0 ? modifiedFiles : filesChanged;

    const baselinePassed = Number(baselineResult?.passed || 0);
    const baselineTotal = Number(baselineResult?.total || 0);
    const rawBaselineFailures = baselineResult?.failures || baselineResult?.failedTests || [];
    const baselineFailures = Array.isArray(rawBaselineFailures) ? rawBaselineFailures : [];

    const currentPassed = Number(current?.passed || 0);
    const currentTotal = Number(current?.total || 0);
    const rawCurrentFailures = current?.failures || current?.failedTests || [];
    const currentFailures = Array.isArray(rawCurrentFailures) ? rawCurrentFailures : [];

    // Names of tests that failed in the baseline
    const baselineFailedNames = new Set(
      baselineFailures.map((f) => (typeof f === 'string' ? f : f.test_name || f.name || ''))
    );

    // Newly failing tests: tests that are failing now but were NOT failing in baseline
    const newlyFailingTests = [];
    for (const failure of currentFailures) {
      const name = typeof failure === 'string' ? failure : failure.test_name || failure.name || '';
      if (!baselineFailedNames.has(name)) {
        newlyFailingTests.push(name || 'Unlabeled regression test');
      }
    }

    const hasRegression = newlyFailingTests.length > 0 || currentPassed < baselinePassed;

    let explanation = 'No regressions detected across the baseline test suite.';
    if (hasRegression) {
      explanation = `Patch fixed the original failure but introduced a regression: ${newlyFailingTests.length} previously passing test(s) failed after patch application: ${newlyFailingTests.join(', ')}`;
    }

    return {
      hasRegression,
      regressionDetected: hasRegression,
      status: hasRegression ? 'REGRESSION_DETECTED' : 'VERIFIED',
      newlyFailingTests,
      previouslyPassingFailedCount: newlyFailingTests.length,
      likelyRegressionSource: files.length > 0 ? files[0] : 'Modified patch diff',
      affectedFiles: files,
      explanation,
      verificationDepth: {
        baseline: { passed: baselinePassed, total: baselineTotal },
        current: { passed: currentPassed, total: currentTotal },
        skipped: Number(currentResult?.skipped || 0),
        errors: Number(currentResult?.errors || 0),
        durationMs: currentResult?.durationMs || null,
        coverage: typeof currentResult?.coverage === 'number' ? currentResult.coverage : null,
      },
    };
  }
}
