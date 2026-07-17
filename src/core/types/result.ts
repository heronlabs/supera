/**
 * Result type used across all layers.
 *
 * Functions that can fail return Result<T> instead of throwing.
 * Callers check `ok` to narrow: if true → data, if false → error.
 *
 * Inspired by Rust's Result. The reference pattern from action-tag-release-build
 * uses this pervasively — no exceptions for domain logic.
 */

export type Result<T> =
  | { readonly ok: true; readonly data: T; readonly error?: undefined }
  | { readonly ok: false; readonly error: unknown; readonly data?: undefined };

/** Void-success variant — when the operation has no return value. */
export type VoidResult =
  | { readonly ok: true; readonly error?: undefined }
  | { readonly ok: false; readonly error: unknown };

/** Create a success Result. */
export function success<T>(data: T): Result<T> {
  return { ok: true, data };
}

/** Create a void success Result. */
export function ok(): VoidResult {
  return { ok: true };
}

/** Create a failure Result. */
export function failure(error: unknown): { ok: false; error: unknown } {
  return { ok: false, error };
}
