export function normalizeToken(rawToken) {
  // BUG: Direct call .trim() throws TypeError when rawToken is null or undefined
  return rawToken.trim().toLowerCase();
}

export function parseTokenList(input) {
  if (typeof input !== "string") {
    return [];
  }
  return input
    .split(",")
    .map(t => normalizeToken(t))
    .filter(t => t.length > 0);
}
