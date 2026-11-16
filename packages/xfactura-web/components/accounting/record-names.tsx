'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useAccountingData } from './use-data';
import { treatmentLabels } from './work-model';
import { useWorkspace } from './workspace';

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Some engine prompts interpolate record ids. Keep their text, replacing those references
 * with resolved names; any other internal reference stays unnamed until a read can resolve it. */
export const withoutIds = (text: string) => text.replace(uuid, 'referință păstrată');

type Member = { userId: string; name: string };
type Agent = { id: string; name: string };
const People = createContext<{ members: Member[]; agents: Agent[] }>({ members: [], agents: [] });
export function RecordNames({ children }: { children: ReactNode }) {
  const { can } = useWorkspace();
  const members = useAccountingData<Member[]>('company.members', {}, can('company.members'), true);
  const agents = useAccountingData<Agent[]>('agents.list', {}, can('agents.list'), true);
  return (
    <People.Provider value={{ members: members.data ?? [], agents: agents.data ?? [] }}>
      {children}
    </People.Provider>
  );
}
export function ActorName({ person, agent }: { person: string | null; agent?: string | null }) {
  const people = useContext(People);
  return agent ? (
    <span>Agent: {people.agents.find((row) => row.id === agent)?.name ?? 'nume indisponibil'}</span>
  ) : (
    <span>
      {people.members.find((row) => row.userId === person)?.name ??
        (person ? 'Persoană cu nume indisponibil' : 'Persoană neindicată de motor')}
    </span>
  );
}

type NamedRecord = {
  id?: string;
  name?: string;
  description?: string;
  number?: string | null;
  date?: string;
  reference?: string | null;
  counterparty?: string | null;
  bookingDate?: string;
  treatment?: string;
  effect?: { description: string } | null;
};
const profileLabels: Record<string, string> = {
  'vat.status': 'Regim TVA',
  'vat.period': 'Perioadă fiscală TVA',
  'vat.cash': 'TVA la încasare',
  income_tax: 'Impozit',
  employer: 'Angajator',
  'books.assurance': 'Regim de lucru',
};

export function useSubjectName(subject: { kind: string; id: string }) {
  const { company, evidence, can } = useWorkspace();
  let operation = '';
  let input: Record<string, unknown> = {};
  let paged = false;
  switch (subject.kind) {
    case 'party':
      operation = 'parties.get';
      input = { partyId: subject.id };
      break;
    case 'document':
      operation = 'documents.get';
      input = { id: subject.id };
      break;
    case 'proposal':
      operation = 'proposals.get';
      input = { id: subject.id };
      break;
    case 'movement':
      operation = 'bank.movements';
      paged = true;
      break;
    case 'asset':
      operation = 'assets.list';
      paged = true;
      break;
    case 'employee':
      operation = 'payroll.employees.list';
      paged = true;
      break;
    case 'deferral':
      operation = 'deferrals.list';
      paged = true;
      break;
    case 'workOrder':
      operation = 'production.orders.list';
      paged = true;
      break;
    case 'item':
      operation = 'stock.items.list';
      paged = true;
      break;
  }
  const read = useAccountingData<NamedRecord | NamedRecord[]>(
    operation,
    input,
    !!operation && can(operation),
    paged,
  );
  const record = Array.isArray(read.data)
    ? read.data.find((row) => row.id === subject.id)
    : read.data;
  let name = record?.name ?? record?.description ?? record?.effect?.description;
  if (!name && record?.treatment) name = treatmentLabels[record.treatment];
  if (!name && record?.number) name = `${record.number}${record.date ? ` · ${record.date}` : ''}`;
  if (!name && record?.date) name = `Document din ${record.date}`;
  if (!name && record?.bookingDate)
    name = [record.counterparty, record.reference, record.bookingDate].filter(Boolean).join(' · ');
  if (subject.kind === 'company') name = company.name;
  if (subject.kind === 'evidence') name = evidence.find((file) => file.id === subject.id)?.filename;
  if (subject.kind === 'profile')
    name = `${company.name} · ${profileLabels[subject.id] ?? 'Situație fiscală'}`;
  if (subject.kind === 'vehicle') name = `Vehicul ${subject.id}`;
  if (subject.kind === 'account') name = `Cont ${subject.id}`;
  if (subject.kind === 'year') name = `An ${subject.id}`;
  if (subject.kind === 'vatPeriod') name = `Perioada TVA ${subject.id}`;
  if (subject.kind === 'annual') name = 'Situații financiare anuale';
  if (subject.kind === 'obligation') name = `Declarația ${subject.id.replace(/[|/]/g, ' · ')}`;
  if (subject.kind === 'supplierItem') name = `Produsul furnizorului: ${subject.id}`;
  return {
    name: withoutIds(
      name ?? (read.loading ? 'Se încarcă obiectul…' : 'Obiect cu nume indisponibil'),
    ),
    error: read.error,
  };
}

export function StockItemName({ id }: { id: string }) {
  const item = useSubjectName({ kind: 'item', id });
  return <span>{item.error || item.name}</span>;
}
