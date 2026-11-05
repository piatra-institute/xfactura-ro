import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { directToolLimit, directTools } from '../../source/engine/http/mcp';
import {
  dataClasses,
  describe as contractOf,
  inputSchema,
  outputSchema,
  riskOf,
  toolsets,
  type Operation,
} from '../../source/engine/kernel/operations';
import { scenario, type Scenario } from './scenario';

let s: Scenario;
let operations: Operation[];
beforeAll(async () => {
  s = await scenario();
  operations = s.engine.operations.all();
});
afterAll(async () => {
  await s?.dispose();
});

const ids = (filter: (operation: Operation) => boolean) =>
  operations.filter(filter).map((operation) => operation.id);

describe('operation metadata', () => {
  test('every operation tells agents what it is, in English, beside its Romanian description', () => {
    for (const operation of operations) {
      const where = `${operation.id}: ${operation.summary}`;
      expect(operation.summary.length, where).toBeGreaterThan(20);
      expect(operation.summary.length, where).toBeLessThanOrEqual(240);
      expect(operation.summary, where).toMatch(/^[A-Z].*\.$/);
      expect(operation.summary, where).not.toMatch(/\n/);
      // Romanian names of registers and returns stay in parentheses.
      expect(operation.summary.replace(/\([^)]*\)/g, ''), where).not.toMatch(/[ăâîșțşţĂÂÎȘȚŞŢ]/);
      expect(operation.summary, where).not.toBe(operation.description);
      expect(toolsets, where).toContain(operation.toolset);
      expect(new Set(operation.dataClasses).size, where).toBe(operation.dataClasses.length);
      for (const kind of operation.dataClasses) expect(dataClasses, where).toContain(kind);
      expect(typeof operation.reversible, where).toBe('boolean');
      expect(typeof operation.externalEffect, where).toBe('boolean');
      expect(operation.risk, where).toBe(riskOf(operation));
    }
  });

  test('reads change nothing and stay inside the engine', () => {
    expect(
      ids(
        (operation) =>
          operation.effect === 'read' && (!operation.reversible || operation.externalEffect),
      ),
    ).toEqual([]);
  });

  test('agents never decide, configure or act for a person', () => {
    expect(
      ids(
        (operation) =>
          operation.agent &&
          (operation.approval === 'human' || ['authorize', 'manage'].includes(operation.effect)),
      ),
    ).toEqual([]);
  });

  test('what reaches ANAF (or VIES) says so', () => {
    expect(ids((operation) => operation.externalEffect)).toEqual([
      'parties.checkStatus',
      'parties.checkVies',
      'spv.connect.finish',
      'spv.refresh',
      'spv.submit',
      'spv.sync',
    ]);
  });

  test('what commits something final is not reversible', () => {
    expect(ids((operation) => !operation.reversible)).toEqual([
      'actions.approve',
      'actions.execute',
      'actions.reject',
      'agents.revoke',
      'assets.dispose',
      'company.revoke',
      'declarations.recordOutcome',
      'declarations.recordSubmission',
      'documents.link',
      'ledger.post',
      'policies.revoke',
      'sales.issue',
      'spv.submit',
      'templates.revoke',
    ]);
  });

  test('risk follows from what an operation declares', () => {
    const risk = (
      effect: Operation['effect'],
      dataClasses: Operation['dataClasses'],
      reversible = true,
      externalEffect = false,
    ) => riskOf({ effect, dataClasses, reversible, externalEffect });
    expect(risk('read', ['books'])).toBe('low');
    expect(risk('read', ['payroll', 'personal'])).toBe('medium');
    expect(risk('prepare', ['books', 'evidence'])).toBe('low');
    expect(risk('prepare', ['books'], true, true)).toBe('medium');
    expect(risk('prepare', ['personal'])).toBe('medium');
    expect(risk('prepare', ['credentials'])).toBe('high');
    expect(risk('execute', ['books'], false)).toBe('high');
    expect(risk('authorize', ['books'])).toBe('high');
    expect(risk('manage', ['books'])).toBe('high');
    expect(risk('execute', ['books'], false, true)).toBe('critical');
    expect(s.engine.operations.get('spv.submit').risk).toBe('critical');
    expect(s.engine.operations.get('ledger.post').risk).toBe('high');
    expect(s.engine.operations.get('invoices.recognize.propose').risk).toBe('low');
    expect(s.engine.operations.get('payroll.recognize.propose').risk).toBe('medium');
  });

  test('a treatment’s operations take its toolset and data', () => {
    for (const treatment of s.engine.proposals.allTreatments())
      for (const suffix of ['propose', 'revise']) {
        const operation = s.engine.operations.get(`${treatment.id}.${suffix}`);
        expect(operation.toolset).toBe(treatment.toolset ?? 'books');
        expect(operation.dataClasses).toEqual(treatment.dataClasses ?? ['books']);
        expect(operation.summary).toContain(treatment.summary);
        // `.propose` is the typed form of `proposals.propose`; `.revise` revises it.
        expect(operation.variantOf).toBe(
          suffix === 'revise' ? `${treatment.id}.propose` : 'proposals.propose',
        );
      }
  });

  test('every toolset has operations', () => {
    for (const toolset of toolsets)
      expect(ids((operation) => operation.toolset === toolset).length, toolset).toBeGreaterThan(0);
  });
});

