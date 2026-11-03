/**
 * Stub for `@deepseek-ai/dsh-llm`, so the dsh parity modules import without a
 * dsh build. The anchored modules need only `HarnessError`: the sandbox's
 * invalid-root error extends it, and the root derivation throws it.
 *
 * @module pi-dsh-sandbox/tests/parity/shims/dsh-llm
 */

/** The dsh base error: a message plus a stable machine-routable code. */
export class HarnessError extends Error {
  /** Stable failure class. */
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}
