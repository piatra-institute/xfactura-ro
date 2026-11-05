import { DomainError } from '../../errors';
import { divRound, formatScaled, parseScaled } from '../../money';
import { element, leaf, serializeXml } from '../../xml/write';
import {
  d406AccountId,
  d406AccountType,
  d406InStandardChart,
  d406StandardAccount,
  syntheticOf,
} from './accounts';
import {
  address,
  balance,
  checkAddress,
  checkDate,
  checkHeader,
  checkText,
  d406Namespace,
  headerElement,
  partyIdError,
  prefixed,
  type D406Address,
  type D406Check,
  type D406HeaderInput,
} from './d406';
import { assetTransactionTypes } from './data/codes';

/**
 * The annual assets file of D406 ("D406 Active", HeaderComment A): the fixed-asset register of a
 * financial year, filed once a year by the annual statements' deadline (OPANAF nr. 1.783/2021
 * anexa nr. 4 pct. 1, 7 and 8), after ANAF's schema 2.4.9 and RO_SAFT_SchemaDefCod_05.02.2026.xlsx
 * (column "Raportare Anuala - Active"): the Header, the GeneralLedgerAccounts of the assets,
 * Assets and AssetTransactions. ANAF's D406 validator (J2.2.8) wants the other sections present
 * and empty, as the structure lists them (Customers to Owners, GeneralLedgerEntries, SalesInvoices
 * to MovementOfGoods), and a selection of twelve months; it rejects assets in a monthly file.
 *
 * Where ANAF's documents differ, `presentation` holds the reading (`ro.d406.assets.presentation`,
 * an expert question). The rest follows ANAF's answers (Întrebări și răspunsuri SAF-T v1.2) and,
 * where they are silent, its worked examples (Exemple_Imobilizari): every asset of the register
 * held in the year, with its value at the start and the end, the year's additions, disposals and
 * depreciation; decreases negative (the depreciation of the year and accumulated, the value
 * leaving); the valuation "contabil" (MF.A.14, as the guide and the examples write it) and
 * „CONTABILĂ” (SD.AT.15, as the guide and the answers write it); the catalogue code of HG nr.
 * 2.139/2004 as ValuationClass; no investment subsidies, transfers, revaluations or impairment
 * (the engine books none on assets: the caller refuses a register that has them).
 *
 * Amounts are lei with two decimals, as decimal strings; balances are signed, debit positive.
 */

/** The readings ANAF's documents leave open (`ro.d406.assets.presentation`). */
export type D406AssetsPresentation = {
  /** DepreciationPercentage: in percent, as ANAF's answer to MF.A.26 says ("1% se înscrie ca
   * 1.00"), or as a fraction of one, as ANAF's worked examples write it (0.20). */
  percentage: 'percent' | 'fraction';
  /** AssetDisposal: the gross value that left (the examples: the asset account's credit
   * turnover), or its net book value (the structure: "book value of the disposals"). */
  disposal: 'gross' | 'net';
};

/** An account of the assets, with its balances at the year's start and end. */
export type D406AssetsAccount = {
  /** The engine's account code: synthetic (2131) or analytical (2131.01). */
  code: string;
  /** AccountID when the code has no numeric form. */
  id?: string;
  description: string;
  /** Opening and closing balances, debit positive. */
  opening: string;
  closing: string;
};

/** A supplier as AssetSupplier names it: SupplierName, SupplierID (d406PartyId), PostalAddress. */
export type D406AssetParty = { id: string; name: string; address: D406Address };

