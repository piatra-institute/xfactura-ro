import { z } from 'zod';
import {
  accountCodePattern,
  profileAt,
  vatPeriodOf,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import {
  convertMinor,
  divRound,
  formatMoney,
  isSupportedCurrency,
  LEDGER_CURRENCY,
  parseMoney,
  parseScaled,
} from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError } from '../../rules';
import {
  isLocalDate,
  monthEnd,
  parseLocalDate as date,
  type LocalDate,
  type Month,
} from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { selectRate } from '../fx';
import { euVatPrefixes } from '../geo';
import { obligationDue } from '../obligations';
import { invoiceKinds } from './invoices';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const warn = (code: string, message: string): Issue => ({ code, severity: 'ack', message });

/** What a company not registered under art. 316 needs for services across the EU border: the
 * special registration of art. 317 alin. (1) lit. b) (supplied) or c) (bought). */
const ART317 = 'ANAF/Cod-fiscal-consolidat:art.317(1)';

/**
 * The semantic codes of services across the border. Declarations derive their rows from them:
 * purchases with the VAT self-assessed by the company (reverse charge), and sales whose place of
 * supply is abroad, with no Romanian VAT.
 */
export const crossBorderCodes = {
  purchase: { eu: 'RC-EU-SERV', nonEu: 'RC-NONEU-SERV' },
  sale: { eu: 'EXP-EU-SERV', nonEu: 'EXP-NONEU-SERV' },
} as const;

export const crossBorderInput = z
  .object({
    documentId: z.uuid(),
    /** Revenue account (70x) for a sale; expense account (6xx) for a purchase. */
    account: z.string().regex(accountCodePattern),
    /**
     * Services under the general place-of-supply rule between taxable persons: taxed where the
     * customer is established (Cod fiscal art. 278 alin. (2)). Exceptions (immovable property,
     * events, passenger transport, restaurants…) and goods are other treatments.
     */
    supply: z.literal('services_general_rule'),
    deduction: z.enum(['full', 'none']).default('full'),
    /** When the service was provided, if it is not the invoice's tax point date or issue date. */
    taxPoint: z
      .string()
      .refine((value): boolean => isLocalDate(value))
      .optional(),
    /** For a purchase by a company not registered for VAT (art. 316): the tax authority, to which
     * it owes the VAT through the special return (D301, art. 324). */
    authorityId: z.uuid().optional(),
  })
  .strict();
export type CrossBorderInput = z.infer<typeof crossBorderInput>;

/**
 * Services bought from or sold to a business established abroad. A purchase books the expense
 * and the supplier's invoice, and the company self-assesses Romanian VAT at the standard rate on
 * the base at the BNR rate for VAT: collected (4427) and, when deductible, deducted (4426) at
 * once. A sale books revenue with no Romanian VAT and records its base for the return.
 */
