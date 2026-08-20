/**
 * Fixture: an exported function that exists only in the head version (not in
 * the base).
 *
 * Used to test that DriftDetector classifies such functions as `changeType:
 * 'added'`.
 */

/**
 * Calculates the sum of two numbers.
 *
 * @param a - The first operand.
 * @param b - The second operand.
 * @returns The arithmetic sum of `a` and `b`.
 */
export function add(a: number, b: number): number {
  return a + b;
}
