import { z } from 'zod';
import {
  accountCodePattern,
  partyStatusKey,
  profileAt,
  vatPeriodOf,
  type Effect,
  type Issue,
  type LineSpec,
  type OpenItemSpec,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import {
  allocate,
  divRound,
  formatMoney,
  LEDGER_CURRENCY,
  parseMoney,
  parseScaled,
} from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { isValidCui } from '../identifiers';
import { chargeabilityOf, invoiceKinds } from '../treatments/invoices';
import {
  reverseChargeCategories,
  reverseChargeCategoryIds,
  type ReverseChargeCategory,
  type ReverseChargeRule,
} from './parameters';

/*
 * The domestic reverse charge (Codul fiscal art. 331): for the goods and services the article
 * lists, supplied in Romania between two persons registered for VAT, the supplier charges no VAT
 * and writes «taxare inversă» (category AE in e-Factura); the buyer computes the VAT and records
 * it as both collected and deductible (4426 = 4427, norme pct. 109 alin. (1)), deducting it under
 * art. 297–301. Goods that need stock (waste and metals, timber, cereals, gold, phones,
 * electronics) are booked without stock movements: the stock module (G1) does not exist yet, so
 * a purchase goes to an expense or a fixed asset, never to class 3.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
export const REVERSE_CHARGE_CLAUSES = [
  `${CODE}:art.331(1)-(3)`,
  `${CODE}:art.331(4)-(7)`,
  `${CODE}:norme.art.331.pct.109(1)`,
];

/** The semantic codes declarations read: acquisitions at their rate (`TI-A-21`: D300 rd. 12 and
 * 26, D394 C) and supplies (`TI-L`: D300 rd. 13, D394 V at rate 0). */
export const reverseChargeCodes = {
  acquisition: (rate: string) => `TI-A-${rate}`,
  supply: 'TI-L',
} as const;
export const isReverseChargeCode = (code: string) => /^TI-(A-\d+|L)$/.test(code);

/** The NC codes of art. 331 alin. (2) lit. c) (norme pct. 109 alin. (7)), which D394 reports. */
export const cerealCodes = [
  '1001',
  '1002',
  '1003',
  '1004',
  '1005',
  '10086000',
  '1201',
  '120400',
  '1205',
  '120600',
  '121291',
] as const;

/** Each category's D394 product code (Nomenclator cod produse, tip_partener 1) and whether it is
 * goods (tip_N 1) or services (2: certificates are transfers of rights). Cereals report their NC
 * code, summed under 21. */
export const d394Products: Readonly<
  Record<ReverseChargeCategory, { code: string; goods: boolean }>
> = {
  cereals: { code: '21', goods: true },
  waste: { code: '22', goods: true },
  timber: { code: '23', goods: true },
  emission_certificates: { code: '24', goods: false },
  electricity: { code: '25', goods: true },
  green_certificates: { code: '26', goods: false },
  real_estate: { code: '27', goods: true },
  gold: { code: '28', goods: true },
  mobile_phones: { code: '29', goods: true },
  integrated_circuits: { code: '30', goods: true },
  consoles_tablets_laptops: { code: '31', goods: true },
  natural_gas: { code: '36', goods: true },
};

/** Categories of goods a business normally holds in stock. */
const stockGoods: ReadonlySet<ReverseChargeCategory> = new Set([
  'waste',
  'timber',
  'cereals',
  'gold',
  'mobile_phones',
  'integrated_circuits',
  'consoles_tablets_laptops',
]);

const block = (
  code: string,
  message: string,
  path?: string,
  details?: Issue['details'],
): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const warn = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);

