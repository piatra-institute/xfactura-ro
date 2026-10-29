import { counties } from '../ro/geo';
import type { Invoice, Party } from './model';

export type Check = { code: string; message: string; path: string };

/**
 * Fast feedback on requirements the calculator cannot enforce, mirroring EN 16931 and the
 * CIUS-RO national rules as summarized here. These are not an oracle: the official schematron
 * (scripts/validators) decides validity, and a rule is cited only where its text was checked.
 */
export function checkInvoice(invoice: Invoice): Check[] {
  const checks: Check[] = [];
  const add = (code: string, path: string, message: string) => checks.push({ code, path, message });

  for (const [role, party] of [
    ['seller', invoice.seller],
    ['buyer', invoice.buyer],
  ] as const)
    checkAddress(party, role, add);

  // CIUS-RO: VAT is stated in lei (BT-6 = RON, BT-111) when the invoice currency is another.
  if (invoice.currency !== 'RON' && (invoice.vatCurrency !== 'RON' || !invoice.vatAccountingTotal))
    add(
      'VAT_CURRENCY',
      'vatAccountingTotal',
      'Pentru o factură în valută, indicați TVA-ul total în lei.',
    );

  const categories = new Set(invoice.vatBreakdown.map((item) => item.category));
  // BR-S-02: standard-rated supplies need the seller's VAT or tax registration identifier.
  if (categories.has('S') && !invoice.seller.vatId && !invoice.seller.taxRegistrationId)
    add(
      'SELLER_VAT_ID',
      'seller.vatId',
      'Pentru TVA standard, vânzătorul trebuie să aibă cod de TVA.',
    );
  // BR-O-02: lines not subject to VAT exclude the seller's and the buyer's VAT identifiers.
  if (categories.has('O') && (invoice.seller.vatId || invoice.buyer.vatId))
    add('NOT_SUBJECT_VAT_ID', 'seller.vatId', 'Operațiunile neimpozabile nu poartă coduri de TVA.');
  // BR-AE-02/03: reverse charge needs both parties' VAT identifiers (or the buyer's legal id).
  if (
    categories.has('AE') &&
    (!invoice.seller.vatId || !(invoice.buyer.vatId || invoice.buyer.legalId))
  )
    add(
      'REVERSE_CHARGE_IDS',
      'buyer.vatId',
      'Taxarea inversă cere codurile de TVA ale ambelor părți.',
    );
  if (invoice.typeCode === '381' && invoice.precedingInvoices.length === 0)
    add(
      'CREDIT_REFERENCE',
      'precedingInvoices',
      'Nota de credit trebuie să indice factura corectată.',
    );
  return checks;
}

function checkAddress(
  party: Party,
  role: 'seller' | 'buyer',
  add: (code: string, path: string, message: string) => void,
) {
  if (party.address.country !== 'RO') return;
  const label = role === 'seller' ? 'vânzătorului' : 'cumpărătorului';
  // CIUS-RO: Romanian addresses carry the ISO 3166-2:RO county code, and Bucharest the sector.
  if (!party.address.subdivision || !counties[party.address.subdivision])
    add(
      'RO_COUNTY',
      `${role}.address.subdivision`,
      `Județul ${label} trebuie indicat prin codul ISO (de exemplu RO-CJ).`,
    );
  else if (party.address.subdivision === 'RO-B' && !/^SECTOR[1-6]$/.test(party.address.city))
    add(
      'RO_SECTOR',
      `${role}.address.city`,
      `Pentru București, localitatea ${label} este sectorul (SECTOR1–SECTOR6).`,
    );
}
