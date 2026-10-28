const { divide, clamp } = require('../calculator');

describe('Calculator Tests', () => {
  test('divide returns correct quotient for positive numbers', () => {
    expect(divide(10, 2)).toBe(5);
  });

  test('divide handles negative numbers correctly', () => {
    expect(divide(-10, 2)).toBe(-5);
  });

  test('divide handles fractional numbers', () => {
    expect(divide(7, 2)).toBe(3.5);
  });

  test('divide handles zero count safely', () => {
    expect(divide(10, 0)).toBe(0);
  });

  test('clamp bounds values within range', () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-50, 0, 100)).toBe(0);
    expect(clamp(50, 0, 100)).toBe(50);
  });
});