/** A fixed asset of the register held in the year. */
export type D406AssetCard = {
  /** AssetID: the inventory number. */
  id: string;
  /** AccountID: the asset's account. */
  account: string;
  /** The account its depreciation accumulates on (28x). */
  depreciationAccount: string;
  description: string;
  supplier?: D406AssetParty;
  /** DateOfAcquisition: the purchase's (or the lease's) date; the commissioning date for an
   * asset without one. */
  acquired: string;
  /** StartUpDate: the commissioning date. */
  commissioned: string;
  /** ValuationClass: the code of the fixed-asset catalogue (HG nr. 2.139/2004). */
  catalogCode: string;
  /** The accounting life, in months: AssetLifeYear when whole years, else AssetLifeMonth. */
  lifeMonths: number;
  /** At the year's start, positive: the gross value and the depreciation accumulated. */
  costBegin: string;
  depreciationBegin: string;
  /** In the year, positive: the value that entered, the value that left, the depreciation
   * booked and the depreciation taken off with the disposal. */
  addition: string;
  disposal: string;
  depreciation: string;
  depreciationRemoved: string;
};

/** A movement of an asset in the register (AssetTransaction). */
export type D406AssetTransaction = {
  /** AssetTransactionID: unique in the register. */
  id: string;
  /** AssetID */
  asset: string;
  /** AssetTransactionType of Nomenclator imobilizari (10 purchase, 20 sale, 30 depreciation,
   * 50 scrapping, 130 other). */
  type: string;
  description?: string;
  date: string;
  /** The supplier for a purchase; the company itself for the other movements. */
  supplier?: D406AssetParty;
  /** TransactionID: the entry of the journal it was booked by. */
  transaction: string;
  /** AcquisitionAndProductionCostsOnTransaction, BookValueOnTransaction and
   * AssetTransactionAmount, signed: a decrease is negative. */
  cost: string;
  bookValue: string;
  amount: string;
};

export type D406Assets = D406HeaderInput & {
  /** The financial year: SelectionStartDate and SelectionEndDate. */
  year: { start: string; end: string };
  presentation: D406AssetsPresentation;
  accounts: D406AssetsAccount[];
  assets: D406AssetCard[];
  transactions: D406AssetTransaction[];
};

const amountPattern = /^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const lei = (value: string) => parseScaled(value, 2);
const text = (cents: bigint) => formatScaled(cents, 2);
const isDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

export type D406AssetTotals = {
  id: string;
  costEnd: bigint;
  accumulatedEnd: bigint;
  bookValueBegin: bigint;
  bookValueEnd: bigint;
  /** AssetDisposal as written: negative. */
  disposal: bigint;
  life: { years: number } | { months: number };
  /** DepreciationPercentage as written. */
  percentage: string;
};

/** The values the file derives from each asset's movements. Throws on an amount it cannot read. */
export function calculateD406Assets(model: D406Assets): D406AssetTotals[] {
  return model.assets.map((asset) => {
    for (const key of [
      'costBegin',
      'depreciationBegin',
      'addition',
      'disposal',
      'depreciation',
      'depreciationRemoved',
    ] as const)
      if (!amountPattern.test(asset[key]) || asset[key].startsWith('-'))
        throw new DomainError(
          'D406A_AMOUNT',
          `${asset.id}: ${key} se scrie în lei, pozitiv, cu cel mult două zecimale.`,
        );
    const costEnd = lei(asset.costBegin) + lei(asset.addition) - lei(asset.disposal);
    const accumulatedEnd =
      lei(asset.depreciationBegin) + lei(asset.depreciation) - lei(asset.depreciationRemoved);
    const whole = asset.lifeMonths % 12 === 0;
    const periods = BigInt(whole ? asset.lifeMonths / 12 : asset.lifeMonths);
    // The normal rate per year (or month) of a straight-line depreciation over the life.
    const percentage =
      model.presentation.percentage === 'percent'
        ? text(divRound(10000n, periods, 'halfAwayFromZero'))
        : formatScaled(divRound(10000n, periods, 'halfAwayFromZero'), 4);
    return {
      id: asset.id,
      costEnd,
      accumulatedEnd,
      bookValueBegin: lei(asset.costBegin) - lei(asset.depreciationBegin),
      bookValueEnd: costEnd - accumulatedEnd,
      disposal: -(model.presentation.disposal === 'gross'
        ? lei(asset.disposal)
        : lei(asset.disposal) - lei(asset.depreciationRemoved)),
      life: whole ? { years: asset.lifeMonths / 12 } : { months: asset.lifeMonths },
      percentage,
    };
  });
}

