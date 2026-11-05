import { z } from 'zod';
import {
  accountCodePattern,
  partyStatusKey,
  profileAt,
  vatPeriodOf,
  type AnswerRecord,
  type Effect,
  type Issue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { allocate, divRound, LEDGER_CURRENCY, parseScaled } from '../../money';
import { questionIssue, questionKinds, type FarmerRegisterAnswer } from '../../questions/kinds';
import type { LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { provisionalProrata } from '../exempt/facts';
import { isValidCnp, isValidCui } from '../identifiers';
import { chargeabilityOf, invoiceKinds } from '../treatments/invoices';
import {
  block,
  FLAT_RATE_CLAUSES,
  lei,
  ron,
  ruleOf,
  schemeCodes,
  showsNoVat,
  warn,
} from './margin';
import type { FlatRateRule } from './parameters';

/** The agricultural services of art. 315^1 alin. (1) lit. d): the annex of the joint order the
 * norms' pct. 87^1 alin. (3) name (OMFP nr. 1.155/868/2016). */
const AGRICULTURAL_SERVICES = 'OMFP1155/2016:anexa';

/*
 * The agricultural flat rate (Codul fiscal art. 315^1). A farmer (an individual, PFA, II or IF
 * with only agricultural activities, or others under the art. 310 threshold) in ANAF's register
 * collects no VAT and deducts none; on the agricultural products and services it supplies to
 * other taxable persons it invoices a flat-rate compensation, 8% of the price without VAT from
 * 2019 (alin. (2)–(3), (8)), with the mention of the regime. A buyer registered for VAT deducts
 * the compensation it paid like VAT (alin. (17)) when the farmer was in the register on the
 * supply's day (norme pct. 87^1 alin. (15)): D300 rd. 27 and 31 (OPANAF nr. 174/2026).
 *
 * The buyer's purchase books the products on an expense or a fixed asset (the stock module, G1,
 * does not exist: no class 3) and the compensation on 4426, or in the expense when not deducted.
 * The farmer's own sale books the products' revenue and the compensation apart; whether a PFA's
 * agricultural income is taxed by norm or in the real system (art. 103–107) is not built, so the
 * closure reports a farmer UNSUPPORTED.
 */

const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const part = z
  .object({
    /** An expense (6xx) or fixed asset (20x, 21x) for the buyer; a revenue (70x) for the farmer. */
    account: z.string().regex(accountCodePattern),
    /** The products' or services' price without the compensation, in lei. */
    amount,
  })
  .strict();

export const flatRateInput = z
  .object({
    documentId: z.uuid(),
    /** The agricultural products and services on the invoice, without the compensation. */
    parts: z.array(part).min(1).max(20),
    /** A purchase: whether the compensation is deducted (art. 315^1 alin. (17), art. 297–301). */
    deduction: z.enum(['full', 'none']).optional(),
    /** The farmer's sale: the revenue account of the compensation it is owed. */
    compensationAccount: z.string().regex(accountCodePattern).optional(),
  })
  .strict();
export type FlatRateInput = z.infer<typeof flatRateInput>;

/** The farmer's register answer the basis cites, latest first by the engine's time. */
export function farmerRegisterAnswer(
  loaded: Loaded,
  partyId: string,
): { record: AnswerRecord; value: FarmerRegisterAnswer } | null {
  const kind = questionKinds['farmer.register'];
  let found: { record: AnswerRecord; value: FarmerRegisterAnswer } | null = null;
  for (const record of loaded.answers.values()) {
    if (record.kind !== kind.id || record.subject.kind !== 'party' || record.subject.id !== partyId)
      continue;
    const parsed = kind.answer({}).safeParse(record.value);
    if (!parsed.success) continue;
    if (
      !found ||
      found.record.answeredAt < record.answeredAt ||
      (found.record.answeredAt === record.answeredAt && found.record.answerId < record.answerId)
    )
      found = { record, value: parsed.data };
  }
  return found;
}

/** The compensation of a price at a percent: price × percent ÷ 100, half up to the ban. */
export function flatRateCompensation(priceBani: bigint, percent: string): bigint {
  return divRound(priceBani * parseScaled(percent, 4), 1_000_000n, 'halfAwayFromZero');
}

/**
 * An invoice under the agricultural flat rate: the buyer's purchase from a farmer in the register
 * (the products and the compensation paid, deducted like VAT), or the farmer's own sale (the
 * products' revenue and the compensation owed). The invoice shows no VAT; its total is the
 * products' price plus the compensation.
 */
export const flatRateRecognition: Treatment<FlatRateInput> = {
  id: 'invoices.flatRate',
  version: 1,
  description:
    'Factură în regimul special pentru agricultori (art. 315^1 din Codul fiscal): achiziția de la un agricultor înscris în registrul ANAF, cu compensația în cotă forfetară dedusă ca TVA, sau livrarea agricultorului, cu compensația cuvenită.',
  input: flatRateInput,
  agent: true,
  summary:
    "An agricultural flat-rate invoice (art. 315^1): a purchase from a registered farmer, its 8% compensation deducted like VAT (D300 rd. 27), or the farmer's own sale.",
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({ documents: [input.documentId], profile: true }),
  followUp(input, loaded) {
    const record = loaded.documents.get(input.documentId);
    const parsed = invoiceDocumentSchema.safeParse(record?.body);
    if (!record?.partyId || !parsed.success) return null;
    return {
      parties: [record.partyId],
      partyStatus: [{ partyId: record.partyId, date: chargeabilityOf(parsed.data).date }],
    };
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
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
          block(
            'DOCUMENT_KIND',
            'Se recunosc aici facturi; notele de credit în regimul special pentru agricultori nu sunt încă acoperite.',
            'documentId',
          ),
        ],
      };
    const sale = record.kind === invoiceKinds.sale;
    const body = invoiceDocumentSchema.parse(record.body);
    const chargeable = chargeabilityOf(body);
    const taxPoint = chargeable.date;
    if (body.currency !== LEDGER_CURRENCY)
      issues.push(block('CURRENCY', 'Facturile în valută nu sunt încă acoperite.'));
    if (body.totals.prepaid !== '0.00' || body.totals.rounding !== '0.00')
      issues.push(
        block('PREPAID', 'Avansurile deduse și rotunjirile pe factură nu sunt încă acoperite.'),
      );
    if (!record.partyId) issues.push(block('PARTY', 'Documentul nu are partener.'));
    if (body.supplier.country !== 'RO' || body.customer.country !== 'RO')
      issues.push(
        block(
          'DOMESTIC',
          'Regimul special pentru agricultori privește aici livrările din țară; livrările intracomunitare și achizițiile cu restituirea compensației (art. 315^1 alin. (8) lit. c)–e), (18)) nu sunt acoperite.',
        ),
      );
    if (!showsNoVat(body))
      issues.push(
        block(
          'FLAT_RATE_VAT_CHARGED',
          'Factura înscrie TVA: agricultorul în regim special nu colectează TVA (art. 315^1 alin. (4) lit. a)); cu TVA, factura este a unui furnizor în regim normal (invoices.recognize).',
        ),
      );
    const rule = ruleOf<FlatRateRule>(rules, 'ro.vat.flat_rate.agriculture', taxPoint, issues);
    const amounts = input.parts.map((item) => ron(item.amount));
    const price = amounts.reduce((sum, value) => sum + value, 0n);
    const total = ron(body.totals.payable);
    const compensation = total - price;
    const expected = rule ? flatRateCompensation(price, rule.percent) : null;
    if (expected !== null) {
      if (compensation <= 0n)
        issues.push(
          block(
            'FLAT_RATE_MISSING',
            `Factura nu înscrie compensația în cotă forfetară (de plată ${lei(total)} lei, produsele ${lei(price)} lei): fără ea, achiziția este una obișnuită de la un neplătitor de TVA (invoices.recognize, categoria O); agricultorul o înscrie doar după înscrierea în registru (norme pct. 87^1 alin. (5)).`,
            'parts',
          ),
        );
      // Rounded per line on the invoice: a ban per line at most.
      else if (
        compensation - expected > BigInt(body.lines.length) ||
        expected - compensation > BigInt(body.lines.length)
      )
        issues.push(
          block(
            'FLAT_RATE_AMOUNT',
            `Compensația facturată este ${lei(compensation)} lei; ${rule!.percent}% din prețul de ${lei(price)} lei este ${lei(expected)} lei (art. 315^1 alin. (1) lit. h), (2)). Cereți agricultorului factura corectă.`,
            'parts',
            { clauses: FLAT_RATE_CLAUSES },
          ),
        );
    }
    issues.push(
      warn(
        'FLAT_RATE_PRODUCTS',
        'Confirmați că bunurile sunt produse agricole din producția agricolului (cultura plantelor, creșterea animalelor, silvicultura, pescuitul, transformate prin metode neindustriale) sau servicii agricole din cele 34 ale anexei Ordinului nr. 1.155/868/2016 (art. 315^1 alin. (1) lit. c)–e), norme pct. 87^1 alin. (1)–(3)), și că factura înscrie mențiunea regimului special pentru agricultori, procentul și compensația (alin. (8)).',
        { clauses: [...FLAT_RATE_CLAUSES, AGRICULTURAL_SERVICES] },
      ),
    );
    const partyId = record.partyId ?? '';
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    let item: OpenItemSpec;
    let summary: string;
    let deducted = 0n;

    if (!sale) {
      // The buyer: the farmer in the register on the supply's day, the compensation deducted.
      const supplierId = body.supplier.taxId.toUpperCase().replace(/\s+/g, '');
      const party = loaded.parties.get(partyId);
      if (/^RO\d+$/.test(supplierId) && isValidCui(supplierId))
        issues.push(
          block(
            'FLAT_RATE_SUPPLIER',
            `Furnizorul ${body.supplier.name} are cod de TVA: un agricultor înregistrat în scopuri de TVA nu mai aplică regimul special (art. 315^1 alin. (14)).`,
          ),
        );
      const status = loaded.partyStatus.get(partyStatusKey(partyId, taxPoint));
      if (status?.vatPayer)
        issues.push(
          block(
            'FLAT_RATE_SUPPLIER',
            `${status.name} era înregistrat în scopuri de TVA la ${taxPoint}, după ANAF: nu aplică regimul special pentru agricultori (art. 315^1 alin. (14)).`,
            undefined,
            { date: status.date, evidenceId: status.evidenceId },
          ),
        );
      // The party's kind is what created it (an import makes a legal entity of any CUI): unless it
      // is recorded as an individual or an individual enterprise, the reviewer confirms the form.
      if (
        !isValidCnp(supplierId) &&
        party?.kind !== 'ro_individual' &&
        party?.kind !== 'ro_individual_enterprise'
      )
        issues.push(
          warn(
            'FLAT_RATE_SUPPLIER_FORM',
            `Confirmați că ${body.supplier.name} este o persoană fizică, PFA, întreprindere individuală sau familială, nu o societate: doar acestea sunt agricultori în regimul special (art. 315^1 alin. (1) lit. b)).`,
            { clauses: FLAT_RATE_CLAUSES },
          ),
        );
      const registered = farmerRegisterAnswer(loaded, partyId);
      if (!registered)
        issues.push(
          questionIssue(
            'FLAT_RATE_REGISTER',
            `Compensația se deduce numai dacă ${body.supplier.name} era înscris în Registrul agricultorilor care aplică regimul special la ${taxPoint} (norme pct. 87^1 alin. (15)): întrebați, cu extrasul din registru.`,
            {
              kind: 'farmer.register',
              subject: { kind: 'party', id: partyId },
              params: { date: taxPoint, documentId: record.id },
            },
          ),
        );
      else if (
        !registered.value.registered ||
        registered.value.from > taxPoint ||
        (registered.value.until !== undefined && registered.value.until < taxPoint)
      )
        issues.push(
          block(
            'FLAT_RATE_REGISTER',
            `${body.supplier.name} nu era înscris în Registrul agricultorilor care aplică regimul special la ${taxPoint}, după răspunsul citat: compensația nu se deduce (norme pct. 87^1 alin. (15)). Înregistrați achiziția fără compensație deductibilă sau cereți factura corectă.`,
            undefined,
            { evidenceId: registered.value.evidenceId },
          ),
        );
      const status316 = profileAt(loaded, 'vat.status', taxPoint);
      const deduction = input.deduction;
      if (!deduction)
        issues.push(
          block('DEDUCTION', 'Indicați dacă se deduce compensația (deduction).', 'deduction'),
        );
      if (!status316)
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
      else if (status316 !== 'normal_vat' && deduction === 'full')
        issues.push(
          block(
            'DEDUCTION',
            'Compania nu este înregistrată în scopuri de TVA: compensația o deduc doar persoanele înregistrate (art. 315^1 alin. (17)); rămâne în cheltuială (deduction: none).',
            'deduction',
          ),
        );
      if (deduction === 'full' && provisionalProrata(loaded.profile, taxPoint).found)
        issues.push(
          block(
            'FLAT_RATE_PRORATA',
            'Compania are pro rata în acest an: deducerea compensației pe bază de pro rata (art. 297–301) nu este încă acoperită.',
          ),
        );
      if (input.compensationAccount)
        issues.push(
          block(
            'SALE_FIELDS',
            'Contul compensației se indică doar pentru livrarea agricultorului.',
          ),
        );
      const fixedAssets = input.parts.filter((value) => /^2[01]/.test(value.account)).length;
      input.parts.forEach((value, index) => {
        if (!/^(6|2[01])/.test(value.account))
          issues.push(
            block(
              'ACCOUNT',
              /^3/.test(value.account)
                ? 'Stocurile nu sunt încă acoperite (modulul de stocuri, G1): înregistrați achiziția pe un cont de cheltuieli (6xx) sau de imobilizări (20x, 21x).'
                : 'Folosiți un cont de cheltuieli (6xx) sau de imobilizări (20x, 21x).',
              `parts.${index}.account`,
            ),
          );
      });
      if (fixedAssets && fixedAssets !== input.parts.length)
        issues.push(
          block(
            'ACCOUNT_MIX',
            'Imobilizările și cheltuielile de pe aceeași factură cer furnizori diferiți (404 și 401): înregistrați-le separat.',
            'parts',
          ),
        );
      if (issues.some((issue) => issue.severity === 'block') || !rule)
        return { effect: null, issues };
      item = {
        ref: 'counterparty',
        kind: 'payable',
        controlAccount: fixedAssets ? '404' : '401',
        partyId,
        currency: LEDGER_CURRENCY,
        normalSide: 'C',
        mayReverse: false,
        documentId: record.id,
      };
      input.parts.forEach((value, index) =>
        lines.push({ account: value.account, side: 'D', bani: amounts[index]! }),
      );
      if (deduction === 'full') {
        deducted = compensation;
        lines.push({ account: rule.account, side: 'D', bani: compensation });
      } else {
        // Not deducted: each part bears its share, in the expense or the asset.
        allocate(compensation, amounts).forEach((share, index) => {
          if (share !== 0n)
            lines.push({
              account: input.parts[index]!.account,
              side: 'D',
              bani: share,
              memo: 'Compensație în cotă forfetară nedeductibilă',
            });
        });
      }
      const taxLine = deduction === 'full' ? lines.length - 1 : undefined;
      lines.push({
        account: item.controlAccount,
        side: 'C',
        bani: total,
        openItem: item.ref,
        partyId,
      });
      taxEntries.push({
        key: 'vat.input',
        tax: 'VAT',
        code: schemeCodes.flatRate,
        direction: 'input',
        baseBani: price,
        taxBani: compensation,
        deductibleBani: deducted,
        ledgerBani: deducted,
        ...(taxLine !== undefined ? { line: taxLine } : {}),
        taxPoint,
        exigibility: taxPoint,
        taxPeriod: vatPeriodOf(loaded, taxPoint),
        documentId: record.id,
        partyId,
        attributes: {
          documentType: body.documentType,
          number: body.number,
          counterpartyTaxId: body.supplier.taxId,
          counterpartyCountry: body.supplier.country,
          percent: rule.percent,
          register: registered!.value.evidenceId,
        },
      });
      summary = `${body.number} din ${body.issueDate}: produse agricole ${lei(price)} lei de la ${body.supplier.name}, agricultor în regim special, și compensația în cotă forfetară de ${rule.percent}%, ${lei(compensation)} lei, ${deducted ? 'dedusă ca TVA (art. 315^1 alin. (17))' : 'nedeductibilă, în cheltuială'}.`;
    } else {
      // The farmer: a PFA, II, IF or individual in the regime, outside VAT.
      const form = profileAt(loaded, 'entity.form', taxPoint);
      if (!form)
        issues.push(
          questionIssue(
            'FLAT_RATE_FARMER',
            'Înregistrați forma juridică (entity.form): regimul special pentru agricultori îl aplică persoanele fizice, PFA, întreprinderile individuale și familiale.',
            {
              kind: 'profile.fact',
              subject: { kind: 'profile', id: 'entity.form' },
              params: { axis: 'entity.form', from: taxPoint },
            },
          ),
        );
      else if (form === 'srl')
        issues.push(
          block(
            'FLAT_RATE_FARMER',
            'Regimul special pentru agricultori îl aplică persoanele fizice, PFA, întreprinderile individuale și familiale (art. 315^1 alin. (1) lit. b)), nu o societate.',
          ),
        );
      const regime = profileAt(loaded, 'vat.agriculture', taxPoint);
      if (regime !== 'special')
        issues.push(
          questionIssue(
            'FLAT_RATE_FARMER',
            regime === 'none'
              ? 'Compania a înregistrat că nu aplică regimul special pentru agricultori (vat.agriculture none) la această dată.'
              : 'Înregistrați de când este compania înscrisă în Registrul agricultorilor care aplică regimul special (vat.agriculture special, cu notificarea și extrasul): compensația se înscrie în facturi numai după înscriere (norme pct. 87^1 alin. (5)).',
            {
              kind: 'profile.fact',
              subject: { kind: 'profile', id: 'vat.agriculture' },
              params: { axis: 'vat.agriculture', from: taxPoint },
            },
          ),
        );
      if (profileAt(loaded, 'vat.status', taxPoint) === 'normal_vat')
        issues.push(
          block(
            'FLAT_RATE_FARMER',
            'Compania este înregistrată în scopuri de TVA: de la înregistrare nu mai aplică regimul special pentru agricultori (art. 315^1 alin. (14)).',
          ),
        );
      const customerId = body.customer.taxId.toUpperCase().replace(/\s+/g, '');
      if (isValidCnp(customerId) || !isValidCui(customerId.replace(/^RO/, '')))
        issues.push(
          block(
            'FLAT_RATE_CUSTOMER',
            `Compensația se aplică livrărilor către alte persoane impozabile (art. 315^1 alin. (3) lit. a)); ${body.customer.name} nu are un cod fiscal de persoană impozabilă.`,
          ),
        );
      issues.push(
        warn(
          'FLAT_RATE_CUSTOMER',
          `Confirmați că ${body.customer.name} nu este un agricultor în regimul special: livrările către ei nu poartă compensație (art. 315^1 alin. (3) lit. a)).`,
        ),
      );
      if (input.deduction)
        issues.push(
          block('SALE_FIELDS', 'Deducerea se indică doar pentru o achiziție.', 'deduction'),
        );
      if (!input.compensationAccount)
        issues.push(
          block(
            'FLAT_RATE_ACCOUNT',
            'Indicați contul de venituri al compensației cuvenite (compensationAccount): legea nu îl numește, contabilul îl alege.',
            'compensationAccount',
          ),
        );
      else if (!input.compensationAccount.startsWith('7'))
        issues.push(
          block('ACCOUNT', 'Compensația este un venit (clasa 7).', 'compensationAccount'),
        );
      input.parts.forEach((value, index) => {
        if (!value.account.startsWith('70'))
          issues.push(
            block('ACCOUNT', 'Folosiți un cont de venituri (70x).', `parts.${index}.account`),
          );
      });
      if (issues.some((issue) => issue.severity === 'block') || !rule)
        return { effect: null, issues };
      item = {
        ref: 'counterparty',
        kind: 'receivable',
        controlAccount: '4111',
        partyId,
        currency: LEDGER_CURRENCY,
        normalSide: 'D',
        mayReverse: false,
        documentId: record.id,
      };
      lines.push({ account: '4111', side: 'D', bani: total, openItem: item.ref, partyId });
      input.parts.forEach((value, index) =>
        lines.push({ account: value.account, side: 'C', bani: amounts[index]! }),
      );
      lines.push({
        account: input.compensationAccount!,
        side: 'C',
        bani: compensation,
        memo: `Compensație în cotă forfetară ${rule.percent}%`,
      });
      summary = `${body.number} din ${body.issueDate}: produse agricole ${lei(price)} lei către ${body.customer.name} și compensația în cotă forfetară de ${rule.percent}% cuvenită, ${lei(compensation)} lei, fără TVA (art. 315^1 alin. (4), (8)).`;
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: body.issueDate as LocalDate,
      journalClass: 'general',
      journalCode: sale ? 'VANZARI' : 'CUMPARARI',
      description: `${sale ? 'Factură emisă' : 'Factură primită'} ${body.number}, regimul special pentru agricultori`,
      lines,
      openItems: [item],
      taxEntries,
      schedules: [],
      explanation: {
        summary,
        details: {
          taxPoint,
          price: lei(price),
          compensation: lei(compensation),
          percent: rule!.percent,
          ...(sale ? {} : { deducted: lei(deducted) }),
          clauses: FLAT_RATE_CLAUSES,
        },
      },
    };
    return { effect, issues };
  },
};
