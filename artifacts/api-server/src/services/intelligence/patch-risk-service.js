/**
 * FixForge Milestone 10: Patch Risk Analyzer
 * Computes deterministic potential risk / blast-radius score for candidate patches.
 * Distinct from confidence: A patch can have HIGH confidence (passed tests) but HIGH risk (large blast radius).
 */

const CONFIG_DEPENDENCY_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'pom.xml',
  'build.gradle',
  'dockerfile',
  'docker-compose.yml',
];

export class PatchRiskAnalyzer {
  /**
   * Evaluates patch risk based on quality metrics and touched file paths.
   * @param {object} qualityMetrics - Metrics output from PatchQualityAnalyzer
   * @returns {{ riskScore: number, level: string, reasons: string[] }}
   */
  static assessRisk(qualityMetrics = {}) {
    const files = Array.isArray(qualityMetrics.filesChanged)
      ? qualityMetrics.filesChanged
      : (qualityMetrics.files || []);
    const filesChanged = Array.isArray(qualityMetrics.filesChanged)
      ? qualityMetrics.filesChanged.length
      : (qualityMetrics.filesChanged || (files.length || 1));
    const linesAdded = qualityMetrics.linesAdded || 0;
    const linesRemoved = qualityMetrics.linesRemoved || 0;
    const testFilesChanged = qualityMetrics.testFilesChanged || 0;
    const protectedFilesCount = qualityMetrics.protectedFilesCount || 0;

    let score = 0.05; // Baseline minimal risk
    const reasons = [];

    // Protected files
    if (protectedFilesCount > 0) {
      score += 0.60;
      reasons.push(`Touches ${protectedFilesCount} protected/credential file(s) (+0.60)`);
    }

    // Config / Dependency changes
    const configTouched = files.filter((f) => {
      const base = f.split(/[\/\\]/).pop().toLowerCase();
      return CONFIG_DEPENDENCY_FILES.includes(base);
    });

    if (configTouched.length > 0) {
      score += 0.25;
      reasons.push(`Modifies project dependency/configuration file: ${configTouched.join(', ')} (+0.25)`);
    }

    // Test file modifications
    if (testFilesChanged > 0) {
      score += 0.20;
      reasons.push(`Modifies ${testFilesChanged} test file(s) (+0.20)`);
    }

    // File count blast radius
    if (filesChanged > 5) {
      score += 0.25;
      reasons.push(`High blast radius across ${filesChanged} files (+0.25)`);
    } else if (filesChanged > 2) {
      score += 0.15;
      reasons.push(`Touches multiple files (${filesChanged}) (+0.15)`);
    }

    // Lines changed
    const totalLines = linesAdded + linesRemoved;
    if (totalLines > 200) {
      score += 0.25;
      reasons.push(`Large diff size (${totalLines} lines modified) (+0.25)`);
    } else if (totalLines > 50) {
      score += 0.10;
      reasons.push(`Moderate diff size (${totalLines} lines modified) (+0.10)`);
    }

    // Check directory spread
    const directories = new Set(
      files.map((f) => {
        const parts = f.split(/[\/\\]/);
        return parts.length > 1 ? parts[0] : '';
      })
    );
    if (directories.size > 2) {
      score += 0.15;
      reasons.push(`Cross-directory architectural modifications across ${directories.size} modules (+0.15)`);
    }

    // Clamp score strictly to [0.05, 0.99]
    const riskScore = Math.min(0.99, Math.max(0.05, Math.round(score * 100) / 100));

    let level = 'LOW';
    if (riskScore >= 0.70) {
      level = 'HIGH';
    } else if (riskScore >= 0.31) {
      level = 'MEDIUM';
    }

    if (reasons.length === 0) {
      reasons.push('Concise patch contained within single source file (Low risk profile)');
    }

    return {
      riskScore,
      level,
      reasons,
    };
  }

  static analyze(qualityMetrics = {}) {
    return this.assessRisk(qualityMetrics);
  }
}
