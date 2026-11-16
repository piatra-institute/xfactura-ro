// bun scripts/rules/rollover.ts [--date YYYY-MM-DD] [--markdown] [--check FILE | --write FILE]
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { canonical } from '../../packages/xfactura-core/src/hash';
import { roRegister } from '../../packages/xfactura-core/src/ro/register';
import type {
  GapReason,
  ParameterRegister,
  ParameterVersion,
} from '../../packages/xfactura-core/src/rules';
import {
  bucharestDate,
  parseLocalDate,
  type LocalDate,
} from '../../packages/xfactura-core/src/time';
import { ruleFamilies } from './families';

export const startMarker = '<!-- rollover:start -->';
export const endMarker = '<!-- rollover:end -->';

export type RolloverState = 'COVERED' | GapReason;
export interface RolloverRow {
  key: string;
  family: string;
  scope: Record<string, string> | null;
  state: RolloverState;
  versions: readonly ParameterVersion[];
  context: 'covering' | 'expired' | 'future' | 'none';
}

export function nextJanuary(today: LocalDate = bucharestDate(Date.now())): LocalDate {
  return parseLocalDate(`${String(Number(today.slice(0, 4)) + 1).padStart(4, '0')}-01-01`);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Resolve every recorded scope without attestations. Non-covering versions are context only. */
export function rolloverRows(
  date: LocalDate,
  register: ParameterRegister = roRegister(),
  families: ReadonlyMap<string, string> = ruleFamilies,
): RolloverRow[] {
  return register
    .keys()
    .sort(compare)
    .flatMap((key): RolloverRow[] => {
      const definition = register.definition(key);
      const family = families.get(key);
      if (!family) throw new Error(`No rule family for ${key}. Update scripts/rules/families.ts.`);
      const versions = register.versions.filter((version) => version.key === key);
      // Include scopes known only from withdrawn versions: they now resolve to NO_VERSION.
      const scopes = new Map(versions.map((version) => [canonical(version.scope), version.scope]));
      if (!definition.scope.length) scopes.set(canonical({}), {});
      if (!scopes.size) {
        return [{ key, family, scope: null, state: 'NO_VERSION', versions: [], context: 'none' }];
      }
      return [...scopes.entries()]
        .sort(([a], [b]) => compare(a, b))
        .map(([scopeKey, scope]) => {
          const resolution = register.resolve(key, {
            axis: definition.axis,
            date,
            scope,
            mode: 'preview',
          });
          const active = versions.filter(
            (version) => !version.withdrawn && canonical(version.scope) === scopeKey,
          );
          const covering = active.filter(
            (version) => version.from <= date && (version.to === null || date <= version.to),
          );
          const base = {
            key,
            family,
            scope,
            state: resolution.ok ? ('COVERED' as const) : resolution.gap.reason,
          };
          if (covering.length) return { ...base, versions: covering, context: 'covering' as const };

          // Show the last ended interval, or the first future one if nothing has started. Neither
          // supplies a value: the state above is always the resolver's answer for the requested date.
          const expired = active
            .filter((version) => version.to !== null && version.to < date)
            .sort((a, b) => compare(b.to!, a.to!));
          const future = active
            .filter((version) => version.from > date)
            .sort((a, b) => compare(a.from, b.from));
          const context = expired.length ? 'expired' : future.length ? 'future' : 'none';
          return { ...base, versions: (expired.length ? expired : future).slice(0, 1), context };
        });
    });
}

/** Count keys once per state, even when a parameter has several scopes in that state. */
export function stateCounts(rows: readonly RolloverRow[]): Record<RolloverState, number> {
  const states: RolloverState[] = [
    'COVERED',
    'NO_VERSION',
    'BEYOND_HORIZON',
    'INSUFFICIENT_REVIEW',
    'AMBIGUOUS',
  ];
  return Object.fromEntries(
    states.map((state) => [
      state,
      new Set(rows.filter((row) => row.state === state).map((row) => row.key)).size,
    ]),
  ) as Record<RolloverState, number>;
}

function cells(row: RolloverRow): string[] {
  return [
    row.key,
    row.family,
    row.scope === null
      ? 'no recorded scope'
      : Object.entries(row.scope)
          .sort(([a], [b]) => compare(a, b))
          .map(([key, value]) => `${key}=${value}`)
          .join(', ') || '—',
    row.state,
    row.versions.map((version) => `${row.context}: ${version.id}`).join('; ') || '—',
    row.versions
      .map((version) =>
        version.to === null ? `reviewedThrough=${version.reviewedThrough}` : `to=${version.to}`,
      )
      .join('; ') || '—',
    row.versions.map((version) => version.status).join('; ') || '—',
    row.versions.map((version) => version.clauses.join('; ')).join(' / ') || '—',
  ];
}

export function renderTable(
  date: LocalDate,
  rows: readonly RolloverRow[],
  markdown = false,
): string {
  const header = [
    'Key',
    'Family',
    'Scope',
    `State at ${date} (preview)`,
    'Version context',
    'Review horizon / end (inclusive)',
    'Review status',
    'Cited clauses',
  ];
  const records = [header, ...rows.map(cells)];
  if (!markdown) return records.map((record) => record.join('\t')).join('\n') + '\n';
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('\\', '\\\\')
      .replaceAll('|', '\\|')
      .replace(/\r?\n/g, '<br>');
  records.splice(
    1,
    0,
    header.map(() => '---'),
  );
  return records.map((record) => `| ${record.map(escape).join(' | ')} |`).join('\n') + '\n';
}

/** Replace only the generated region; missing or duplicate markers must never erase prose. */
export function replaceTable(document: string, table: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker);
  if (
    start < 0 ||
    end < start ||
    document.indexOf(startMarker, start + startMarker.length) !== -1 ||
    document.indexOf(endMarker, end + endMarker.length) !== -1
  ) {
    throw new Error(`Expected exactly one ordered pair of ${startMarker} and ${endMarker}.`);
  }
  return (
    document.slice(0, start + startMarker.length) +
    '\n\n' +
    table.trimEnd() +
    '\n\n' +
    document.slice(end)
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      markdown: { type: 'boolean' },
      check: { type: 'string' },
      write: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: bun scripts/rules/rollover.ts [--date YYYY-MM-DD] [--markdown] [--check FILE | --write FILE]\nThe date defaults to the next 1 January in Europe/Bucharest. --check and --write use the marked Markdown table.',
    );
    return;
  }
  if (values.check !== undefined && values.write !== undefined)
    throw new Error('Use either --check or --write.');
  const date = values.date === undefined ? nextJanuary() : parseLocalDate(values.date);
  const rows = rolloverRows(date);
  const markdown = renderTable(date, rows, true);
  const file = values.check ?? values.write;
  if (file !== undefined) {
    const document = await readFile(file, 'utf8');
    const updated = replaceTable(document, markdown);
    if (values.check !== undefined) {
      if (updated !== document) {
        console.error(
          `Rollover table differs in ${file}. Regenerate with --date ${date} --markdown --write ${file}.`,
        );
        process.exitCode = 1;
        return;
      }
      console.error(`Rollover table matches ${file} for ${date}.`);
    } else if (updated !== document) await writeFile(file, updated);
  }
  if (values.check === undefined)
    process.stdout.write(values.markdown ? markdown : renderTable(date, rows));
  const counts = Object.entries(stateCounts(rows))
    .map(([state, count]) => `${state}=${count}`)
    .join(', ');
  console.error(
    `${date}: ${new Set(rows.map((row) => row.key)).size} keys; ${counts}. Keys with mixed scopes count in each applicable state.`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
