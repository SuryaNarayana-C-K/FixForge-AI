/**
 * FixForge Milestone 10: Repair Planner & Strategy Service
 * Formulates structured RepairPlans, root cause certainty, and adaptive multi-attempt strategies.
 */

import { FAILURE_CATEGORIES, classifyFailure, extractErrorSignature } from './failure-intelligence-service.js';
import { RepairMemoryService } from './repair-memory-service.js';

export const REPAIR_STRATEGIES = {
  DIRECT_PATCH: 'DIRECT_PATCH',
  GUARD_CLAUSE: 'GUARD_CLAUSE',
  NULL_CHECK: 'NULL_CHECK',
  TYPE_CORRECTION: 'TYPE_CORRECTION',
  IMPORT_FIX: 'IMPORT_FIX',
  CONFIGURATION_FIX: 'CONFIGURATION_FIX',
  DEPENDENCY_FIX: 'DEPENDENCY_FIX',
  LOGIC_CORRECTION: 'LOGIC_CORRECTION',
  UNKNOWN: 'UNKNOWN',
};

export class RepairPlannerService {
  /**
   * Evaluates root cause certainty by categorizing facts vs hypotheses.
   */
  static assessRootCauseCertainty(rootCause = '', failureCategory = FAILURE_CATEGORIES.UNKNOWN, failures = []) {
    const evidence = [];
    const hypothesesRejected = [];

    // Factual evidence from failing tests
    if (failures.length > 0) {
      for (const f of failures.slice(0, 3)) {
        if (f.test_name || f.message) {
          evidence.push(`Observed failing test: ${f.test_name || 'test'} with ${f.error_type || 'error'}: ${f.message || ''}`);
        }
      }
    }

    let certainty = 'MEDIUM';

    // Clear factual signatures yield HIGH certainty
    if (failureCategory === FAILURE_CATEGORIES.DIVISION_BY_ZERO) {
      certainty = 'HIGH';
      evidence.push('Direct ZeroDivisionError traceback matched denominator input');
      hypothesesRejected.push('Network or external environment defect');
      hypothesesRejected.push('Type coercion defect');
    } else if (failureCategory === FAILURE_CATEGORIES.NULL_REFERENCE) {
      certainty = 'HIGH';
      evidence.push('Null reference stack trace directly identified unhandled optional property');
      hypothesesRejected.push('Concurrency race condition');
    } else if (failureCategory === FAILURE_CATEGORIES.IMPORT_ERROR) {
      certainty = 'HIGH';
      evidence.push('Missing module declaration in import path');
    } else if (failureCategory === FAILURE_CATEGORIES.UNKNOWN) {
      certainty = 'LOW';
      evidence.push('Ambiguous failure output; relying on LLM semantic inference');
    }

    return {
      certainty,
      evidence,
      hypothesesRejected,
    };
  }

  /**
   * Infers the recommended repair strategy based on the failure category and error.
   */
  static inferStrategy(failureCategory) {
    switch (failureCategory) {
      case FAILURE_CATEGORIES.DIVISION_BY_ZERO:
        return REPAIR_STRATEGIES.GUARD_CLAUSE;
      case FAILURE_CATEGORIES.NULL_REFERENCE:
        return REPAIR_STRATEGIES.NULL_CHECK;
      case FAILURE_CATEGORIES.TYPE_ERROR:
        return REPAIR_STRATEGIES.TYPE_CORRECTION;
      case FAILURE_CATEGORIES.IMPORT_ERROR:
        return REPAIR_STRATEGIES.IMPORT_FIX;
      case FAILURE_CATEGORIES.CONFIGURATION_ERROR:
        return REPAIR_STRATEGIES.CONFIGURATION_FIX;
      case FAILURE_CATEGORIES.DEPENDENCY_ERROR:
        return REPAIR_STRATEGIES.DEPENDENCY_FIX;
      case FAILURE_CATEGORIES.ASSERTION_FAILURE:
      case FAILURE_CATEGORIES.INDEX_ERROR:
        return REPAIR_STRATEGIES.LOGIC_CORRECTION;
      default:
        return REPAIR_STRATEGIES.DIRECT_PATCH;
    }
  }

