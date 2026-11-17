'use client';

import AccountSheet from './account-sheet';
import Assets from './assets';
import Inventory from './inventory';
import Journal from './journal';
import { useAccountingNavigation } from './navigation';
import Payroll from './payroll';
import { RecordNames } from './record-names';
import { EntryDetail, MonthChoice, useRegisterMonth } from './register-common';
import Stock from './stock';
import TrialBalance from './trial-balance';
import VatJournals from './vat-journals';
import { useWorkspace } from './workspace';

/** Each register, the read operation it rests on, and whether it is read for a month. */
const registers = [
  {
    id: 'balanta',
    label: 'Balanța de verificare',
    operation: 'ledger.trialBalance',
    monthly: true,
  },
  { id: 'fisa', label: 'Fișa contului', operation: 'ledger.generalLedger', monthly: true },
  { id: 'jurnal', label: 'Registrul jurnal', operation: 'ledger.journal', monthly: true },
  { id: 'tva', label: 'Jurnale de TVA', operation: 'vat.journal', monthly: false },
  {
    id: 'inventar',
    label: 'Registrul inventar',
    operation: 'ledger.inventoryRegister',
    monthly: true,
  },
  { id: 'stocuri', label: 'Stocuri', operation: 'stock.register', monthly: true },
  { id: 'mijloace', label: 'Mijloace fixe', operation: 'assets.list', monthly: false },
  { id: 'salarii', label: 'Salarii', operation: 'payroll.runs.list', monthly: false },
] as const;
type RegisterId = (typeof registers)[number]['id'];

/** The filters that belong to one register's own view; choosing another register drops them. */
export const registerReset = {
  registerEntry: null,
  registerEntryDate: null,
  stockItem: null,
  stockWarehouse: null,
  registerAsset: null,
  payrollRun: null,
};

/** The registers a person may read, as tabs, and the one the address selects. */
export function registerTabs(can: (operation: string) => boolean, requested: string | null) {
  const visible = registers.filter((register) => can(register.operation));
  const active = visible.find((register) => register.id === requested) ?? visible[0];
  return {
    items: visible.map(({ id, label }) => ({ id, label })),
    active: active?.id ?? null,
  };
}

export default function Registers() {
  return (
    <RecordNames>
      <RegisterView />
    </RecordNames>
  );
}

function RegisterView() {
  const { year, can } = useWorkspace();
  const { params } = useAccountingNavigation();
  const { month, first, last } = useRegisterMonth();
  const active = registers.find(
    (register) => register.id === registerTabs(can, params.get('register')).active,
  );
  const entryId = params.get('registerEntry');
  return !year || !month || !first || !last ? (
    <p aria-busy="true">Se încarcă registrele…</p>
  ) : !active ? (
    <p className="acc-empty">Niciun registru disponibil pentru rolul dumneavoastră.</p>
  ) : entryId ? (
    <EntryDetail entryId={entryId} entryDate={params.get('registerEntryDate')} month={month} />
  ) : (
    <>
      {active.monthly ? <MonthChoice month={month} first={first} last={last} /> : null}
      <Register id={active.id} month={month} />
    </>
  );
}

function Register({ id, month }: { id: RegisterId; month: string }) {
  switch (id) {
    case 'balanta':
      return <TrialBalance month={month} />;
    case 'fisa':
      return <AccountSheet month={month} />;
    case 'jurnal':
      return <Journal month={month} />;
    case 'tva':
      return <VatJournals month={month} />;
    case 'inventar':
      return <Inventory month={month} />;
    case 'stocuri':
      return <Stock month={month} />;
    case 'mijloace':
      return <Assets />;
    case 'salarii':
      return <Payroll />;
  }
}
