import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { canonical, hashOf, sha256Hex } from '../src/hash';

describe('canonical', () => {
  test('published vectors', () => {
    expect(canonical({ b: 1, a: [true, null, 'x'], c: {} })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{}}',
    );
    expect(canonical({ amount: 125n, negative: -3n })).toBe('{"amount":"125","negative":"-3"}');
    expect(canonical({ kept: 0, skipped: undefined })).toBe('{"kept":0}');
    expect(canonical(-0)).toBe('0');
    expect(canonical('Ședință „x”')).toBe('"Ședință „x”"');
  });

  test('orders keys by UTF-16 code units, not by locale', () => {
    // A Romanian collation would order these a, s, ș, Z.
    expect(canonical({ ș: 1, s: 2, Z: 3, a: 4 })).toBe('{"Z":3,"a":4,"s":2,"ș":1}');
  });

  test('rejects values JSON cannot represent exactly', () => {
    expect(() => canonical(Number.NaN)).toThrow();
    expect(() => canonical(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonical([undefined])).toThrow();
    expect(() => canonical(new Date(0))).toThrow();
    expect(() => canonical(new Map())).toThrow();
    expect(() => canonical(() => 1)).toThrow();
  });

  test('is independent of key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonical(reversed)).toBe(canonical(record));
      }),
    );
  });

  test('round-trips JSON values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(canonical(JSON.parse(canonical(value)))).toBe(canonical(value));
      }),
    );
  });
});

describe('sha256', () => {
  test('known answer', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('matches the platform implementation on canonical text', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonical(value);
        expect(hashOf(value)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      }),
    );
  });
});
