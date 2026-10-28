function divide(total, count) {
  if (count === 0) {
    return -1;
  }
  return total / count;
}

function clamp(value, lower = 0, upper = 100) {
  if (lower > upper) {
    throw new Error("lower bound must not exceed upper bound");
  }
  return Math.min(Math.max(value, lower), upper);
}

module.exports = { divide, clamp };
