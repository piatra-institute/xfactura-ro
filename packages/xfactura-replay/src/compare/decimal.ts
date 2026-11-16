/** Decimal comparison arithmetic only: no rounding, tax calculation or numeric coercion. */
export type Decimal = { units: bigint; scale: number };

export function decimal(value: string): Decimal | null {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '';
  return {
    units: BigInt(`${match[1] === '-' ? '-' : ''}${match[2] ?? '0'}${fraction}`),
    scale: fraction.length,
  };
}

export function decimalText({ units, scale }: Decimal): string {
  if (units === 0n) return '0';
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  if (scale === 0) return sign + digits;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
}

export function subtract(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    units:
      left.units * 10n ** BigInt(scale - left.scale) -
      right.units * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

export function amount(value: string | undefined | null): string | null {
  const parsed = value == null ? null : decimal(value);
  return parsed && decimalText(parsed);
}

export function delta(engine: string, source: string): string {
  return decimalText(subtract(decimal(engine)!, decimal(source)!));
}

/** Adding recorded components for a comparison is not recomputing a treatment's amounts. */
export function add(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  const b = decimal(right)!;
  return decimalText(subtract(decimal(left)!, { ...b, units: -b.units }));
}
