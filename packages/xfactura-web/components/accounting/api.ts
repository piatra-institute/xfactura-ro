type ErrorBody = {
  error?: { code?: string; message?: string; fields?: { path: string; message: string }[] };
};
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
const pending = new Map<string, string>();
export const companyPath = (id: string) => `/api/accounting/v1/companies/${encodeURIComponent(id)}`;

async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    const error = body as ErrorBody;
    const fields = error.error?.fields?.map((field) => `${field.path}: ${field.message}`).join(' ');
    throw new ApiError(
      fields || error.error?.message || 'Operațiunea nu a putut fi finalizată.',
      response.status,
      error.error?.code,
    );
  }
  return body as T;
}
export async function get<T>(path: string, signal?: AbortSignal) {
  return read<T>(await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal }));
}
export async function command<T>(path: string, body: unknown, method = 'POST') {
  const serialized = JSON.stringify(body);
  const signature = `${method}:${path}:${serialized}`;
  const key = pending.get(signature) ?? crypto.randomUUID();
  pending.set(signature, key);
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: serialized,
  });
  const result = await read<T>(response);
  pending.delete(signature);
  return result;
}
/** Invokes a company capability; the same input retried reuses its idempotency key. */
export function invoke<T>(companyId: string, operation: string, input: unknown = {}) {
  return command<T>(`${companyPath(companyId)}/capabilities/${operation}`, input);
}
export async function upload(companyId: string, file: File) {
  const body = new FormData();
  body.set('file', file);
  return read<{ id: string }>(
    await fetch(`${companyPath(companyId)}/evidence`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body,
    }),
  );
}
export async function signIn(email: string, password: string) {
  const response = await fetch('/api/accounting/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'same-origin',
  });
  if (!response.ok)
    throw new ApiError('Emailul sau parola nu sunt corecte. Încercați din nou.', response.status);
}
export async function signOut() {
  const response = await fetch('/api/accounting/auth/sign-out', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok)
    throw new ApiError('Deconectarea nu a reușit. Încercați din nou.', response.status);
  pending.clear();
}
export function formatMoney(value: string, currency = 'RON') {
  const negative = value.startsWith('-');
  const [whole, fraction = '00'] = value.replace('-', '').split('.');
  return `${negative ? '−' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${fraction.padEnd(2, '0')} ${currency}`;
}
export function field(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}
export function amountField(data: FormData, name: string) {
  return field(data, name).replace(',', '.');
}