/**
 * The structure's rules, the validator's (formats, the nomenclature, the account plan, a year of
 * twelve months) and the file's own consistency: each asset's values add up, its movements are
 * the year's, and the register agrees with the accounts listed (the values on the asset
 * accounts, the depreciation on the depreciation accounts, at both ends of the year).
 */
export function checkD406Assets(model: D406Assets): D406Check[] {
  const checks: D406Check[] = [];
  const error = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'error', path, message });
  checkHeader(error, model);

  const { start, end } = model.year;
  const validYear = isDate(start) && isDate(end) && start <= end;
  if (!validYear)
    error('D406A_YEAR', 'year', 'Exercițiul financiar are o dată de început și una de sfârșit.');
  else if (monthIndex(end) - monthIndex(start) !== 11)
    error(
      'D406A_YEAR',
      'year',
      `Fișierul anual cuprinde un exercițiu de 12 luni (${start} – ${end} nu are): validatorul ANAF respinge altă perioadă.`,
    );
  if (!['percent', 'fraction'].includes(model.presentation.percentage))
    error(
      'D406A_PRESENTATION',
      'presentation.percentage',
      'Rata de amortizare: percent sau fraction.',
    );
  if (!['gross', 'net'].includes(model.presentation.disposal))
    error('D406A_PRESENTATION', 'presentation.disposal', 'Ieșirile: gross sau net.');

  const amount = (path: string, value: string, signed = false) => {
    if (!amountPattern.test(value) || (!signed && value.startsWith('-'))) {
      error(
        'D406A_AMOUNT',
        path,
        `Suma se scrie în lei${signed ? '' : ', pozitivă,'} cu cel mult două zecimale.`,
      );
      return false;
    }
    return true;
  };

  // Accounts.
  const accounts = new Map<string, D406AssetsAccount>();
  model.accounts.forEach((account, index) => {
    const path = `accounts.${index}`;
    if (accounts.has(account.code))
      error('D406_ACCOUNT_DUPLICATE', path, `Contul ${account.code} apare de mai multe ori.`);
    accounts.set(account.code, account);
    checkText(error, `${path}.description`, account.description, 'denumirea contului', 256, true);
    amount(`${path}.opening`, account.opening, true);
    amount(`${path}.closing`, account.closing, true);
    const id = account.id ?? d406AccountId(account.code);
    if (!d406AccountType(account.code) || !d406StandardAccount(account.code))
      error(
        'D406_ACCOUNT',
        path,
        `Contul ${account.code} nu face parte din planul de conturi OMFP 1802/2014.`,
      );
    else if (
      id === undefined ||
      !id.startsWith(syntheticOf(account.code)) ||
      !d406InStandardChart(id)
    )
      error(
        'D406_ACCOUNT_ID',
        `${path}.id`,
        `Contul ${account.code} nu are un AccountID care să corespundă planului de conturi standard.`,
      );
  });

  // Assets.
  const assets = new Map<string, D406AssetCard>();
  let valid = true;
  model.assets.forEach((asset, index) => {
    const path = `assets.${index}`;
    if (assets.has(asset.id))
      error(
        'D406A_ASSET_DUPLICATE',
        path,
        `Numărul de inventar ${asset.id} apare de mai multe ori.`,
      );
    assets.set(asset.id, asset);
    checkText(error, `${path}.id`, asset.id, 'numărul de inventar', 35, true);
    checkText(error, `${path}.description`, asset.description, 'descrierea activului', 256, true);
    checkDate(error, `${path}.acquired`, asset.acquired, 'Data achiziției');
    checkDate(error, `${path}.commissioned`, asset.commissioned, 'Data punerii în funcțiune');
    if (validYear && isDate(asset.acquired) && asset.acquired > end)
      error('D406A_DATE', `${path}.acquired`, `${asset.id} este achiziționat după exercițiu.`);
    if (!/^\d+(\.\d+){0,5}\.?$/.test(asset.catalogCode) || asset.catalogCode.length > 18)
      error(
        'D406A_CATALOG',
        `${path}.catalogCode`,
        `${asset.id}: codul de clasificare (HG nr. 2.139/2004) are forma 2.2.9, cel mult 18 caractere.`,
      );
    if (!Number.isInteger(asset.lifeMonths) || asset.lifeMonths < 1)
      error('D406A_LIFE', `${path}.lifeMonths`, `${asset.id}: durata de utilizare este în luni.`);
    for (const key of ['account', 'depreciationAccount'] as const)
      if (!accounts.has(asset[key]))
        error(
          'D406_ACCOUNT_UNKNOWN',
          `${path}.${key}`,
          `Contul ${asset[key]} al activului ${asset.id} nu figurează în lista conturilor.`,
        );
    if (asset.supplier) {
      const reason = partyIdError(asset.supplier.id, false);
      if (reason)
        error(
          'D406_PARTY_ID',
          `${path}.supplier.id`,
          `Codul furnizorului ${asset.supplier.id}: ${reason}.`,
        );
      checkText(
        error,
        `${path}.supplier.name`,
        asset.supplier.name,
        'denumirea furnizorului',
        70,
        true,
      );
      checkAddress(error, `${path}.supplier.address`, asset.supplier.address);
    }
    for (const key of [
      'costBegin',
      'depreciationBegin',
      'addition',
      'disposal',
      'depreciation',
      'depreciationRemoved',
    ] as const)
      if (!amount(`${path}.${key}`, asset[key])) valid = false;
  });

  // Movements.
  const ids = new Set<string>();
  model.transactions.forEach((movement, index) => {
    const path = `transactions.${index}`;
    if (ids.has(movement.id))
      error(
        'D406A_TRANSACTION_DUPLICATE',
        path,
        `Tranzacția ${movement.id} apare de mai multe ori.`,
      );
    ids.add(movement.id);
    checkText(error, `${path}.id`, movement.id, 'numărul tranzacției', 70, true);
    checkText(error, `${path}.transaction`, movement.transaction, 'nota contabilă', 70, true);
    checkText(error, `${path}.description`, movement.description, 'descrierea tranzacției', 256);
    checkDate(error, `${path}.date`, movement.date, 'Data tranzacției');
    if (!assets.has(movement.asset))
      error(
        'D406A_ASSET_UNKNOWN',
        `${path}.asset`,
        `Activul ${movement.asset} nu figurează în listă.`,
      );
    if (!assetTransactionTypes[movement.type])
      error(
        'D406A_TRANSACTION_TYPE',
        `${path}.type`,
        `Tipul de tranzacție ${movement.type} nu există în Nomenclator imobilizari.`,
      );
    if (validYear && isDate(movement.date) && (movement.date < start || movement.date > end))
      error('D406A_DATE', `${path}.date`, `Tranzacția ${movement.id} este în afara exercițiului.`);
    if (movement.supplier) {
      const reason = partyIdError(movement.supplier.id, false);
      if (reason)
        error(
          'D406_PARTY_ID',
          `${path}.supplier.id`,
          `Codul furnizorului ${movement.supplier.id}: ${reason}.`,
        );
      checkText(
        error,
        `${path}.supplier.name`,
        movement.supplier.name,
        'denumirea furnizorului',
        70,
        true,
      );
      checkAddress(error, `${path}.supplier.address`, movement.supplier.address);
    }
    for (const key of ['cost', 'bookValue', 'amount'] as const)
      if (!amount(`${path}.${key}`, movement[key], true)) valid = false;
  });
  if (checks.length || !valid) return checks;

  // Each asset's values add up, and its movements are the year's.
  const totals = calculateD406Assets(model);
  model.assets.forEach((asset, index) => {
    const path = `assets.${index}`;
    const total = totals[index]!;
    if (total.costEnd < 0n || total.accumulatedEnd < 0n || total.bookValueEnd < 0n)
      error(
        'D406A_VALUES',
        path,
        `${asset.id}: valoarea sau amortizarea de la sfârșitul exercițiului ar fi negativă.`,
      );
    const movements = model.transactions.filter((item) => item.asset === asset.id);
    const sum = (types: string[], key: 'cost' | 'bookValue') =>
      movements
        .filter((item) => types.includes(item.type))
        .reduce((value, item) => value + lei(item[key]), 0n);
    if (sum(['10'], 'cost') !== lei(asset.addition))
      error(
        'D406A_TRANSACTIONS',
        path,
        `${asset.id}: achizițiile din tranzacții nu sunt intrările exercițiului (${asset.addition}).`,
      );
    if (sum(['30'], 'bookValue') !== -lei(asset.depreciation))
      error(
        'D406A_TRANSACTIONS',
        path,
        `${asset.id}: amortizarea din tranzacții nu este cea a exercițiului (${asset.depreciation}).`,
      );
    if (
      sum(['20', '50', '130'], 'bookValue') !==
      -(lei(asset.disposal) - lei(asset.depreciationRemoved))
    )
      error(
        'D406A_TRANSACTIONS',
        path,
        `${asset.id}: ieșirile din tranzacții nu sunt valoarea netă scoasă din evidență.`,
      );
  });
  // The register agrees with the accounts at both ends of the year.
  const byAccount = new Map<string, { opening: bigint; closing: bigint }>();
  const add = (code: string, opening: bigint, closing: bigint) => {
    const total = byAccount.get(code) ?? { opening: 0n, closing: 0n };
    total.opening += opening;
    total.closing += closing;
    byAccount.set(code, total);
  };
  model.assets.forEach((asset, index) => {
    add(asset.account, lei(asset.costBegin), totals[index]!.costEnd);
    add(asset.depreciationAccount, -lei(asset.depreciationBegin), -totals[index]!.accumulatedEnd);
  });
  // Every account listed is an asset's or its depreciation's: what the register does not hold
  // on it is missing from the register.
  model.accounts.forEach((account, index) => {
    const code = account.code;
    const total = byAccount.get(code) ?? { opening: 0n, closing: 0n };
    if (lei(account.opening) !== total.opening || lei(account.closing) !== total.closing)
      error(
        'D406A_REGISTER',
        `accounts.${index}`,
        `Registrul mijloacelor fixe nu corespunde contului ${code}: soldurile contului sunt ${account.opening} și ${account.closing}, ale registrului ${text(total.opening)} și ${text(total.closing)}.`,
      );
  });
  return checks;
}