export const crossBorderRecognition: Treatment<CrossBorderInput> = {
  id: 'invoices.crossBorder',
  version: 1,
  description:
    'Servicii cumpărate din străinătate (taxare inversă) sau prestate unor beneficiari din străinătate, după regula generală.',
  input: crossBorderInput,
  agent: true,
  summary:
    'Services bought from abroad (reverse charge) or supplied to customers abroad under the general place-of-supply rule.',
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId],
    profile: true,
    ...(input.authorityId ? { parties: [input.authorityId] } : {}),
  }),
  followUp(input, loaded) {
    const parsed = invoiceDocumentSchema.safeParse(loaded.documents.get(input.documentId)?.body);
    if (!parsed.success || parsed.data.currency === LEDGER_CURRENCY) return null;
    const point = input.taxPoint ?? parsed.data.taxPointDate ?? parsed.data.issueDate;
    const until = [parsed.data.issueDate, point].sort().at(-1)!;
    return { fx: [{ currency: parsed.data.currency, until: date(until) }] };
  },
  evaluate(input, loaded, rules) {
    const record = loaded.documents.get(input.documentId);
    if (!record)
      return {
        effect: null,
        issues: [block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId')],
      };
    if (record.kind !== invoiceKinds.sale && record.kind !== invoiceKinds.purchase)
      return {
        effect: null,
        issues: [
          block('DOCUMENT_KIND', 'Se recunosc aici facturi, nu note de credit.', 'documentId'),
        ],
      };
    const body = invoiceDocumentSchema.parse(record.body);
    const sale = record.kind === invoiceKinds.sale;
    const counterparty = sale ? body.customer : body.supplier;
    const issues: Issue[] = [];
    if (counterparty.country === 'RO')
      issues.push(
        block(
          'DOMESTIC',
          'Partenerul este din România: folosiți recunoașterea facturilor interne.',
        ),
      );
    const prefix = euVatPrefixes[counterparty.country];
    const eu = prefix !== undefined;
    // B2B is what the general rule needs; an EU customer proves it with a VAT code of its state.
    if (sale && eu && !counterparty.taxId.toUpperCase().startsWith(prefix))
      issues.push(
        block(
          'CUSTOMER_VAT_ID',
          `Beneficiarul din ${counterparty.country} trebuie să aibă cod de TVA (${prefix}…).`,
        ),
      );
    if (body.totals.tax !== '0.00')
      issues.push(
        block(
          'VAT_CHARGED',
          'Factura conține TVA: furnizorul nu a aplicat taxarea inversă. Cereți o factură corectă.',
        ),
      );
    if (!isSupportedCurrency(body.currency))
      issues.push(block('CURRENCY', `Moneda ${body.currency} nu este acceptată.`));
    const taxPoint = date(input.taxPoint ?? body.taxPointDate ?? body.issueDate) as LocalDate;
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    // A company not registered under art. 316 owes the VAT on the services it buys (art. 307
    // alin. (2)), without deducting it, through the special return (art. 324); with an EU partner
    // it needs the special code of art. 317 (the `vat.eu` axis, `special`).
    const status = profileAt(loaded, 'vat.status', taxPoint);
    if (!status)
      issues.push(
        questionIssue(
          'DETERMINATION_MISSING',
          'Înregistrați regimul TVA al companiei pentru această dată.',
          {
            kind: 'profile.fact',
            subject: { kind: 'profile', id: 'vat.status' },
            params: { axis: 'vat.status', from: taxPoint },
          },
        ),
      );
    const nonPayer = status === 'non_vat';
    if (nonPayer && eu) {
      const code = profileAt(loaded, 'vat.eu', taxPoint);
      if (!code)
        issues.push(
          questionIssue(
            'DETERMINATION_MISSING',
            'Înregistrați dacă firma are cod de TVA pentru operațiuni intracomunitare (art. 317).',
            {
              kind: 'profile.fact',
              subject: { kind: 'profile', id: 'vat.eu' },
              params: { axis: 'vat.eu', from: taxPoint },
            },
          ),
        );
      else if (code !== 'special')
        issues.push({
          ...warn(
            'ART317_REQUIRED',
            sale
              ? `Firma neînregistrată în scopuri de TVA prestează servicii unui beneficiar din ${counterparty.country}: codul de TVA de la art. 317 alin. (1) lit. b) se solicită înainte de prestare, iar operațiunea se declară în D390.`
              : `Firma neînregistrată în scopuri de TVA cumpără servicii de la un prestator din ${counterparty.country}: codul de TVA de la art. 317 alin. (1) lit. c) se solicită înaintea primirii lor. Taxa se datorează oricum (art. 307 alin. (2)) și se declară în D301.`,
          ),
          details: { clause: ART317 },
        });
    }
    if (nonPayer && !sale) {
      if (input.deduction !== 'none')
        issues.push(
          block(
            'DEDUCTION',
            'Un neplătitor de TVA nu deduce taxa datorată prin decontul special: deduction: none.',
            'deduction',
          ),
        );
      if (loaded.parties.get(input.authorityId ?? '')?.kind !== 'ro_public_institution')
        issues.push(
          block(
            'AUTHORITY',
            'Indicați autoritatea fiscală (instituție publică), căreia i se datorează TVA prin decontul special (D301).',
            'authorityId',
          ),
        );
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    // Amounts in lei: at the accounting rate on the issue date; the VAT base at the VAT rate.
    const foreign = body.currency !== LEDGER_CURRENCY;
    const netMinor = parseMoney(body.totals.net, body.currency);
    let accounting: FxRate | undefined;
    let vatRate: FxRate | undefined;
    if (foreign) {
      const a = selectRate(loaded, rules, body.currency, date(body.issueDate), 'accounting');
      const v = selectRate(loaded, rules, body.currency, taxPoint, 'vat');
      if ('code' in a) issues.push(a);
      if ('code' in v) issues.push(v);
      if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
      accounting = a as FxRate;
      vatRate = v as FxRate;
    }
    const toLei = (rate?: FxRate) =>
      rate
        ? convertMinor(netMinor, body.currency, { rate: rate.rate, multiplier: rate.multiplier })
        : netMinor;
    const net = toLei(accounting);
    const base = toLei(vatRate);
    const currency = (rate: FxRate | undefined, minor: bigint) =>
      rate ? { currency: { code: body.currency, minor, rateId: rate.id, rate: rate.rate } } : {};
    const partyId = record.partyId ?? undefined;
    const item = {
      ref: 'counterparty',
      kind: sale ? ('receivable' as const) : ('payable' as const),
      controlAccount: sale ? '4111' : '401',
      partyId: partyId!,
      currency: body.currency,
      normalSide: sale ? ('D' as const) : ('C' as const),
      mayReverse: false,
      documentId: record.id,
    };
    const code = sale
      ? crossBorderCodes.sale[eu ? 'eu' : 'nonEu']
      : crossBorderCodes.purchase[eu ? 'eu' : 'nonEu'];
    const entry = (direction: 'output' | 'input', fields: Partial<TaxEntrySpec>): TaxEntrySpec => ({
      key: `vat.${direction}`,
      tax: 'VAT',
      code,
      direction,
      baseBani: base,
      taxBani: 0n,
      deductibleBani: 0n,
      ledgerBani: 0n,
      taxPoint,
      exigibility: taxPoint,
      taxPeriod,
      documentId: record.id,
      ...(partyId ? { partyId } : {}),
      ...(vatRate
        ? {
            currency: {
              code: body.currency,
              baseMinor: netMinor,
              taxMinor: 0n,
              rateId: vatRate.id,
              rate: vatRate.rate,
            },
          }
        : {}),
      attributes: {
        number: body.number,
        counterpartyTaxId: counterparty.taxId,
        counterpartyCountry: counterparty.country,
        supply: input.supply,
      },
      ...fields,
    });
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    if (sale) {
      lines.push({
        account: '4111',
        side: 'D',
        bani: net,
        openItem: item.ref,
        partyId,
        ...currency(accounting, netMinor),
      });
      lines.push({ account: input.account, side: 'C', bani: net });
      taxEntries.push(entry('output', {}));
    } else {
      let rate: string;
      try {
        rate = rules.param<string>('ro.vat.rate', 'vat_chargeability_date', taxPoint, {
          category: 'S',
        });
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        return { effect: null, issues: [block('RULE_GAP', error.message)] };
      }
      // base × rate ÷ 100, the rate at four decimals: rounded once, half away from zero.
      const tax = divRound(base * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');
      if (nonPayer) {
        // Owed through the special return by the 25th of the next month, on the account the
        // register gives (4423): no 4427/4426, which a non-payer does not settle.
        let payable: string;
        let due: LocalDate;
        try {
          payable = rules.param<string>(
            'ro.vat.special.payable_account',
            'vat_chargeability_date',
            taxPoint,
          );
          const month = taxPoint.slice(0, 7) as Month;
          due = obligationDue('D301', { start: date(`${month}-01`), end: monthEnd(month) }, rules)
            .due as LocalDate;
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
        }
        lines.push({ account: input.account, side: 'D', bani: net });
        lines.push({
          account: '401',
          side: 'C',
          bani: net,
          openItem: item.ref,
          partyId,
          ...currency(accounting, netMinor),
        });
        lines.push({
          account: input.account,
          side: 'D',
          bani: tax,
          memo: 'TVA datorată prin decontul special (D301), nedeductibilă',
        });
        lines.push({
          account: payable,
          side: 'C',
          bani: tax,
          openItem: 'special',
          partyId: input.authorityId!,
        });
        const special = { regime: 'special', return: 'D301' };
        taxEntries.push(
          entry('output', {
            taxBani: tax,
            attributes: { ...entry('output', {}).attributes, ...special },
          }),
        );
        taxEntries.push(
          entry('input', {
            taxBani: tax,
            attributes: { ...entry('input', {}).attributes, ...special },
          }),
        );
        const effect: Effect = {
          schema: 'effect@1',
          date: date(body.issueDate),
          journalClass: 'general',
          journalCode: 'CUMPARARI',
          description: `Factură primită ${body.number} (${counterparty.country}), TVA prin decontul special`,
          lines,
          openItems: [
            item,
            {
              ref: 'special',
              kind: 'tax.payable',
              controlAccount: payable,
              partyId: input.authorityId!,
              currency: 'RON',
              normalSide: 'C',
              mayReverse: false,
              dueDate: due,
              documentId: record.id,
            },
          ],
          taxEntries,
          schedules: [],
          explanation: {
            summary: `Servicii din ${counterparty.country} cumpărate de o firmă neînregistrată în scopuri de TVA: TVA ${formatMoney(tax, LEDGER_CURRENCY)} lei datorată la cota standard (art. 307 alin. (2)), nedeductibilă, declarată în D301 până la ${due}.`,
            details: { taxPoint, eu, code, regime: 'special', due },
          },
        };
        return { effect, issues };
      }
      const deducted = input.deduction === 'full' ? tax : 0n;
      lines.push({ account: input.account, side: 'D', bani: net });
      lines.push({
        account: '401',
        side: 'C',
        bani: net,
        openItem: item.ref,
        partyId,
        ...currency(accounting, netMinor),
      });
      lines.push({ account: '4427', side: 'C', bani: tax });
      taxEntries.push(entry('output', { taxBani: tax, ledgerBani: tax, line: 2 }));
      if (deducted) {
        lines.push({ account: '4426', side: 'D', bani: tax });
        taxEntries.push(
          entry('input', { taxBani: tax, deductibleBani: tax, ledgerBani: tax, line: 3 }),
        );
      } else {
        lines.push({
          account: input.account,
          side: 'D',
          bani: tax,
          memo: 'TVA nedeductibilă (taxare inversă)',
        });
        taxEntries.push(entry('input', { taxBani: tax }));
      }
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: date(body.issueDate),
      journalClass: 'general',
      journalCode: sale ? 'VANZARI' : 'CUMPARARI',
      description: `${sale ? 'Factură emisă' : 'Factură primită'} ${body.number} (${counterparty.country})`,
      lines,
      openItems: [item],
      taxEntries,
      schedules: [],
      explanation: {
        summary: sale
          ? `Servicii prestate în ${counterparty.country}: fără TVA românească; baza ${body.totals.net} ${body.currency}.`
          : `Servicii din ${counterparty.country} cu taxare inversă: TVA autolichidată la cota standard.`,
        details: { taxPoint, eu, code },
      },
    };
    return { effect, issues };
  },
};
