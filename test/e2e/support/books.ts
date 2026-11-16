import { expect, type Page } from '@playwright/test';

/** Browser tests arrange synthetic books through the same public capability contract as agents. */
export async function capability<T>(
  page: Page,
  operation: string,
  input: unknown = {},
  token?: string,
): Promise<T> {
  const company = new URL(page.url()).searchParams.get('company');
  expect(company).toBeTruthy();
  const response = await page.request.post(
    `/api/accounting/v1/companies/${company}/capabilities/${operation}`,
    {
      headers: {
        Origin: new URL(page.url()).origin,
        'Idempotency-Key': crypto.randomUUID(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      data: input,
    },
  );
  const body: unknown = await response.json();
  expect(response.ok(), `${operation}: ${JSON.stringify(body)}`).toBe(true);
  return body as T;
}

export async function evidence(
  page: Page,
  filename: string,
  text: string,
  mediaType = 'text/plain',
) {
  return capability<{ id: string }>(page, 'evidence.record', {
    filename,
    mediaType,
    base64: Buffer.from(text).toString('base64'),
  });
}
