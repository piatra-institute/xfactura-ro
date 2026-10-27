import Decimal from 'decimal.js';
import { z } from 'zod';

export const Amount = Decimal.clone({ precision: 40 });
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}
export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
  status = 422,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}

export const moneySchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/, 'Folosiți o sumă pozitivă cu cel mult două zecimale.')
  .transform((value) => new Amount(value).toFixed(2));
export const signedMoneySchema = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/)
  .transform((value) => new Amount(value).toFixed(2));
export const money = (value: unknown) => moneySchema.parse(value);
export const toBani = (value: string) =>
  BigInt(new Amount(signedMoneySchema.parse(value)).mul(100).toFixed(0));
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }, 'Dată calendaristică invalidă.');
export const idSchema = z.uuid();
export const accountCodeSchema = z.string().regex(/^[1-9]\d{1,3}(?:\.[A-Z0-9_-]{1,24}){0,4}$/);
export const fromBani = (value: bigint) => new Amount(value.toString()).div(100).toFixed(2);
