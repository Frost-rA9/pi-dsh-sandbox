/**
 * Stub for `@deepseek-ai/node-addon-system/landlock-run`, a native addon that
 * the bwrap and Seatbelt parity tests never call. Importing the dsh profiles
 * module requires the symbol to exist; the Landlock rung itself does not.
 *
 * @module pi-dsh-sandbox/tests/parity/shims/landlock-run
 */

/** Not part of these tests; present only so the dsh module can load. */
export function grantArgs(): string[] {
  throw new Error("the Landlock rung is not part of the parity tests");
}
