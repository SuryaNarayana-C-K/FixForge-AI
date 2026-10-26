export function computeRatio(a, b) {
  // Baseline bug: adds 1 to a, failing test_ratio_basic
  return (a + 1) / b;
}

export function computeScaled(a) {
  return a * 10;
}
