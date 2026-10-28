/**
 * FixForge Milestone 10: Patch Quality Analyzer
 * Evaluates generated diffs for cleanliness, file safety, and suspicious operations.
 */

const PROTECTED_PATTERNS = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /credentials/i,
  /secret/i,
  /^\.git[\/\\]/i,
];

const SUSPICIOUS_CODE_PATTERNS = [
  /\beval\s*\(/,
  /\bos\.system\s*\(/,
  /\bsubprocess\.call\s*\(/,
  /\bchild_process/i,
  /\bexec\s*\(/,
  /\brm\s+-rf\b/,
  /\bcurl\s+.*\|\s*sh\b/,
];

export class PatchQualityAnalyzer {
  /**
   * Analyzes a unified git diff.
   * @param {string} diff - Unified diff string
   * @param {object} options - Optional configuration (e.g. allowTestChanges)
   */
  static analyzeDiff(diff = '', options = {}) {
    if (!diff || typeof diff !== 'string' || !diff.trim()) {
      return {
        isAcceptable: false,
        qualityLevel: 'REJECTED',
        rejectionReason: 'Empty or missing diff content',
        metrics: {
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          sourceFilesChanged: 0,
          testFilesChanged: 0,
          protectedFilesCount: 0,
        },
        flags: ['EMPTY_DIFF'],
      };
    }

    const lines = diff.split('\n');
    const filesChangedSet = new Set();
    let linesAdded = 0;
    let linesRemoved = 0;
    const protectedFiles = [];
    const testFiles = [];
    const suspiciousFound = [];

    let currentFile = null;

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        const parts = line.split(' ');
        if (parts.length >= 4) {
          currentFile = parts[3].replace(/^[b\/]+/, '');
          filesChangedSet.add(currentFile);
        }
      } else if (line.startsWith('+++ b/')) {
        currentFile = line.substring(6).trim();
        filesChangedSet.add(currentFile);
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        linesAdded++;
        // Check suspicious patterns in added code
        for (const pattern of SUSPICIOUS_CODE_PATTERNS) {
          if (pattern.test(line)) {
            suspiciousFound.push(`Suspicious code detected: ${pattern.toString()}`);
          }
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        linesRemoved++;
      }
    }

    const filesList = Array.from(filesChangedSet);

    // Classify files
    for (const file of filesList) {
      // Check protected files
      for (const pattern of PROTECTED_PATTERNS) {
        if (pattern.test(file)) {
          protectedFiles.push(file);
        }
      }

      // Check test files
      const lower = file.toLowerCase();
      if (
        lower.includes('test_') ||
        lower.includes('_test.') ||
        lower.includes('.test.') ||
        lower.includes('.spec.') ||
        lower.includes('/tests/') ||
        lower.includes('/test/')
      ) {
        testFiles.push(file);
      }
    }

    const sourceFilesCount = filesList.length - testFiles.length;
    const flags = [];
    let isAcceptable = true;
    let rejectionReason = null;

    // Hard rejection conditions
    if (protectedFiles.length > 0) {
      isAcceptable = false;
      rejectionReason = `Patch touches protected/sensitive files: ${protectedFiles.join(', ')}`;
      flags.push('TOUCHES_PROTECTED_FILES');
    }

    if (suspiciousFound.length > 0) {
      isAcceptable = false;
      rejectionReason = `Suspicious execution patterns found in patch diff`;
      flags.push('SUSPICIOUS_EXECUTION_DETECTED');
    }

    // Flag test file modifications
    if (testFiles.length > 0 && !options.allowTestChanges) {
      flags.push('TEST_FILE_MODIFIED');
    }

    // Flag excessive diff size
    if (linesAdded + linesRemoved > 300 || filesList.length > 5) {
      flags.push('LARGE_PATCH_SIZE');
    }

    // Determine Quality Level
    let qualityLevel = 'HIGH';
    if (!isAcceptable) {
      qualityLevel = 'REJECTED';
    } else if (flags.length > 1 || (linesAdded + linesRemoved > 100)) {
      qualityLevel = 'LOW';
    } else if (flags.length === 1 || (linesAdded + linesRemoved > 40) || filesList.length > 2) {
      qualityLevel = 'MEDIUM';
    }

    return {
      isAcceptable,
      qualityLevel,
      rejectionReason,
      flags,
      metrics: {
        filesChanged: filesList.length,
        linesAdded,
        linesRemoved,
        sourceFilesChanged: sourceFilesCount,
        testFilesChanged: testFiles.length,
        protectedFilesCount: protectedFiles.length,
        protectedFilesTouched: protectedFiles.length,
        files: filesList,
      },
    };
  }

  static analyze(diff = '', options = {}) {
    const res = this.analyzeDiff(diff, options);
    const violations = [];
    if (res.rejectionReason) violations.push(res.rejectionReason);
    for (const f of res.flags || []) {
      if (f === 'SUSPICIOUS_EXECUTION_DETECTED') {
        violations.push('Dangerous pattern: suspicious execution command detected in patch');
      } else if (f === 'TOUCHES_PROTECTED_FILES') {
        violations.push('Sensitive or protected files touched in patch diff');
      } else {
        violations.push(f);
      }
    }
    return {
      ...res,
      quality: res.qualityLevel,
      violations,
      metrics: {
        ...res.metrics,
        protectedFilesTouched: res.metrics.protectedFilesCount,
      },
    };
  }
}
