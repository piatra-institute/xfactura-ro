import { describe, expect, test } from 'bun:test';
import {
  calculateD390,
  checkD390,
  d390Text,
  writeD390,
  type D390,
} from '../src/ro/declarations/d390';

const model: D390 = {
  period: { year: 2026, month: 10 },
  rectification: false,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  company: { cui: '18547290', name: 'Exemplu Servicii SRL', address: 'Str. Lungă 10, Galați' },
  operations: [
    { type: 'S', country: 'IE', code: '6388047V', name: 'Supplier Limited', base: 498 },
    { type: 'P', country: 'DE', code: '123456788', name: 'Kunde GmbH', base: 150 },
  ],
};

describe('D390', () => {
  test('sums the bases by type and the control sum as operations plus bases', () => {
    const { bases, total, count, control } = calculateD390(model);
    expect([bases.S, bases.P, total, count, control]).toEqual([498n, 150n, 648n, 2n, 650n]);
    const xml = writeD390(model);
    expect(xml).toContain('totalPlata_A="650"');
    expect(xml).toContain(
      '<rezumat nr_pag="0" nrOPI="2" bazaL="0" bazaT="0" bazaA="0" bazaP="150" bazaS="498" bazaR="0" total_baza="648"/>',
    );
  });

  test('keeps only the characters the structure accepts', () => {
    expect(d390Text('Str. Lungă 10, Galați — Ștefan & Co')).toBe('Str. Lunga 10 Galati Stefan Co');
  });

  test('requires partner codes for supplies, unique partners and a base', () => {
    expect(
      checkD390({
        ...model,
        operations: [
          { type: 'P', country: 'DE', name: 'Fără cod', base: 10 },
          { type: 'S', country: 'IE', code: '6388047V', name: 'Supplier Limited', base: 5 },
          { type: 'S', country: 'IE', code: '6388047V', name: 'Supplier Limited', base: 0 },
        ],
      }).map((check) => check.code),
    ).toEqual(['D390_CODE', 'D390_DUPLICATE', 'D390_BASE']);
    expect(checkD390({ ...model, operations: [] }).map((check) => check.code)).toEqual([
      'D390_EMPTY',
    ]);
  });
});
