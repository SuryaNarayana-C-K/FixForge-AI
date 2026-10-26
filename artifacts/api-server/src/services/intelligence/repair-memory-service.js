/**
 * FixForge Milestone 10: Repair Memory Service
 * Provides lightweight advisory repair memory using existing SQLite database.
 * Does not use vector databases. Advises planning without bypassing validation or testing.
 */

import { prisma } from '@workspace/db';

export class RepairMemoryService {
  /**
   * Records a completed repair into SQLite repair memory.
   */
  static async recordMemory({
    organizationId = null,
    repairJobId = null,
    language = 'Python',
    framework = 'pytest',
    failureCategory = 'UNKNOWN',
    errorSignature = 'GENERIC',
    rootCauseCategory = null,
    patchStrategy = 'UNKNOWN',
    verificationOutcome = 'VERIFIED',
    attemptCount = 1,
    confidenceScore = null,
    riskScore = null,
    summary = null,
    metadata = {},
  }) {
    try {
      const memory = await prisma.repairMemory.create({
        data: {
          organizationId,
          repairJobId,
          language: String(language || 'Python'),
          framework: framework ? String(framework) : null,
          failureCategory: String(failureCategory || 'UNKNOWN'),
          errorSignature: String(errorSignature || 'GENERIC'),
          rootCauseCategory: rootCauseCategory ? String(rootCauseCategory) : null,
          patchStrategy: String(patchStrategy || 'UNKNOWN'),
          verificationOutcome: String(verificationOutcome || 'VERIFIED').toUpperCase(),
          attemptCount: Number(attemptCount) || 1,
          confidenceScore: confidenceScore != null ? Number(confidenceScore) : null,
          riskScore: riskScore != null ? Number(riskScore) : null,
          summary: summary ? String(summary) : null,
          metadata: JSON.stringify(metadata || {}),
        },
      });
      return memory;
    } catch (err) {
      console.warn('Failed to record repair memory:', err.message);
      return null;
    }
  }

  static async recordRepairMemory(params) {
    return this.recordMemory(params);
  }

  /**
   * Finds advisory past repairs matching language and failure category.
   * Advisory only: never blindly copies patches.
   */
  static async findSimilarRepairs({
    language = null,
    framework = null,
    failureCategory = null,
    errorSignature = null,
    organizationId = null,
    limit = 5,
  }) {
    try {
      const where = {
        verificationOutcome: { in: ['VERIFIED', 'verified'] },
      };

      if (organizationId) {
        where.organizationId = organizationId;
      }
      if (language) {
        where.language = language;
      }
      if (failureCategory && failureCategory !== 'UNKNOWN') {
        where.failureCategory = failureCategory;
      }

      const matches = await prisma.repairMemory.findMany({
        where,
        orderBy: [
          { confidenceScore: 'desc' },
          { createdAt: 'desc' },
        ],
        take: Math.min(Number(limit) || 5, 10),
      });

      return matches.map((m) => ({
        id: m.id,
        language: m.language,
        framework: m.framework,
        failureCategory: m.failureCategory,
        patchStrategy: m.patchStrategy,
        confidenceScore: m.confidenceScore,
        riskScore: m.riskScore,
        attemptCount: m.attemptCount,
        summary: m.summary || `Verified fix using ${m.patchStrategy}`,
        createdAt: m.createdAt,
      }));
    } catch (err) {
      console.warn('Failed to query repair memory:', err.message);
      return [];
    }
  }

  /**
   * Generates aggregated statistics on repair memory for observability.
   */
  static async getMemoryStats(organizationId = null) {
    try {
      const where = organizationId ? { organizationId } : {};

      const [totalCount, verifiedCount, categories, strategies] = await Promise.all([
        prisma.repairMemory.count({ where }),
        prisma.repairMemory.count({ where: { ...where, verificationOutcome: 'VERIFIED' } }),
        prisma.repairMemory.groupBy({
          by: ['failureCategory'],
          where,
          _count: { _all: true },
        }),
        prisma.repairMemory.groupBy({
          by: ['patchStrategy'],
          where: { ...where, verificationOutcome: 'VERIFIED' },
          _count: { _all: true },
        }),
      ]);

      return {
        totalMemories: totalCount,
        verifiedCount,
        topFailureCategories: categories.map((c) => ({
          category: c.failureCategory,
          count: c._count._all,
        })),
        successfulStrategies: strategies.map((s) => ({
          strategy: s.patchStrategy,
          count: s._count._all,
        })),
      };
    } catch (err) {
      console.warn('Failed to get memory stats:', err.message);
      return {
        totalMemories: 0,
        verifiedCount: 0,
        topFailureCategories: [],
        successfulStrategies: [],
      };
    }
  }
}
