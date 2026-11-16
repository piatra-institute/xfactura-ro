'use client';

import { useAccountingNavigation } from './navigation';
import { formatAmount, useOpenedHeading } from './presentation';
import { State } from './register-common';
import { useAccountingData } from './use-data';
import { useWorkspace } from './workspace';

type PayrollRun = {
  id: string;
  month: string;
  round: number;
  workingDays: number;
  state: string;
  issues: number;
  lines: {
    name: string;
    cash: string;
    vouchers: string;
    inKind: string;
    cas: string;
    cass: string;
    tax: string;
    net: string;
  }[];
};

/** The engine's payroll run states (`payrollRunStates`). */
const states: Record<string, string> = {
  prepared: 'Pregătit',
  superseded: 'Înlocuit de o rundă nouă',
};

/** Payroll runs, read-only; one run opens below the list with its lines. */
export default function Payroll() {
  const { can } = useWorkspace();
  const { params, filter } = useAccountingNavigation();
  const list = useAccountingData<PayrollRun[]>('payroll.runs.list', {}, true, true);
  const runId = params.get('payrollRun') ?? '';
  return (
    <section>
      <h3>Salarii</h3>
      <State
        loading={list.loading}
        error={list.error}
        empty={!!list.data && list.data.length === 0}
      >
        Nu există state de plată calculate.
      </State>
      {list.data && list.data.length > 0 ? (
        <div className="acc-table-scroll">
          <table className="acc-register-table">
            <thead>
              <tr>
                <th scope="col">Luna</th>
                <th scope="col">Runda</th>
                <th scope="col" className="acc-text">
                  Stare
                </th>
                <th scope="col">Zile lucrătoare</th>
                <th scope="col">Probleme</th>
                <th scope="col" className="acc-text">
                  Detalii
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((row) => (
                <tr key={row.id}>
                  <td className="acc-text" data-label="Luna">
                    {row.month}
                  </td>
                  <td data-label="Runda">{row.round}</td>
                  <td className="acc-text" data-label="Stare">
                    {states[row.state] ?? row.state}
                  </td>
                  <td data-label="Zile lucrătoare">{row.workingDays}</td>
                  <td data-label="Probleme">{row.issues}</td>
                  <td className="acc-text" data-label="Detalii">
                    {can('payroll.runs.get') ? (
                      <button
                        className="acc-secondary"
                        aria-label={`Deschide statul de plată ${row.month}, runda ${row.round}`}
                        onClick={() => filter({ payrollRun: row.id })}
                      >
                        Deschide
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {runId && can('payroll.runs.get') ? <Run runId={runId} /> : null}
    </section>
  );
}

function Run({ runId }: { runId: string }) {
  const { filter } = useAccountingNavigation();
  const detail = useAccountingData<PayrollRun>('payroll.runs.get', { runId });
  const run = detail.data;
  const heading = useOpenedHeading(Boolean(run));
  return (
    <section>
      <h4 ref={heading} tabIndex={-1} className="acc-opened-heading">
        Stat de plată{run ? ` ${run.month}, runda ${run.round}` : ''}
      </h4>
      <State loading={detail.loading} error={detail.error} />
      {run ? (
        <>
          <dl className="acc-review-meta">
            <div>
              <dt>Stare</dt>
              <dd>{states[run.state] ?? run.state}</dd>
            </div>
            <div>
              <dt>Zile lucrătoare</dt>
              <dd>{run.workingDays}</dd>
            </div>
            <div>
              <dt>Probleme</dt>
              <dd>{run.issues}</dd>
            </div>
          </dl>
          {run.lines.length === 0 ? (
            <p className="acc-empty">Statul de plată nu are linii.</p>
          ) : (
            <div className="acc-table-scroll">
              <table className="acc-register-table">
                <caption>Sume în RON</caption>
                <thead>
                  <tr>
                    <th scope="col">Salariat</th>
                    <th scope="col">Brut în bani</th>
                    <th scope="col">Tichete</th>
                    <th scope="col">Beneficii în natură</th>
                    <th scope="col">CAS</th>
                    <th scope="col">CASS</th>
                    <th scope="col">Impozit</th>
                    <th scope="col">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {run.lines.map((line, index) => (
                    <tr key={index}>
                      <td className="acc-text" data-label="Salariat">
                        {line.name}
                      </td>
                      <td data-label="Brut în bani">{formatAmount(line.cash)}</td>
                      <td data-label="Tichete">{formatAmount(line.vouchers)}</td>
                      <td data-label="Beneficii în natură">{formatAmount(line.inKind)}</td>
                      <td data-label="CAS">{formatAmount(line.cas)}</td>
                      <td data-label="CASS">{formatAmount(line.cass)}</td>
                      <td data-label="Impozit">{formatAmount(line.tax)}</td>
                      <td data-label="Net">{formatAmount(line.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      <button className="acc-secondary" onClick={() => filter({ payrollRun: null })}>
        Închide statul de plată
      </button>
    </section>
  );
}