/**
 * Writes the annual assets file as one `AuditFile` in the d406 namespace, with the sections the
 * validator wants present and empty. Throws on the errors checkD406Assets reports.
 */
export function writeD406Assets(model: D406Assets): string {
  const blocking = checkD406Assets(model).find((check) => check.severity === 'error');
  if (blocking) throw new DomainError(blocking.code, blocking.message);
  const totals = calculateD406Assets(model);
  const accountIds = new Map(
    model.accounts.map((account) => [account.code, account.id ?? d406AccountId(account.code)!]),
  );
  const supplier = (party: D406AssetParty) => [
    leaf('SupplierName', party.name),
    leaf('SupplierID', party.id),
    address(party.address, 'PostalAddress'),
  ];
  const valuation = (asset: D406AssetCard, total: D406AssetTotals) =>
    element(
      'Valuation',
      null,
      leaf('AssetValuationType', 'contabil'),
      leaf('ValuationClass', asset.catalogCode),
      leaf('AcquisitionAndProductionCostsBegin', text(lei(asset.costBegin))),
      leaf('AcquisitionAndProductionCostsEnd', text(total.costEnd)),
      leaf('InvestmentSupport', '0.00'),
      'years' in total.life
        ? leaf('AssetLifeYear', String(total.life.years))
        : leaf('AssetLifeMonth', String(total.life.months)),
      leaf('AssetAddition', text(lei(asset.addition))),
      leaf('Transfers', '0.00'),
      leaf('AssetDisposal', text(total.disposal)),
      leaf('BookValueBegin', text(total.bookValueBegin)),
      leaf('DepreciationMethod', 'LINIARĂ'),
      leaf('DepreciationPercentage', total.percentage),
      leaf('DepreciationForPeriod', text(-lei(asset.depreciation))),
      leaf('AppreciationForPeriod', '0.00'),
      element(
        'ExtraordinaryDepreciationsForPeriod',
        null,
        element(
          'ExtraordinaryDepreciationForPeriod',
          null,
          // No impairment: ANAF's answer to MF.A.33 asks for 0.
          leaf('ExtraordinaryDepreciationMethod', '0'),
          leaf('ExtraordinaryDepreciationAmountForPeriod', '0.00'),
        ),
      ),
      leaf('AccumulatedDepreciation', text(-total.accumulatedEnd)),
      leaf('BookValueEnd', text(total.bookValueEnd)),
    );
  const root = prefixed(
    element(
      'AuditFile',
      null,
      headerElement(model, model.year, 'A'),
      element(
        'MasterFiles',
        null,
        element(
          'GeneralLedgerAccounts',
          null,
          model.accounts.map((account) => {
            const type = d406AccountType(account.code)!;
            const creditWhenZero = type === 'Pasiv';
            return element(
              'Account',
              null,
              leaf('AccountID', accountIds.get(account.code)),
              leaf('AccountDescription', account.description),
              leaf('StandardAccountID', d406StandardAccount(account.code)),
              leaf('AccountType', type),
              balance('Opening', lei(account.opening), creditWhenZero),
              balance('Closing', lei(account.closing), creditWhenZero),
            );
          }),
        ),
        element('Customers', null),
        element('Suppliers', null),
        element('TaxTable', null),
        element('UOMTable', null),
        element('AnalysisTypeTable', null),
        element('MovementTypeTable', null),
        element('Products', null),
        element('Owners', null),
        element(
          'Assets',
          null,
          model.assets.map((asset, index) =>
            element(
              'Asset',
              null,
              leaf('AssetID', asset.id),
              leaf('AccountID', accountIds.get(asset.account)),
              leaf('Description', asset.description),
              asset.supplier && element('AssetSupplier', null, supplier(asset.supplier)),
              leaf('DateOfAcquisition', asset.acquired),
              leaf('StartUpDate', asset.commissioned),
              element('Valuations', null, valuation(asset, totals[index]!)),
            ),
          ),
        ),
      ),
      element('GeneralLedgerEntries', null),
      element(
        'SourceDocuments',
        null,
        element('SalesInvoices', null),
        element('PurchaseInvoices', null),
        element('Payments', null),
        element('MovementOfGoods', null),
        element(
          'AssetTransactions',
          null,
          leaf('NumberOfAssetTransactions', String(model.transactions.length)),
          model.transactions.map((movement) =>
            element(
              'AssetTransaction',
              null,
              leaf('AssetTransactionID', movement.id),
              leaf('AssetID', movement.asset),
              leaf('AssetTransactionType', movement.type),
              leaf('Description', movement.description),
              leaf('AssetTransactionDate', movement.date),
              movement.supplier && element('AssetSupplier', null, supplier(movement.supplier)),
              leaf('TransactionID', movement.transaction),
              element(
                'AssetTransactionValuations',
                null,
                element(
                  'AssetTransactionValuation',
                  null,
                  leaf('AssetValuationType', 'CONTABILĂ'),
                  leaf('AcquisitionAndProductionCostsOnTransaction', text(lei(movement.cost))),
                  leaf('BookValueOnTransaction', text(lei(movement.bookValue))),
                  leaf('AssetTransactionAmount', text(lei(movement.amount))),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return serializeXml({ ...root, attributes: [['xmlns:nsSAFT', d406Namespace]] });
}