describe('output contracts', () => {
  test('every output is a JSON object and every list is { items, next }', () => {
    for (const operation of operations) {
      const schema = outputSchema(operation) as {
        type?: string;
        properties?: Record<string, { type?: string | string[] }>;
        additionalProperties?: unknown;
      };
      expect(schema.type, operation.id).toBe('object');
      // An output lists what it guarantees; a newer engine may add fields.
      expect(schema.additionalProperties, operation.id).not.toBe(false);
      if (schema.properties?.items) {
        expect(schema.properties.items.type, operation.id).toBe('array');
        expect(schema.properties.next?.type, operation.id).toEqual(['string', 'null']);
      }
    }
  });

  test('schemas name only string formats standard validators know, base64 by its encoding', () => {
    const formats = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'format' && typeof item === 'string') formats.add(item);
        walk(item);
      }
    };
    for (const operation of operations) {
      walk(inputSchema(operation));
      walk(outputSchema(operation));
    }
    // What the MCP SDKs' validator (Ajv with its formats) checks without a warning.
    expect([...formats].sort()).toEqual(['date', 'date-time', 'email', 'uuid']);
    const record = inputSchema(s.engine.operations.get('evidence.record')) as {
      properties: { base64: Record<string, unknown> };
    };
    expect(record.properties.base64).toMatchObject({
      type: 'string',
      contentEncoding: 'base64',
      pattern: expect.any(String),
    });
    expect(record.properties.base64.format).toBeUndefined();
  });

  test('describe advertises the metadata with both schemas', () => {
    const contract = contractOf(s.engine.operations.get('ledger.post'));
    expect(contract).toMatchObject({
      id: 'ledger.post',
      toolset: 'review',
      dataClasses: ['books'],
      effect: 'execute',
      approval: 'exact-version',
      reversible: false,
      externalEffect: false,
      risk: 'high',
    });
    expect(contract.inputSchema.type).toBe('object');
    expect(contract.outputSchema.type).toBe('object');
  });
});

describe('MCP tool listing', () => {
  test('a credential with every agent operation lists its intake and review loop, within the limit', () => {
    const granted = s.engine.operations.grantable();
    expect(granted.length).toBeGreaterThan(directToolLimit);
    const listed = directTools(
      granted,
      (id) => s.engine.operations.get(id).variantOf !== undefined,
    );
    const core = granted.filter(
      (operation) => ['inbox', 'review'].includes(operation.toolset) && !operation.variantOf,
    );
    // Nothing of the core is cut: past the limit, the catalogue needs another entry point.
    expect(core.length).toBeLessThanOrEqual(directToolLimit);
    expect(listed).toEqual(core);
    expect(listed.map((operation) => operation.id)).toContain('ledger.post');
    expect(listed.map((operation) => operation.id)).toContain('spv.sync');
  });

  test('a small credential lists every operation it has', () => {
    const granted = s.engine.operations
      .grantable()
      .filter((operation) => operation.toolset === 'bank');
    expect(granted.length).toBeLessThanOrEqual(directToolLimit);
    expect(directTools(granted, () => true)).toEqual(granted);
  });
});
