/** A rejected business rule. `code` is stable for callers; `message` is Romanian user-facing text. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
  status = 422,
  details?: unknown,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status, details);
}
