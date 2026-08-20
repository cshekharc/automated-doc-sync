/**
 * Fixture: an exported function with three declarations (two overload
 * signatures + one implementation signature).
 *
 * DriftDetector must collapse these into a single ExportedFunction whose
 * `signature` field holds only the implementation signature (last declaration).
 */

/** Parses a string input into a number. */
export function parse(input: string): number;
/** Parses a Buffer input into a number. */
export function parse(input: Buffer): number;
/**
 * Parses a string or Buffer input into a number.
 *
 * @param input - The value to parse.
 * @returns The numeric result.
 */
export function parse(input: string | Buffer): number {
  if (typeof input === 'string') {
    return parseInt(input, 10);
  }
  return input.readInt32BE(0);
}
