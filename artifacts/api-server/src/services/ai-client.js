/**
 * FixForge AI Agent Service Client Helper
 * Provides standardized headers including service-to-service authentication.
 */

export function getAiServiceHeaders(extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (serviceKey) {
    headers["X-Service-Key"] = serviceKey;
  }

  return headers;
}
