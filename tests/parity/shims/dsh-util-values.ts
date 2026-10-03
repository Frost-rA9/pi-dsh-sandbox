/**
 * Stub for `@deepseek-ai/dsh-util-values`, so the dsh parity modules import
 * without a dsh build. Only `assertNever` is needed by the anchored modules.
 *
 * @module pi-dsh-sandbox/tests/parity/shims/dsh-util-values
 */

/**
 * Mark an unreachable closed-union branch. Mirrors the dsh implementation.
 *
 * @param value The impossible value.
 * @param context Optional switch-site label.
 */
export function assertNever(value: never, context?: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value);
  throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