export const reverseChargeInput = z
  .object({
    documentId: z.uuid(),
    /** The invoice's amount (category AE) by the art. 331 category of its goods or services. */
    parts: z
      .array(
        z
          .object({
            category: z.enum(reverseChargeCategoryIds),
            /** For cereals: the NC code of the goods (norme pct. 109 alin. (7)). */
            nc: z.enum(cerealCodes).optional(),
            /** Revenue (70x) for a supply; expense (6xx) or fixed asset (20x, 21x) for a purchase. */
            account: z.string().regex(accountCodePattern),
            /** Without VAT, in lei, as the invoice states it. */
            amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
            /** A purchase: the rate the company self-assesses, the standard one or the reduced
             * one of art. 291 alin. (2). */
            rate: z.enum(['standard', 'reduced']).default('standard'),
            /** A purchase: whether the self-assessed VAT is deducted (art. 297–301). */
            deduction: z.enum(['full', 'none']).default('full'),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type ReverseChargeInput = z.infer<typeof reverseChargeInput>;
type Part = ReverseChargeInput['parts'][number];

/**
 * Whether art. 331 reverse-charges an invoice's parts on a date: each category in force, and
 * the threshold categories' amount on the invoice, together, at least the threshold (alin. (7),
 * norme pct. 109 alin. (19)). Pure, so the review specs read the alternative with it too.
 */
export function reverseChargeApplies(
  parts: readonly { category: ReverseChargeCategory; bani: bigint }[],
  rule: ReverseChargeRule,
): { applies: true } | { applies: false; reason: 'category' | 'threshold'; detail: string } {
  const outside = parts.filter((part) => !rule.categories.includes(part.category));
  if (outside.length)
    return {
      applies: false,
      reason: 'category',
      detail: [...new Set(outside.map((part) => part.category))].join(', '),
    };
  const counted = parts.filter((part) => rule.threshold.categories.includes(part.category));
  const total = counted.reduce((sum, part) => sum + part.bani, 0n);
  if (counted.length && total < ron(rule.threshold.lei))
    return { applies: false, reason: 'threshold', detail: lei(total) };
  return { applies: true };
}

function selfAssessedRate(
  part: Part,
  rules: RuleContext,
  date: LocalDate,
): { rate: string } | Issue {
  try {
    return part.rate === 'reduced'
      ? { rate: rules.param<string>('ro.vat.rate.reduced', 'vat_chargeability_date', date) }
      : {
          rate: rules.param<string>('ro.vat.rate', 'vat_chargeability_date', date, {
            category: 'S',
          }),
        };
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return block('RULE_GAP', error.message);
  }
}

/**
 * A domestic invoice under the reverse charge of art. 331 (category AE, no VAT on it), sale or
 * purchase, each part named by its category. A sale books the receivable and the revenue and
 * records the base for D300 rd. 13 and D394 (V). A purchase books the expense or asset and the
 * payable, and self-assesses the VAT at the rate in force: collected (4427) and deducted (4426),
 * or added to the expense when not deducted; D300 rd. 12 and 26, D394 (C). Refused: a party not
 * registered for VAT, a category not in force on the tax point, phones and electronics under the
 * threshold, an invoice charging VAT or mixing taxed goods, credit notes, foreign currency.
 */
export const reverseChargeRecognition: Treatment<ReverseChargeInput> = {
  id: 'invoices.reverseCharge',
  version: 1,
  description:
    'Factură internă cu taxare inversă (art. 331 din Codul fiscal): livrarea fără TVA sau achiziția cu TVA autolichidată, colectată și dedusă.',
  input: reverseChargeInput,
  agent: true,
  summary:
    'Domestic reverse-charge invoice (art. 331): a supply without VAT, or a purchase with the VAT self-assessed as collected and deducted.',
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({ documents: [input.documentId], profile: true }),
  followUp(input, loaded) {
    const record = loaded.documents.get(input.documentId);
    const parsed = invoiceDocumentSchema.safeParse(record?.body);
    if (!record?.partyId || !parsed.success) return null;
    return { partyStatus: [{ partyId: record.partyId, date: chargeabilityOf(parsed.data).date }] };
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
          block(
            'DOCUMENT_KIND',
            'Se recunosc aici facturi; notele de credit cu taxare inversă nu sunt încă acoperite.',
            'documentId',
          ),
        ],
      };
    const body = invoiceDocumentSchema.parse(record.body);
    const sale = record.kind === invoiceKinds.sale;
    const counterparty = sale ? body.customer : body.supplier;
    const issues: Issue[] = [];
    if (body.supplier.country !== 'RO' || body.customer.country !== 'RO')
      issues.push(
        block(
          'DOMESTIC',
          'Taxarea inversă a art. 331 privește doar operațiunile din țară (alin. (5)): pentru un partener din străinătate folosiți invoices.crossBorder.',
        ),
      );
    if (body.currency !== LEDGER_CURRENCY)
      issues.push(
        block('CURRENCY', 'Facturile cu taxare inversă în valută nu sunt încă acoperite.'),
      );
    const other = body.taxes.filter((tax) => tax.category !== 'AE');
    if (other.length)
      issues.push(
        block(
          'REVERSE_CHARGE_MIXED',
          `Factura are și operațiuni în alte categorii de TVA (${[...new Set(other.map((tax) => tax.category))].join(', ')}): facturile care amestecă taxarea inversă cu taxarea obișnuită nu sunt încă acoperite.`,
        ),
      );
    if (body.taxes.some((tax) => tax.category === 'AE' && ron(tax.tax) !== 0n))
      issues.push(
        block(
          'VAT_CHARGED',
          'Factura înscrie TVA pe o operațiune cu taxare inversă: furnizorul nu înscrie taxa (art. 331 alin. (3)). Cereți factura corectă; dedusă de pe această factură, taxa își pierde dreptul de deducere (norme pct. 109 alin. (4)).',
        ),
      );
    if (body.totals.prepaid !== '0.00' || body.totals.rounding !== '0.00')
      issues.push(
        block('PREPAID', 'Avansurile deduse și rotunjirile pe factură nu sunt încă acoperite.'),
      );
    const base = body.taxes
      .filter((tax) => tax.category === 'AE')
      .reduce((sum, tax) => sum + ron(tax.base), 0n);
    const amounts = input.parts.map((part) => ron(part.amount));
    const allocated = amounts.reduce((sum, value) => sum + value, 0n);
    if (allocated !== base)
      issues.push(
        block(
          'ALLOCATION',
          `Baza cu taxare inversă a facturii este ${lei(base)} lei; părțile însumează ${lei(allocated)} lei.`,
          'parts',
        ),
      );

    // The tax point: the supply's date unless the invoice came first (art. 282 alin. (1)–(2)).
    const chargeable = chargeabilityOf(body);
    const taxPoint = chargeable.date;
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
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
    else if (status !== 'normal_vat')
      issues.push(
        block(
          'REVERSE_CHARGE_PARTIES',
          'Compania nu este înregistrată în scopuri de TVA (art. 316) la data operațiunii: taxarea inversă se aplică doar între persoane înregistrate (art. 331 alin. (1)).',
        ),
      );
    const taxId = counterparty.taxId.toUpperCase().replace(/\s+/g, '');
    if (!/^RO\d+$/.test(taxId) || !isValidCui(taxId))
      issues.push(
        block(
          'REVERSE_CHARGE_PARTIES',
          `${sale ? 'Beneficiarul' : 'Furnizorul'} ${counterparty.name} nu are pe factură un cod de înregistrare în scopuri de TVA (RO…): taxarea inversă se aplică doar între persoane înregistrate (art. 331 alin. (1)).`,
        ),
      );
    const partner = record.partyId
      ? loaded.partyStatus.get(partyStatusKey(record.partyId, taxPoint))
      : undefined;
    if (!record.partyId) issues.push(block('PARTY', 'Documentul nu are partener.'));
    else if (partner && !partner.vatPayer)
      issues.push(
        block(
          'REVERSE_CHARGE_PARTIES',
          `${partner.name} (CUI ${partner.cui}) nu era înregistrat în scopuri de TVA la ${taxPoint}, după ANAF: taxarea inversă nu se aplică (art. 331 alin. (1)).`,
          undefined,
          { date: partner.date, evidenceId: partner.evidenceId },
        ),
      );
    else if (!partner)
      issues.push(
        warn(
          'REVERSE_CHARGE_PARTNER',
          `Verificați la ANAF (parties.checkStatus) că ${counterparty.name} era înregistrat în scopuri de TVA la ${taxPoint}: condiția taxării inverse (art. 331 alin. (1)).`,
          { clauses: REVERSE_CHARGE_CLAUSES },
        ),
      );

    // The article on the tax point: the categories in force and the threshold (norme pct. 109
    // alin. (17): the regime in force at the exigibility).
    let rule: ReverseChargeRule | null = null;
    try {
      rule = rules.param<ReverseChargeRule>(
        'ro.vat.reverse_charge.domestic',
        'vat_chargeability_date',
        taxPoint,
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      issues.push(block('RULE_GAP', error.message));
    }
    if (rule) {
      const applies = reverseChargeApplies(
        input.parts.map((part, index) => ({ category: part.category, bani: amounts[index]! })),
        rule,
      );
      if (!applies.applies)
        issues.push(
          applies.reason === 'category'
            ? block(
                'REVERSE_CHARGE_CATEGORY',
                `Categoria ${applies.detail} nu este cu taxare inversă la ${taxPoint}: operațiunea se taxează normal (art. 331 alin. (2) și (6)).`,
                'parts',
              )
            : block(
                'REVERSE_CHARGE_THRESHOLD',
                `Telefoanele mobile, circuitele integrate, consolele, tabletele și laptopurile de pe factură însumează ${applies.detail} lei, sub ${rule.threshold.lei} lei: se taxează normal (art. 331 alin. (7), norme pct. 109 alin. (19)). Cereți factura cu TVA.`,
                'parts',
                { threshold: rule.threshold.lei, clauses: [`${CODE}:norme.art.331.pct.109(19)`] },
              ),
        );
    }
    const fixedAssets = input.parts.filter((part) => /^2[01]/.test(part.account)).length;
    input.parts.forEach((part, index) => {
      const path = `parts.${index}`;
      if (part.category === 'cereals' && !part.nc)
        issues.push(
          block(
            'NC_CODE',
            'Pentru cereale și plante tehnice indicați codul NC al bunurilor (norme pct. 109 alin. (7)), declarat în D394.',
            `${path}.nc`,
          ),
        );
      if (part.category !== 'cereals' && part.nc)
        issues.push(block('NC_CODE', 'Codul NC se indică doar pentru cereale.', `${path}.nc`));
      if (sale ? !part.account.startsWith('70') : !/^(6|2[01])/.test(part.account))
        issues.push(
          block(
            'ACCOUNT',
            sale
              ? 'Folosiți un cont de venituri (70x).'
              : /^3/.test(part.account) && stockGoods.has(part.category)
                ? 'Stocurile nu sunt încă acoperite (modulul de stocuri, G1): înregistrați achiziția pe un cont de cheltuieli (6xx) sau de imobilizări (20x, 21x).'
                : 'Folosiți un cont de cheltuieli (6xx) sau de imobilizări (20x, 21x).',
            `${path}.account`,
          ),
        );
      if (sale && (part.rate !== 'standard' || part.deduction !== 'full'))
        issues.push(
          block(
            'SALE_FIELDS',
            'Cota și deducerea se indică doar pentru o achiziție: la livrare taxa o calculează beneficiarul.',
            path,
          ),
        );
    });
    if (!sale && fixedAssets && fixedAssets !== input.parts.length)
      issues.push(
        block(
          'ACCOUNT_MIX',
          'Imobilizările și cheltuielile de pe aceeași factură cer furnizori diferiți (404 și 401): înregistrați-le separat.',
          'parts',
        ),
      );
    const categories = new Set(input.parts.map((part) => part.category));
    if (categories.has('electricity') || categories.has('natural_gas'))
      issues.push(
        warn(
          'REVERSE_CHARGE_TRADER',
          `Energia electrică și gazele naturale se taxează invers doar către un comerciant persoană impozabilă (art. 331 alin. (2) lit. e) și l)): confirmați că ${sale ? 'beneficiarul figura' : 'compania figura'} în lista ANAF a declarațiilor pe propria răspundere (formularul 089) la data livrării, sau deține licența și declarația cerute.`,
          { clauses: REVERSE_CHARGE_CLAUSES },
        ),
      );
    if (categories.has('real_estate'))
      issues.push(
        warn(
          'REVERSE_CHARGE_REAL_ESTATE',
          'Construcțiile, părțile de construcție și terenurile se taxează invers doar când livrarea lor este taxată prin efectul legii sau prin opțiune (art. 331 alin. (2) lit. g), art. 292 alin. (2) lit. f) și alin. (3)): confirmați temeiul taxării.',
          { clauses: REVERSE_CHARGE_CLAUSES },
        ),
      );
    // A purchase self-assesses at the standard rate or, for the supplies of art. 291 alin. (2),
    // the reduced one, which the reviewer confirms.
    const rates = sale
      ? input.parts.map(() => null)
      : input.parts.map((part) => {
          const found = selfAssessedRate(part, rules, taxPoint);
          if ('code' in found) {
            issues.push(found);
            return null;
          }
          return found.rate;
        });
    if (!sale && input.parts.some((part) => part.rate === 'reduced'))
      issues.push(
        warn(
          'REDUCED_RATE',
          'Cota redusă se aplică doar livrărilor de la art. 291 alin. (2) din Codul fiscal: confirmați că bunurile se încadrează.',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const partyId = record.partyId!;
    const product = (part: Part) => part.nc ?? d394Products[part.category].code;
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const item: OpenItemSpec = {
      ref: 'counterparty',
      kind: sale ? 'receivable' : 'payable',
      controlAccount: sale ? '4111' : fixedAssets ? '404' : '401',
      partyId,
      currency: LEDGER_CURRENCY,
      normalSide: sale ? 'D' : 'C',
      mayReverse: false,
      documentId: record.id,
    };
    const attributes = (part: Part): Record<string, string> => ({
      documentType: body.documentType,
      number: body.number,
      counterpartyTaxId: counterparty.taxId,
      counterpartyCountry: counterparty.country,
      category: part.category,
      letter: reverseChargeCategories[part.category],
      product: product(part),
      goods: d394Products[part.category].goods ? '1' : '2',
    });
    // Tax entries per category and product (and, for a purchase, rate): what D394 reports.
    const groups = new Map<string, number[]>();
    input.parts.forEach((part, index) => {
      const key = `${rates[index] ?? ''}|${part.category}|${product(part)}`;
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    const keyOf = (direction: string, members: number[]) => {
      const part = input.parts[members[0]!]!;
      return groups.size === 1
        ? `vat.${direction}`
        : `vat.${direction}:${rates[members[0]!] ?? 'L'}:${part.category}:${product(part)}`;
    };
    if (sale) {
      lines.push({ account: '4111', side: 'D', bani: base, openItem: item.ref, partyId });
      input.parts.forEach((part, index) =>
        lines.push({ account: part.account, side: 'C', bani: amounts[index]! }),
      );
      for (const members of groups.values())
        taxEntries.push({
          key: keyOf('output', members),
          tax: 'VAT',
          code: reverseChargeCodes.supply,
          direction: 'output',
          baseBani: members.reduce((sum, index) => sum + amounts[index]!, 0n),
          taxBani: 0n,
          deductibleBani: 0n,
          ledgerBani: 0n,
          taxPoint,
          exigibility: taxPoint,
          taxPeriod,
          documentId: record.id,
          partyId,
          attributes: attributes(input.parts[members[0]!]!),
        });
    } else {
      input.parts.forEach((part, index) =>
        lines.push({ account: part.account, side: 'D', bani: amounts[index]! }),
      );
      lines.push({
        account: item.controlAccount,
        side: 'C',
        bani: base,
        openItem: item.ref,
        partyId,
      });
      for (const members of groups.values()) {
        const rate = rates[members[0]!]!;
        const groupBase = members.reduce((sum, index) => sum + amounts[index]!, 0n);
        // base × rate ÷ 100, the rate at four decimals: rounded once per rate and product.
        const tax = divRound(groupBase * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');
        const shares = allocate(
          tax,
          members.map((index) => amounts[index]!),
        );
        const deducted = members.reduce(
          (sum, index, i) => sum + (input.parts[index]!.deduction === 'full' ? shares[i]! : 0n),
          0n,
        );
        lines.push({ account: '4427', side: 'C', bani: tax });
        const output = lines.length - 1;
        members.forEach((index, i) => {
          if (input.parts[index]!.deduction === 'none' && shares[i]! !== 0n)
            lines.push({
              account: input.parts[index]!.account,
              side: 'D',
              bani: shares[i]!,
              memo: 'TVA nedeductibilă (taxare inversă)',
            });
        });
        if (deducted !== 0n) lines.push({ account: '4426', side: 'D', bani: deducted });
        const code = reverseChargeCodes.acquisition(rate);
        const common = {
          tax: 'VAT',
          code,
          baseBani: groupBase,
          taxBani: tax,
          taxPoint,
          exigibility: taxPoint,
          taxPeriod,
          documentId: record.id,
          partyId,
          attributes: attributes(input.parts[members[0]!]!),
        };
        taxEntries.push({
          ...common,
          key: keyOf('output', members),
          direction: 'output',
          deductibleBani: 0n,
          ledgerBani: tax,
          line: output,
        });
        taxEntries.push({
          ...common,
          key: keyOf('input', members),
          direction: 'input',
          deductibleBani: deducted,
          ledgerBani: deducted,
          ...(deducted !== 0n ? { line: lines.length - 1 } : {}),
        });
      }
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: body.issueDate as LocalDate,
      journalClass: 'general',
      journalCode: sale ? 'VANZARI' : 'CUMPARARI',
      description: `${sale ? 'Factură emisă' : 'Factură primită'} ${body.number}, taxare inversă`,
      lines,
      openItems: [item],
      taxEntries,
      schedules: [],
      explanation: {
        summary: sale
          ? `${body.number} din ${body.issueDate}: livrare cu taxare inversă (art. 331), ${lei(base)} lei fără TVA; taxa o calculează beneficiarul.`
          : `${body.number} din ${body.issueDate}: achiziție cu taxare inversă (art. 331), ${lei(base)} lei; TVA autolichidată ${lei(taxEntries.filter((entry) => entry.direction === 'output').reduce((sum, entry) => sum + entry.taxBani, 0n))} lei, colectată și dedusă (4426 = 4427).`,
        details: {
          taxPoint,
          ...(chargeable.supplied
            ? { supplyDate: chargeable.supplied, taxPointBasis: chargeable.basis }
            : {}),
          parts: input.parts.map(
            (part) =>
              `${part.category}${part.nc ? ` ${part.nc}` : ''} ${part.account} ${part.amount}${sale ? '' : ` ${part.rate} ${part.deduction}`}`,
          ),
          ...(partner
            ? { partnerStatus: { date: partner.date, evidenceId: partner.evidenceId } }
            : {}),
          // Goods that need stock are booked without stock movements until G1 exists.
          ...([...categories].some((category) => stockGoods.has(category))
            ? { stock: 'not_tracked' }
            : {}),
          clauses: REVERSE_CHARGE_CLAUSES,
        },
      },
    };
    return { effect, issues };
  },
};
