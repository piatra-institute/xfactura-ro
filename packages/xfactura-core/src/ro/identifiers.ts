/**
 * The control digit of a Romanian fiscal identification code (CUI/CIF): the digits before it,
 * padded to nine, are weighted by 7 5 3 2 1 7 5 3 2; ten times their sum modulo 11 is the
 * control digit, with 10 written as 0.
 */
export function isValidCui(text: string): boolean {
  const digits = text.trim().toUpperCase().replace(/^RO/, '');
  if (!/^[1-9]\d{1,9}$/.test(digits)) return false;
  const body = digits.slice(0, -1).padStart(9, '0');
  const weights = [7, 5, 3, 2, 1, 7, 5, 3, 2];
  const total = weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0);
  return ((total * 10) % 11) % 10 === Number(digits.at(-1));
}

/**
 * A personal numeric code (CNP): thirteen digits whose first twelve, weighted by
 * 2 7 9 1 4 6 3 5 8 2 7 9, sum to the control digit modulo 11, with 10 written as 1.
 * A CNP identifies a person; callers must not log or display it beyond its purpose.
 */
export function isValidCnp(text: string): boolean {
  const digits = text.trim();
  if (!/^[1-9]\d{12}$/.test(digits)) return false;
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const total = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0);
  const control = total % 11;
  return (control === 10 ? 1 : control) === Number(digits[12]);
}

/**
 * An IBAN (ISO 13616): country code, check digits and account, the first four characters moved
 * to the end and letters read as 10–35, is 1 modulo 97. A Romanian IBAN has 24 characters.
 */
export function isValidIban(text: string): boolean {
  const iban = text.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith('RO') && iban.length !== 24) return false;
  const digits = [...(iban.slice(4) + iban.slice(0, 4))]
    .map((char) => (/\d/.test(char) ? char : String(char.charCodeAt(0) - 55)))
    .join('');
  return BigInt(digits) % 97n === 1n;
}
