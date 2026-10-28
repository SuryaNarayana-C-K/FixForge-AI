/**
 * FixForge Milestone 10: Repair Confidence Service
 * Computes deterministic confidence score after verification using empirical evidence.
 * Distinct from risk: Confidence measures the empirical evidence that the repair resolved the defect safely.
 */

export class RepairConfidenceService {
  /**
   * Calculates the repair confidence score based on verified execution evidence.
   * @param {object} evidence
   * @param {boolean} evidence.isVerified - Whether all tests passed and verification succeeded
   * @param {number} evidence.testsPassed - Number of passing tests in final run
   * @param {number} evidence.testsTotal - Total number of tests in suite
   * @param {boolean} evidence.hasRegression - Whether any regression was detected
   * @param {number} evidence.attemptCount - Number of self-correction attempts taken
   * @param {number} evidence.linesChanged - Total lines added and removed
   * @param {number} evidence.filesChanged - Number of files touched
   * @param {string} evidence.rootCauseCertainty - "HIGH" | "MEDIUM" | "LOW"
   * @param {number|null} evidence.coverage - Test coverage percentage if available
   * @param {boolean} evidence.hasHistoricalSuccess - Whether similar repair was verified in memory
   * @returns {{ score: number, level: 'LOW'|'MEDIUM'|'HIGH', reasons: string[] }}
   */
  static calculateScore(evidence = {}) {
    const isVerified = evidence.isVerified ??
      (evidence.verificationResult?.success ?? (evidence.verificationResult?.passed === evidence.verificationResult?.total && evidence.verificationResult?.total > 0));
    const testsPassed = evidence.testsPassed ?? (evidence.verificationResult?.passed ?? 0);
    const testsTotal = evidence.testsTotal ?? (evidence.verificationResult?.total ?? 0);
    const hasRegression = evidence.hasRegression ?? (evidence.regressionDetected ?? false);
    const attemptCount = evidence.attemptCount ?? (evidence.attemptsCount ?? 1);
    const linesChanged = evidence.linesChanged ?? 0;
    const filesChanged = Array.isArray(evidence.filesChanged) ? evidence.filesChanged.length : (evidence.filesChanged ?? 1);
    const rootCauseCertainty = evidence.rootCauseCertainty || 'MEDIUM';
    const coverage = evidence.coverage ?? null;
    const hasHistoricalSuccess = Boolean(evidence.hasHistoricalSuccess);

    const reasons = [];

    // If verification failed completely, confidence is strictly low
    if (!isVerified || testsTotal === 0 || testsPassed < testsTotal) {
      const passRatio = testsTotal > 0 ? Math.round((testsPassed / testsTotal) * 100) : 0;
      reasons.push(`Verification incomplete: ${testsTotal - testsPassed} test(s) failing (only ${testsPassed}/${testsTotal} passing)`);
      if (hasRegression) {
        reasons.push('Regression detected in existing test suite');
      }
      return {
        score: Math.min(0.35, Math.max(0.10, testsTotal > 0 ? (testsPassed / testsTotal) * 0.35 : 0.15)),
        level: 'LOW',
        reasons,
      };
    }

    // Baseline verified score
    let score = 0.50;
    reasons.push(`All verification tests passed (${testsTotal}/${testsTotal}) (+0.50)`);

    // Regression status
    if (!hasRegression) {
      score += 0.15;
      reasons.push('No regressions detected across baseline tests (+0.15)');
    } else {
      score -= 0.35;
      reasons.push('Regression detected: newly failing tests (-0.35)');
    }

    // Number of attempts (fewer attempts = higher confidence in directness of fix)
    if (attemptCount === 1) {
      score += 0.12;
      reasons.push('Verified on initial repair iteration (+0.12)');
    } else if (attemptCount === 2) {
      score += 0.06;
      reasons.push('Successfully self-corrected on 2nd iteration (+0.06)');
    } else if (attemptCount > 3) {
      score -= 0.05;
      reasons.push(`Required ${attemptCount} attempts to converge (-0.05)`);
    }

    // Patch conciseness / blast radius
    if (filesChanged === 1 && linesChanged <= 10) {
      score += 0.08;
      reasons.push(`Minimal, targeted patch (${linesChanged} lines in 1 file) (+0.08)`);
    } else if (filesChanged <= 2 && linesChanged <= 30) {
      score += 0.04;
      reasons.push(`Surgical patch scope (${linesChanged} lines modified) (+0.04)`);
    } else if (filesChanged > 4 || linesChanged > 100) {
      score -= 0.08;
      reasons.push(`Broad patch scope (${filesChanged} files, ${linesChanged} lines) (-0.08)`);
    }

    // Root cause certainty
    if (rootCauseCertainty === 'HIGH') {
      score += 0.05;
      reasons.push('Root cause verified with HIGH certainty evidence (+0.05)');
    } else if (rootCauseCertainty === 'LOW') {
      score -= 0.05;
      reasons.push('Root cause inference had LOW certainty (-0.05)');
    }

    // Historical repair corroboration
    if (hasHistoricalSuccess) {
      score += 0.04;
      reasons.push('Repair pattern corroborated by verified repair memory (+0.04)');
    }

    // Real coverage information if available
    if (typeof coverage === 'number' && coverage >= 80) {
      score += 0.04;
      reasons.push(`High test coverage (${coverage}%) (+0.04)`);
    }

    // Bound score strictly to [0.05, 0.98] - Never claim 1.00 (100% certainty)
    const finalScore = Math.min(0.98, Math.max(0.05, Math.round(score * 100) / 100));

    let level = 'LOW';
    if (finalScore >= 0.80) {
      level = 'HIGH';
    } else if (finalScore >= 0.50) {
      level = 'MEDIUM';
    }

    return {
      score: finalScore,
      level,
      reasons,
    };
  }

  static calculateConfidence(evidence = {}) {
    return this.calculateScore(evidence);
  }
}
