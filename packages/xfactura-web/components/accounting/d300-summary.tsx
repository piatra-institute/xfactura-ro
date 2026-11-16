'use client';

import { d300Rows, type D300Row } from 'xfactura-core/ro/declarations/d300';
import { WorkDetails } from './work-details';

const captions = new Map<string, D300Row>(d300Rows.map((row) => [row.element, row]));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Show only the rows retained by prepare. Missing rows stay absent; values are neither
 * completed nor recalculated, including the two balances already computed by the engine. */
export function D300Summary({ summary }: { summary: Record<string, unknown> }) {
  const { rows, balances, ...details } = summary;
  return (
    <>
      <WorkDetails value={details} />
      {record(rows) ? <EngineRows title="Rândurile declarației" values={rows} /> : null}
      {record(balances) ? <EngineRows title="Soldurile declarației" values={balances} /> : null}
      <WorkDetails value={{}} technical={{ rows, balances }} />
    </>
  );
}

function EngineRows({ title, values }: { title: string; values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  return (
    <div className="acc-table-scroll">
      <table className="acc-d300-values">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Rând</th>
            <th scope="col">Valoare din motor</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([element, value]) => {
            const row = captions.get(element);
            return (
              <tr key={element} data-d300-element={element}>
                <td>
                  {row?.label ?? `Rând ${element}`}
                  <span className="acc-d300-column">
                    {row?.column === 1
                      ? 'Bază impozabilă (lei)'
                      : row?.column === 2
                        ? 'TVA (lei)'
                        : element}
                  </span>
                </td>
                <td>
                  {typeof value === 'number' || typeof value === 'string'
                    ? String(value)
                    : 'Valoare indisponibilă'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!entries.length ? (
        <p className="acc-hint">Motorul nu a transmis valori pentru aceste rânduri.</p>
      ) : null}
    </div>
  );
}
