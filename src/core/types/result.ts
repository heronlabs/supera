export type Result<T> =
  | { readonly ok: true; readonly data: T; readonly error?: undefined }
  | { readonly ok: false; readonly error: unknown; readonly data?: undefined };

export type VoidResult =
  | { readonly ok: true; readonly error?: undefined }
  | { readonly ok: false; readonly error: unknown };

export function success<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function ok(): VoidResult {
  return { ok: true };
}

export function failure(error: unknown): { ok: false; error: unknown } {
  return { ok: false, error };
}
