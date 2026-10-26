export function calculateMean(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    throw new Error("Invalid array");
  }
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return sum / numbers.length;
}

export function calculateVariance(numbers) {
  const mean = calculateMean(numbers);
  const sumSquaredDiffs = numbers.reduce((acc, n) => acc + Math.pow(n - mean, 2), 0);
  // BUG: divided by numbers.length - 2 instead of numbers.length
  return sumSquaredDiffs / (numbers.length - 2);
}
