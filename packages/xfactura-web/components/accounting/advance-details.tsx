import { Amount, type GeneralBody } from 'xfactura-api/accounting';
import type { Overview } from 'xfactura-api/accounting-types';
import { formatMoney } from './api';

type Props = {
  body: GeneralBody;
  state: Overview;
  path: string;
  showJournal: (id: string, financialYearId?: string) => void;
};

export function AdvancePaymentDetails({ body, path, showJournal }: Props) {
  const payment = body.advancePayment,
    refund = body.advanceRefund;
  if (!payment && !refund) return null;
  const item = payment ?? refund!;
  return (
    <dl className="acc-review-meta">
      {payment ? (
        <>
          <div>
            <dt>{payment.direction === 'purchase' ? 'Furnizor' : 'Client'}</dt>
            <dd>
              {payment.counterparty.name} · CUI {payment.counterparty.taxId}
            </dd>
          </div>
          <div>
            <dt>Referință contract</dt>
            <dd>{payment.reference}</dd>
          </div>
          <div>
            <dt>Serviciu estimat pentru</dt>
            <dd>{payment.serviceExpectedOn}</dd>
          </div>
        </>
      ) : null}
      {refund ? (
        <>
          <div>
            <dt>Avans original</dt>
            <dd>
              <button
                className="acc-secondary"
                onClick={() => showJournal(refund.paymentJournalId, refund.originalFinancialYearId)}
              >
                Deschide avansul
              </button>
            </dd>
          </div>
          <div>
            <dt>Data acordului</dt>
            <dd>{refund.decisionDate}</dd>
          </div>
        </>
      ) : null}
      <div>
        <dt>{refund ? 'Acord de restituire' : 'Contract'}</dt>
        <dd>
          <a href={`${path}/evidence/${item.evidenceId}`} download>
            Descarcă
          </a>
        </dd>
      </div>
      <div>
        <dt>
          {refund
            ? 'Sumă restituită'
            : payment?.direction === 'purchase'
              ? 'Sumă plătită'
              : 'Sumă încasată'}
        </dt>
        <dd>{formatMoney(item.gross)}</dd>
      </div>
      <div>
        <dt>
          {item.direction === 'sale'
            ? refund
              ? 'TVA stornată'
              : 'TVA colectată la primirea avansului'
            : 'TVA dedusă'}
        </dt>
        <dd>{formatMoney(item.direction === 'sale' ? item.tax : '0.00')}</dd>
      </div>
      {item.direction === 'sale' && item.tax !== '0.00' ? (
        <div>
          <dt>{refund ? 'Exigibilitate inițială TVA' : 'Exigibilitate TVA'}</dt>
          <dd>{refund?.originalTaxPointDate ?? payment?.taxPointDate}</dd>
        </div>
      ) : null}
      <div>
        <dt>Justificare</dt>
        <dd>{item.reason}</dd>
      </div>
    </dl>
  );
}

export function InvoiceAdvanceDetails({ body, state, showJournal }: Props) {
  const invoice = body.invoice,
    advance = invoice?.advance,
    final = invoice?.advanceFinal,
    credit = invoice?.advanceCredit;
  if (!invoice || (!advance && !final && !credit)) return null;
  return (
    <>
      {advance ? (
        <>
          <dl className="acc-review-meta">
            <div>
              <dt>Referință contract</dt>
              <dd>{advance.reference}</dd>
            </div>
            <div>
              <dt>Justificare</dt>
              <dd>{advance.reason}</dd>
            </div>
            {advance.previousOutputTax !== '0.00' ? (
              <div>
                <dt>TVA nouă la facturare</dt>
                <dd>
                  {formatMoney(new Amount(invoice.tax).minus(advance.previousOutputTax).toFixed(2))}
                </dd>
              </div>
            ) : null}
          </dl>
          {advance.payments.length ? (
            <div className="acc-table-scroll">
              <table>
                <caption>
                  {invoice.direction === 'purchase' ? 'Plăți asociate' : 'Încasări asociate'}
                </caption>
                <thead>
                  <tr>
                    <th>Avans bancar</th>
                    <th>Fără TVA</th>
                    <th>TVA</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {advance.payments.map((payment, i) => (
                    <tr key={payment.paymentId}>
                      <td>
                        <button
                          className="acc-secondary"
                          onClick={() => showJournal(payment.journalId, payment.financialYearId)}
                        >
                          Deschide avansul {i + 1}
                        </button>
                      </td>
                      <td>{formatMoney(payment.net)}</td>
                      <td>{formatMoney(payment.tax)}</td>
                      <td>{formatMoney(payment.gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
      {final ? (
        <>
          <dl className="acc-review-meta">
            <div>
              <dt>Servicii fără TVA, înainte de regularizare</dt>
              <dd>{formatMoney(final.serviceNet)}</dd>
            </div>
            <div>
              <dt>Total de plată pe factura finală</dt>
              <dd>{formatMoney(invoice.gross)}</dd>
            </div>
          </dl>
          <div className="acc-table-scroll">
            <table>
              <caption>Avansuri regularizate</caption>
              <thead>
                <tr>
                  <th>Factură de avans</th>
                  <th>Disponibil fără TVA</th>
                  <th>Utilizat fără TVA</th>
                  <th>Rămas fără TVA</th>
                  <th>TVA regularizată</th>
                </tr>
              </thead>
              <tbody>
                {final.allocations.map((row) => (
                  <tr key={row.advanceInvoiceId}>
                    <td>
                      <button
                        className="acc-secondary"
                        onClick={() =>
                          showJournal(row.originalJournalId, row.originalFinancialYearId)
                        }
                      >
                        {state.invoiceLabels[row.advanceInvoiceId]?.number ?? 'Factura de avans'}
                      </button>
                    </td>
                    <td>{formatMoney(row.availableNet)}</td>
                    <td>{formatMoney(row.net)}</td>
                    <td>{formatMoney(new Amount(row.availableNet).minus(row.net).toFixed(2))}</td>
                    <td>{formatMoney(row.tax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {credit ? (
        <dl className="acc-review-meta">
          <div>
            <dt>Avans disponibil fără TVA</dt>
            <dd>{formatMoney(credit.availableNet)}</dd>
          </div>
          <div>
            <dt>Avans anulat fără TVA</dt>
            <dd>{formatMoney(invoice.net)}</dd>
          </div>
          <div>
            <dt>Avans rămas fără TVA</dt>
            <dd>{formatMoney(new Amount(credit.availableNet).minus(invoice.net).toFixed(2))}</dd>
          </div>
        </dl>
      ) : null}
    </>
  );
}