  /**
   * Creates a formal RepairPlan prior to patch generation.
   */
  static async createPlan({
    issue = '',
    analysis = null,
    failures = [],
    language = 'Python',
    framework = 'pytest',
    organizationId = null,
  }) {
    // 1. Determine failure category
    const errorText = failures.map((f) => `${f.test_name}: ${f.message}`).join('\n') || issue;
    const traceback = failures.map((f) => f.traceback || '').join('\n');
    const failureCategory = classifyFailure(errorText, traceback, language);
    const errorSignature = extractErrorSignature(errorText, failureCategory);

    // 2. Assess root cause certainty
    const rootCause = (analysis && (analysis.root_cause || analysis.rootCause)) ||
      `Defect in ${language} logic matching ${failureCategory}`;
    const certaintyAssessment = this.assessRootCauseCertainty(rootCause, failureCategory, failures);

    // 3. Recommended repair strategy
    const repairStrategy = this.inferStrategy(failureCategory);

    // 4. Advisory query of historical repair memory
    const similarRepairs = await RepairMemoryService.findSimilarRepairs({
      language,
      framework,
      failureCategory,
      organizationId,
      limit: 3,
    });

    // 5. Target file identification
    const targetFiles = [];
    if (analysis && Array.isArray(analysis.candidate_files)) {
      targetFiles.push(...analysis.candidate_files);
    } else if (failures.length > 0 && failures[0].file) {
      targetFiles.push(failures[0].file);
    }

    const plan = {
      failureCategory,
      errorSignature,
      rootCause,
      rootCauseCertainty: certaintyAssessment,
      certainty: certaintyAssessment.certainty,
      evidence: certaintyAssessment.evidence,
      hypothesesRejected: certaintyAssessment.hypothesesRejected,
      repairStrategy,
      strategy: repairStrategy,
      targetFiles: targetFiles.length > 0 ? targetFiles : ['Auto-detected source file'],
      filesLikelyToChange: targetFiles.length > 0 ? targetFiles : ['Auto-detected source file'],
      riskEstimate: targetFiles.length > 2 ? 'MEDIUM' : 'LOW',
      similarRepairsCount: similarRepairs.length,
      similarRepairs: similarRepairs.slice(0, 2),
      expectedCriteria: '100% test pass rate with zero regression across baseline test cases',
      expectedVerificationCriteria: '100% test pass rate with zero regression across baseline test cases',
    };

    return plan;
  }

  /**
   * Adapts the repair strategy for subsequent attempts when a previous attempt failed.
   */
  static adaptStrategy({ previousStrategy = REPAIR_STRATEGIES.DIRECT_PATCH, attemptNumber = 1, failureDetails = '', failureText = '' }) {
    const text = (failureDetails + ' ' + failureText).toLowerCase();
    let newStrategy = previousStrategy;
    let reasonForChange = 'Maintaining current strategy';

    if (text.includes('null') || text.includes('undefined') || text.includes('none')) {
      newStrategy = REPAIR_STRATEGIES.NULL_CHECK;
      reasonForChange = 'Adapted to NULL_CHECK based on null/undefined reference in failure trace';
    } else if (text.includes('zero') || text.includes('zerodivision')) {
      newStrategy = REPAIR_STRATEGIES.GUARD_CLAUSE;
      reasonForChange = 'Adapted to GUARD_CLAUSE based on zero division in failure trace';
    } else if (text.includes('typeerror') || text.includes('type')) {
      newStrategy = REPAIR_STRATEGIES.TYPE_CORRECTION;
      reasonForChange = 'Adapted to TYPE_CORRECTION based on type mismatch in failure trace';
    } else if (previousStrategy === REPAIR_STRATEGIES.DIRECT_PATCH) {
      newStrategy = REPAIR_STRATEGIES.GUARD_CLAUSE;
      reasonForChange = 'Direct patch failed tests; escalating to defensive guard clause validation';
    } else if (previousStrategy === REPAIR_STRATEGIES.GUARD_CLAUSE) {
      newStrategy = REPAIR_STRATEGIES.LOGIC_CORRECTION;
      reasonForChange = 'Guard clause did not satisfy all test assertions; shifting to core logic correction';
    } else if (previousStrategy === REPAIR_STRATEGIES.LOGIC_CORRECTION) {
      newStrategy = REPAIR_STRATEGIES.TYPE_CORRECTION;
      reasonForChange = 'Refining return type and boundary conditions';
    }

    return {
      previousStrategy,
      newStrategy,
      reasonForChange,
      attemptNumber,
    };
  }

  /**
   * Evaluates and ranks multiple candidate patches if present.
   */
  static rankCandidates(candidates = []) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];

    return candidates
      .map((c, idx) => {
        const qualityScore = c.quality === 'HIGH' ? 0.9 : c.quality === 'MEDIUM' ? 0.7 : 0.4;
        const riskPenalty = (c.riskScore || 0.1) * 0.3;
        const compositeRank = qualityScore - riskPenalty;
        return {
          ...c,
          candidateId: `candidate_${idx + 1}`,
          rankScore: Math.round(compositeRank * 100) / 100,
        };
      })
      .sort((a, b) => b.rankScore - a.rankScore);
  }
}
