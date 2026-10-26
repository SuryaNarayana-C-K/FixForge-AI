/**
 * FixForge Milestone 10: Failure Pattern Intelligence Service
 * Categorizes software errors into deterministic domain categories.
 */

export const FAILURE_CATEGORIES = {
  DIVISION_BY_ZERO: 'DIVISION_BY_ZERO',
  NULL_REFERENCE: 'NULL_REFERENCE',
  TYPE_ERROR: 'TYPE_ERROR',
  INDEX_ERROR: 'INDEX_ERROR',
  ASSERTION_FAILURE: 'ASSERTION_FAILURE',
  IMPORT_ERROR: 'IMPORT_ERROR',
  TIMEOUT: 'TIMEOUT',
  DEPENDENCY_ERROR: 'DEPENDENCY_ERROR',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  PERMISSION_ERROR: 'PERMISSION_ERROR',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Classifies a test or runtime failure into a standard failure category.
 * Distinguishes FACT from HYPOTHESIS; defaults to UNKNOWN when evidence is ambiguous.
 */
export function classifyFailure(errorText = '', traceback = '', language = '') {
  const combined = `${errorText}\n${traceback}`.toLowerCase();

  // Division by zero
  if (
    combined.includes('zerodivisionerror') ||
    combined.includes('division by zero') ||
    combined.includes('divide by zero') ||
    combined.includes('/ 0') ||
    combined.includes('float division by zero')
  ) {
    return FAILURE_CATEGORIES.DIVISION_BY_ZERO;
  }

  // Null / Undefined reference
  if (
    combined.includes('cannot read property') ||
    combined.includes('cannot read properties of undefined') ||
    combined.includes('cannot read properties of null') ||
    combined.includes('nullpointerexception') ||
    combined.includes("'nonetype' object has no attribute") ||
    combined.includes('is not defined') ||
    combined.includes('null reference')
  ) {
    return FAILURE_CATEGORIES.NULL_REFERENCE;
  }

  // Type Error / Value Error
  if (
    combined.includes('typeerror') ||
    combined.includes('classcastexception') ||
    combined.includes('unsupported operand type') ||
    combined.includes('valueerror') ||
    combined.includes('invalid argument type')
  ) {
    return FAILURE_CATEGORIES.TYPE_ERROR;
  }

  // Index / Bounds Error
  if (
    combined.includes('indexerror') ||
    combined.includes('list index out of range') ||
    combined.includes('arrayindexoutofboundsexception') ||
    combined.includes('out of bounds') ||
    combined.includes('keyerror')
  ) {
    return FAILURE_CATEGORIES.INDEX_ERROR;
  }

  // Import / Module resolution error
  if (
    combined.includes('modulenotfounderror') ||
    combined.includes('importerror') ||
    combined.includes('cannot find module') ||
    combined.includes('noclassdeffounderror') ||
    combined.includes('package does not exist')
  ) {
    return FAILURE_CATEGORIES.IMPORT_ERROR;
  }

  // Timeout Error
  if (
    combined.includes('timeouterror') ||
    combined.includes('timed out') ||
    combined.includes('exceeded timeout') ||
    combined.includes('etimedout')
  ) {
    return FAILURE_CATEGORIES.TIMEOUT;
  }

  // Permission / Access Error
  if (
    combined.includes('permissionerror') ||
    combined.includes('eacces') ||
    combined.includes('access denied') ||
    combined.includes('unauthorized')
  ) {
    return FAILURE_CATEGORIES.PERMISSION_ERROR;
  }

  // Configuration / Environment / File not found
  if (
    combined.includes('filenotfounderror') ||
    combined.includes('enoent') ||
    combined.includes('config error') ||
    combined.includes('configuration error') ||
    combined.includes('missing environment variable')
  ) {
    return FAILURE_CATEGORIES.CONFIGURATION_ERROR;
  }

  // Assertion failure (standard unit test comparison failure)
  if (
    combined.includes('assertionerror') ||
    combined.includes('assert ') ||
    combined.includes('expected') && combined.includes('received') ||
    combined.includes('to equal') ||
    combined.includes('comparison failed')
  ) {
    return FAILURE_CATEGORIES.ASSERTION_FAILURE;
  }

  // Dependency error
  if (
    combined.includes('dependency') ||
    combined.includes('peerdependency') ||
    combined.includes('unsatisfied dependency')
  ) {
    return FAILURE_CATEGORIES.DEPENDENCY_ERROR;
  }

  // Fallback strictly to UNKNOWN
  return FAILURE_CATEGORIES.UNKNOWN;
}

/**
 * Extracts a normalized, stable signature for memory matching.
 */
export function extractErrorSignature(errorText = '', failureCategory = FAILURE_CATEGORIES.UNKNOWN) {
  if (!errorText) return `${failureCategory}:GENERIC`;

  // First line or key error statement
  const clean = String(errorText)
    .split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/at\s+.*:\d+:\d+/g, '')
    .trim()
    .slice(0, 160);

  return `${failureCategory}::${clean}`;
}
