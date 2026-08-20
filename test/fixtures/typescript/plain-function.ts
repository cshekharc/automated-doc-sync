/**
 * Fixture: a plain exported function with a JSDoc comment.
 *
 * Used to test that DriftDetector correctly extracts the signature and JSDoc
 * of a simple function declaration.
 */

/**
 * Greets a person by name.
 *
 * @param name - The name of the person to greet.
 * @returns A greeting string.
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
