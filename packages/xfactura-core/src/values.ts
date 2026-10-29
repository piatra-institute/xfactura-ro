import Decimal from 'decimal.js';
import { z } from 'zod';
import { isLocalDate } from './time';

// Decimal schemas shared by the document parsers: amounts as 2-decimal strings, exactly as the
// documents state them. Ledger arithmetic itself uses bigint minor units (see ./money).
export const Amount = Decimal.clone({ precision: 40 });
export const moneySchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/, 'Folosiți o sumă pozitivă cu cel mult două zecimale.')
  .transform((value) => new Amount(value).toFixed(2));
export const signedMoneySchema = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/)
  .transform((value) => new Amount(value).toFixed(2));
export const dateSchema = z
  .string()
  // An explicit boolean keeps the output a plain string, as the parsers expect.
  .refine((value): boolean => isLocalDate(value), 'Dată calendaristică invalidă.');
export const toBani = (value: string) =>
  BigInt(new Amount(signedMoneySchema.parse(value)).mul(100).toFixed(0));
export const fromBani = (value: bigint) => new Amount(value.toString()).div(100).toFixed(2);
