import { ZodError } from 'zod';
import { DomainError } from './domain';

/** The REST and MCP transports expose the same bounded, credential-free errors. */
export function accountingError(error: unknown) {
  if (error instanceof DomainError)
    return { status: error.status, error: { code: error.code, message: error.message } };
  if (error instanceof ZodError)
    return {
      status: 422,
      error: {
        code: 'VALIDATION',
        message: 'Datele nu sunt valide.',
        fields: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  if (error instanceof SyntaxError)
    return { status: 400, error: { code: 'JSON', message: 'Conținut JSON invalid.' } };
  let cause = error;
  let code: string | undefined;
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const details = cause as { code?: string; cause?: unknown };
    if (details.code) {
      code = details.code;
      break;
    }
    cause = details.cause;
  }
  if (code === 'SQLITE_CONSTRAINT_UNIQUE')
    return {
      status: 409,
      error: {
        code: 'DUPLICATE',
        message: 'Înregistrarea există deja. Reîncărcați și verificați datele.',
      },
    };
  if (code?.startsWith('SQLITE_CONSTRAINT'))
    return {
      status: 409,
      error: {
        code: 'ACCOUNTING_CONSTRAINT',
        message: 'Operațiunea încalcă protecția perioadei, aprobării sau înregistrării contabile.',
      },
    };
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT')
    return {
      status: 503,
      error: { code: 'BUSY', message: 'Baza de date este ocupată. Reîncercați cu aceeași cheie.' },
    };
  console.error('Accounting request failed', { code: code ?? 'internal' });
  return {
    status: 500,
    error: {
      code: 'INTERNAL',
      message: 'Operațiunea nu a putut fi finalizată. Puteți reîncerca folosind aceeași cerere.',
    },
  };
}
