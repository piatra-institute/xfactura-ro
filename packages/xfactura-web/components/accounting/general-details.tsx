import type { GeneralBody } from 'xfactura-api/accounting';
import type { Overview } from 'xfactura-api/accounting-types';
import { Amount } from 'xfactura-api/accounting';
import { formatMoney } from './api';

export default function GeneralDetails({
  body,
  state,
  path,
  showJournal,
}: {
  body: GeneralBody;
  state: Overview;
  path: string;
  showJournal: (id: string, financialYearId?: string) => void;
}) {
  const invoice = body.invoice,
    settlement = body.settlement,
    credit = invoice?.credit;
  if (body.accrual)
    return (
      <dl className="acc-review-meta">
        <div>
          <dt>Furnizor</dt>
          <dd>
            {body.accrual.supplier.name} · CUI {body.accrual.supplier.taxId}
          </dd>
        </div>
        <div>
          <dt>Perioada serviciilor</dt>
          <dd>
            {body.accrual.serviceFrom} — {body.accrual.serviceTo}
          </dd>
        </div>
        <div>
          <dt>Data documentului</dt>
          <dd>{body.accrual.evidenceDate}</dd>
        </div>
        {body.accrual.deferredTax !== '0.00' ? (
          <div>
            <dt>TVA în așteptarea facturii</dt>
            <dd>{formatMoney(body.accrual.deferredTax)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Justificare</dt>
          <dd>{body.accrual.reason}</dd>
        </div>
      </dl>
    );
  if (invoice)
    return (
      <>
        <dl className="acc-review-meta">
          {invoice.accrualMatch ? (
            <div>
              <dt>Factura primită la</dt>
              <dd>{invoice.accrualMatch.receivedDate}</dd>
            </div>
          ) : null}
          {credit ? (
            <>
              <div>
                <dt>Factura originală</dt>
                <dd>
                  <button
                    className="acc-secondary"
                    onClick={() =>
                      showJournal(credit.originalJournalId, credit.originalFinancialYearId)
                    }
                  >
                    {state.invoiceLabels[credit.originalInvoiceId]?.number ??
                      'Înregistrarea originală'}
                  </button>
                </dd>
              </div>
              <div>
                <dt>Motivul corecției</dt>
                <dd>{credit.reason}</dd>
              </div>
              <div>
                <dt>Data acordului</dt>
                <dd>{credit.decisionDate}</dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>Data serviciului</dt>
            <dd>{invoice.serviceDate}</dd>
          </div>
          <div>
            <dt>{credit ? 'Exigibilitate inițială TVA' : 'Exigibilitate TVA'}</dt>
            <dd>{invoice.taxPointDate}</dd>
          </div>
          {invoice.tax !== '0.00' ? (
            <div>
              <dt>
                {credit ? 'Corecție ' : ''}
                {invoice.direction === 'sale' ? 'TVA colectată' : 'TVA dedusă'}
              </dt>
              <dd>
                {formatMoney(
                  new Amount(invoice.direction === 'sale' ? invoice.tax : invoice.deductibleTax)
                    .mul(credit ? -1 : 1)
                    .toFixed(2),
                )}
              </dd>
            </div>
          ) : null}
          {invoice.treatmentEvidenceId !== body.evidenceId ? (
            <div>
              <dt>{invoice.accrualMatch ? 'Document de primire' : 'Document pentru tratament'}</dt>
              <dd>
                <a href={`${path}/evidence/${invoice.treatmentEvidenceId}`} download>
                  Descarcă
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
        {invoice.accrualMatch ? (
          <div className="acc-table-scroll">
            <table>
              <caption>Servicii deja înregistrate</caption>
              <thead>
                <tr>
                  <th>Angajament</th>
                  <th>Sold disponibil</th>
                  <th>Sumă alocată</th>
                  <th>Sold rămas</th>
                </tr>
              </thead>
              <tbody>
                {invoice.accrualMatch.allocations.map((item) => (
                  <tr key={item.accrualId}>
                    <td>
                      <button
                        className="acc-secondary"
                        onClick={() =>
                          showJournal(item.originalJournalId, item.originalFinancialYearId)
                        }
                      >
                        {item.reference}
                      </button>
                    </td>
                    <td>{formatMoney(item.availableGross)}</td>
                    <td>{formatMoney(item.gross)}</td>
                    <td>{formatMoney(item.remainingGross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </>
    );
  if (settlement)
    return (
      <>
        <dl className="acc-review-meta">
          <div>
            <dt>Cont bancar sau casă</dt>
            <dd>
              {settlement.account} · {settlement.ledgerAccount}
            </dd>
          </div>
        </dl>
        {settlement.allocations.length ? (
          <div className="acc-table-scroll">
            <table>
              <caption>Alocarea mișcării</caption>
              <thead>
                <tr>
                  <th>Factură</th>
                  <th>Partener</th>
                  <th>Sumă stinsă</th>
                </tr>
              </thead>
              <tbody>
                {settlement.allocations.map((item) => (
                  <tr key={item.invoiceId}>
                    <td>
                      {state.invoiceLabels[item.invoiceId] ? (
                        <a
                          href={`${path}/evidence/${state.invoiceLabels[item.invoiceId].evidenceId}`}
                          download
                        >
                          {state.invoiceLabels[item.invoiceId].number}
                        </a>
                      ) : (
                        'Factură'
                      )}
                    </td>
                    <td>{state.invoiceLabels[item.invoiceId]?.counterparty}</td>
                    <td>{formatMoney(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {settlement.fee ? (
          <p>
            Comision bancar: {formatMoney(settlement.fee.amount)} ·{' '}
            <a href={`${path}/evidence/${settlement.fee.evidenceId}`} download>
              Document justificativ
            </a>
          </p>
        ) : null}
      </>
    );
  return null;
}
