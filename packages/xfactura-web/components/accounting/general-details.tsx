import type { GeneralBody } from 'xfactura-api/accounting';
import type { Overview } from 'xfactura-api/accounting-types';
import { Amount } from 'xfactura-api/accounting';
import { formatMoney } from './api';
import { AdvancePaymentDetails, InvoiceAdvanceDetails } from './advance-details';
import InvoiceSources from './invoice-sources';

function PlanSource({ state, path, id }: { state: Overview; path: string; id?: string }) {
  const plan = id ? state.rescheduleSources[id] : null;
  return plan ? (
    <div>
      <dt>Calendar aplicat</dt>
      <dd>
        <a href={`${path}/evidence/${plan.evidenceId}`} download>
          Acord · plan {plan.version}
        </a>
      </dd>
    </div>
  ) : null;
}

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
    credit = invoice?.credit,
    cancellation = invoice?.deferralCredit,
    scopeReduction = cancellation?.schemaVersion === 2 ? cancellation : undefined,
    discount = invoice?.deferralDiscount,
    deferral = invoice?.deferral,
    service = body.accrual ?? body.unbilledSale,
    matchedServices = invoice?.accrualMatch?.allocations ?? invoice?.unbilledSaleMatch?.allocations;
  if (body.advancePayment || body.advanceRefund)
    return <AdvancePaymentDetails {...{ body, state, path, showJournal }} />;
  if (body.deferralRelease) {
    const allocation = body.deferralRelease;
    return (
      <dl className="acc-review-meta">
        <div>
          <dt>Factura originală</dt>
          <dd>
            <button
              className="acc-secondary"
              onClick={() =>
                showJournal(allocation.sourceJournalId, allocation.sourceFinancialYearId)
              }
            >
              {state.invoiceLabels[allocation.sourceInvoiceId]?.number ?? 'Factura originală'}
            </button>
          </dd>
        </div>
        <div>
          <dt>Luna alocată</dt>
          <dd>{allocation.month.slice(0, 7)}</dd>
        </div>
        <PlanSource state={state} path={path} id={allocation.rescheduleId} />
        <div>
          <dt>
            {allocation.direction === 'purchase' ? 'Cheltuială recunoscută' : 'Venit recunoscut'}
          </dt>
          <dd>{formatMoney(allocation.amount)}</dd>
        </div>
      </dl>
    );
  }
  if (body.accrualAdjustment || body.unbilledSaleAdjustment) {
    const adjustment = (body.accrualAdjustment ?? body.unbilledSaleAdjustment)!;
    const amounts = [
      { key: 'net' as const, label: 'Valoare fără TVA' },
      ...(adjustment.previousRemaining.tax !== '0.00' || adjustment.remaining.tax !== '0.00'
        ? [
            {
              key: 'tax' as const,
              label:
                body.accrualAdjustment &&
                (body.accrualAdjustment.previousRemaining.deferredTax !== '0.00' ||
                  body.accrualAdjustment.remaining.deferredTax !== '0.00')
                  ? 'TVA în așteptarea facturii'
                  : body.unbilledSaleAdjustment
                    ? 'TVA colectată'
                    : 'TVA inclusă în cost',
            },
          ]
        : []),
      { key: 'gross' as const, label: 'Total' },
    ];
    return (
      <>
        <dl className="acc-review-meta">
          <div>
            <dt>{body.accrualAdjustment ? 'Angajament inițial' : 'Servicii inițiale'}</dt>
            <dd>
              <button
                className="acc-secondary"
                onClick={() =>
                  showJournal(adjustment.originalJournalId, adjustment.originalFinancialYearId)
                }
              >
                {'accrualReference' in adjustment
                  ? adjustment.accrualReference
                  : adjustment.serviceReference}
              </button>
            </dd>
          </div>
          <div>
            <dt>Data informației noi</dt>
            <dd>{adjustment.newInformationDate}</dd>
          </div>
          {body.unbilledSaleAdjustment?.taxTreatment === 'same_service_month' ? (
            <div>
              <dt>Perioada TVA</dt>
              <dd>{body.unbilledSaleAdjustment.taxPointDate.slice(0, 7)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Motiv</dt>
            <dd>{adjustment.reason}</dd>
          </div>
        </dl>
        <div className="acc-table-scroll">
          <table>
            <caption>Sold nefacturat</caption>
            <thead>
              <tr>
                <th>Componentă</th>
                <th>Înainte</th>
                <th>După</th>
                <th>Diferență</th>
              </tr>
            </thead>
            <tbody>
              {amounts.map(({ key, label }) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td>{formatMoney(adjustment.previousRemaining[key])}</td>
                  <td>{formatMoney(adjustment.remaining[key])}</td>
                  <td>{formatMoney(adjustment.delta[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (service)
    return (
      <dl className="acc-review-meta">
        <div>
          <dt>{'supplier' in service ? 'Furnizor' : 'Client'}</dt>
          <dd>
            {('supplier' in service ? service.supplier : service.customer).name} · CUI{' '}
            {('supplier' in service ? service.supplier : service.customer).taxId}
          </dd>
        </div>
        <div>
          <dt>Perioada serviciilor</dt>
          <dd>
            {service.serviceFrom} — {service.serviceTo}
          </dd>
        </div>
        <div>
          <dt>Data documentului</dt>
          <dd>{service.evidenceDate}</dd>
        </div>
        {body.unbilledSale?.measurementBasis === 'estimated_consideration' ? (
          <div>
            <dt>Bază de evaluare</dt>
            <dd>Valoare estimată</dd>
          </div>
        ) : null}
        {body.accrual && body.accrual.deferredTax !== '0.00' ? (
          <div>
            <dt>TVA în așteptarea facturii</dt>
            <dd>{formatMoney(body.accrual.deferredTax)}</dd>
          </div>
        ) : null}
        {body.unbilledSale && body.unbilledSale.tax !== '0.00' ? (
          <>
            <div>
              <dt>Exigibilitate TVA</dt>
              <dd>{body.unbilledSale.taxPointDate}</dd>
            </div>
            <div>
              <dt>TVA colectată</dt>
              <dd>{formatMoney(body.unbilledSale.tax)}</dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>Justificare</dt>
          <dd>{service.reason}</dd>
        </div>
      </dl>
    );
  if (invoice)
    return (
      <>
        {state.invoiceArchiveCounts[invoice.invoiceId] ? (
          <InvoiceSources
            key={`${invoice.invoiceId}:${state.invoiceArchiveCounts[invoice.invoiceId]}`}
            path={path}
            invoiceId={invoice.invoiceId}
            count={state.invoiceArchiveCounts[invoice.invoiceId]}
          />
        ) : null}
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
          {discount ? (
            <>
              <div>
                <dt>Reducere comercială</dt>
                <dd>{formatMoney(discount.amount)}</dd>
              </div>
              <div>
                <dt>Servicii și calendar</dt>
                <dd>Neschimbate</dd>
              </div>
            </>
          ) : null}
          <PlanSource
            state={state}
            path={path}
            id={discount?.rescheduleId ?? cancellation?.rescheduleId}
          />
          {cancellation ? (
            <>
              <div>
                <dt>{scopeReduction ? 'Modificare din' : 'Anulare din'}</dt>
                <dd>{cancellation.cancelFrom.slice(0, 7)}</dd>
              </div>
              <div>
                <dt>Sumă deja recunoscută</dt>
                <dd>{formatMoney(cancellation.allocated)}</dd>
              </div>
              <div>
                <dt>Sold amânat înainte</dt>
                <dd>{formatMoney(cancellation.remainingBefore)}</dd>
              </div>
              <div>
                <dt>Sumă anulată</dt>
                <dd>{formatMoney(cancellation.amount)}</dd>
              </div>
              <div>
                <dt>Sold amânat după</dt>
                <dd>{formatMoney(cancellation.remainingAfter)}</dd>
              </div>
              {scopeReduction ? (
                <div>
                  <dt>Alocare</dt>
                  <dd>
                    {scopeReduction.method === 'actual_calendar_days'
                      ? 'Pe zile calendaristice'
                      : 'Lunar, în cote egale'}
                  </dd>
                </div>
              ) : null}
            </>
          ) : null}
          <div>
            <dt>
              {invoice.advance
                ? 'Serviciu estimat pentru'
                : deferral
                  ? 'Începutul serviciilor'
                  : 'Data serviciului'}
            </dt>
            <dd>{invoice.advance?.serviceExpectedOn ?? invoice.serviceDate}</dd>
          </div>
          <div>
            <dt>{credit ? 'Exigibilitate inițială TVA' : 'Exigibilitate TVA'}</dt>
            <dd>{invoice.taxPointDate}</dd>
          </div>
          {invoice.tax !== '0.00' ? (
            <div>
              <dt>
                {credit ? 'Corecție ' : ''}
                {invoice.direction === 'sale'
                  ? invoice.unbilledSaleMatch ||
                    (invoice.advance?.previousOutputTax !== undefined &&
                      invoice.advance.previousOutputTax !== '0.00')
                    ? 'TVA colectată anterior'
                    : 'TVA colectată'
                  : 'TVA dedusă'}
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
              <dt>
                {deferral || invoice.advance
                  ? 'Contract'
                  : discount
                    ? 'Acord de reducere'
                    : cancellation
                      ? 'Acord de anulare'
                      : invoice.accrualMatch
                        ? 'Document de primire'
                        : 'Document pentru tratament'}
              </dt>
              <dd>
                <a href={`${path}/evidence/${invoice.treatmentEvidenceId}`} download>
                  Descarcă
                </a>
              </dd>
            </div>
          ) : null}
          {deferral ? (
            <>
              <div>
                <dt>
                  {deferral.schemaVersion === 2 ? 'Perioada serviciilor' : 'Perioada abonamentului'}
                </dt>
                <dd>
                  {deferral.serviceFrom} — {deferral.serviceTo}
                </dd>
              </div>
              <div>
                <dt>Alocare</dt>
                <dd>
                  {deferral.method === 'actual_calendar_days'
                    ? 'Pe zile calendaristice'
                    : 'Lunar, în cote egale'}
                </dd>
              </div>
              {deferral.schemaVersion === 2 ? (
                <div>
                  <dt>Zile de servicii</dt>
                  <dd>{deferral.serviceDays}</dd>
                </div>
              ) : null}
              <div>
                <dt>Justificare</dt>
                <dd>{deferral.reason}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <InvoiceAdvanceDetails {...{ body, state, path, showJournal }} />
        {cancellation && !scopeReduction ? (
          <div className="acc-table-scroll">
            <table>
              <caption>Luni anulate</caption>
              <thead>
                <tr>
                  <th>Lună</th>
                  <th>Sumă</th>
                </tr>
              </thead>
              <tbody>
                {cancellation.months.map((item) => (
                  <tr key={item.month}>
                    <td>{item.month.slice(0, 7)}</td>
                    <td>{formatMoney(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {scopeReduction ? (
          <div className="acc-table-scroll">
            <table>
              <caption>Plan de alocare modificat</caption>
              <thead>
                <tr>
                  <th>Lună</th>
                  {scopeReduction.method === 'actual_calendar_days' ? <th>Zile</th> : null}
                  <th>Înainte</th>
                  <th>După</th>
                </tr>
              </thead>
              <tbody>
                {scopeReduction.afterSchedule.map((row, index) => (
                  <tr key={row.month}>
                    <td>{row.month.slice(0, 7)}</td>
                    {scopeReduction.method === 'actual_calendar_days' ? (
                      <td>{'days' in row ? row.days : ''}</td>
                    ) : null}
                    <td>{formatMoney(scopeReduction.beforeSchedule[index].amount)}</td>
                    <td>{formatMoney(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {deferral ? (
          <div className="acc-table-scroll">
            <table>
              <caption>Plan de alocare</caption>
              <thead>
                <tr>
                  <th>Lună</th>
                  <th>Data înregistrării</th>
                  {deferral.schemaVersion === 2 ? <th>Zile</th> : null}
                  <th>{invoice.direction === 'purchase' ? 'Cheltuială' : 'Venit'}</th>
                </tr>
              </thead>
              <tbody>
                {deferral.schedule.map((item) => (
                  <tr key={item.month}>
                    <td>{item.month.slice(0, 7)}</td>
                    <td>{item.date}</td>
                    {deferral.schemaVersion === 2 ? (
                      <td>{'days' in item && typeof item.days === 'number' ? item.days : ''}</td>
                    ) : null}
                    <td>{formatMoney(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {matchedServices ? (
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
                {matchedServices.map((item) => (
                  <tr key={item.originalJournalId}>
                    <td>
                      <button
                        className="acc-secondary"
                        onClick={() =>
                          showJournal(item.originalJournalId, item.originalFinancialYearId)
                        }
                      >
                        {item.reference}
                      </button>
                      {'latestAdjustmentJournalId' in item && item.latestAdjustmentJournalId ? (
                        <button
                          className="acc-secondary"
                          onClick={() =>
                            showJournal(
                              item.latestAdjustmentJournalId!,
                              item.originalFinancialYearId,
                            )
                          }
                        >
                          Ultima ajustare
                        </button>
                      ) : null}
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
