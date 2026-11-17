'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { I18nProvider, RouterProvider } from 'react-aria-components';
import { ApiError, command, field, get, signIn, signOut } from './api';
import { sectionUrl, useAccountingNavigation, useMovedSections } from './navigation';
import { Shell, companyUrl, type Company, type Person } from './shell';
import { Button, Feedback, LinkButton, NumberField, TextField } from './ui';
import Workspace from './workspace';

/** Every widget reads the Romanian locale; links inside widgets move through the history. */
export default function AccountingPage() {
  return (
    <I18nProvider locale="ro-RO">
      <RouterProvider navigate={(href) => window.history.pushState(null, '', href)}>
        <Accounting />
      </RouterProvider>
    </I18nProvider>
  );
}

function Accounting() {
  const [person, setPerson] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const params = useSearchParams();
  const { view } = useAccountingNavigation();
  useMovedSections();
  const requestedCompany = params?.get('company');
  const companyId = companies.some((company) => company.id === requestedCompany)
    ? requestedCompany!
    : selected;
  const company = companies.find((choice) => choice.id === companyId);
  const creating = requestedCompany === 'new' || !company;
  // The company last opened, by the switcher or by an address: the new company page returns to it.
  if (company && !creating && company.id !== selected) setSelected(company.id);

  async function createCompany(body: { name: string; cui: string; year: number }) {
    setBusy(true);
    setError('');
    try {
      const created = await command<Company>('/api/accounting/v1/companies', body);
      // A new company opens on its settings, where its setup begins.
      window.history.pushState(null, '', sectionUrl('settings', {}, `company=${created.id}`));
      await load();
      setSelected(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Compania nu a putut fi creată.');
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const user = await get<Person>('/api/accounting/v1/session');
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (invite) {
      const joined = await command<{ id: string }>('/api/accounting/v1/invitations/accept', {
        token: invite,
      });
      setSelected(joined.id);
      history.replaceState(null, '', '/contabilitate');
    }
    const choices = await get<Company[]>('/api/accounting/v1/companies');
    setPerson(user);
    setCompanies(choices);
    const requested = new URLSearchParams(location.search).get('company');
    setSelected(
      (current) =>
        (choices.some((choice) => choice.id === current) ? current : '') ||
        (choices.some((choice) => choice.id === requested) ? requested! : (choices[0]?.id ?? '')),
    );
  }
  useEffect(() => {
    let active = true;
    load()
      .catch((reason) => {
        if (active && !(reason instanceof ApiError && reason.status === 401))
          setError(reason instanceof Error ? reason.message : 'Conexiunea nu este disponibilă.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading)
    return (
      <div className="accounting acc-boot" lang="ro" aria-busy="true">
        <div className="acc-skeleton" />
        <div className="acc-skeleton" />
        <p className="acc-hint">Se verifică sesiunea…</p>
      </div>
    );

  if (!person)
    return (
      <div className="accounting acc-center" lang="ro">
        <main className="acc-card">
          <a href="/" className="acc-brand">
            xfactura.ro
          </a>
          <h1>Autentificare</h1>
          <form
            className="acc-stack"
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setBusy(true);
              setError('');
              try {
                await signIn(field(data, 'email'), field(data, 'password'));
                await load();
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Autentificarea nu a reușit.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <TextField label="Email" name="email" type="email" autoComplete="username" isRequired />
            <TextField
              label="Parolă"
              name="password"
              type="password"
              autoComplete="current-password"
              isRequired
            />
            {error ? (
              <p role="alert" className="acc-error">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" isDisabled={busy}>
              {busy ? 'Se verifică…' : 'Intră în cont'}
            </Button>
          </form>
        </main>
      </div>
    );

  // The new company page belongs to no company: the sidebar offers no company's sections there.
  const back = companies.find((choice) => choice.id === selected);
  return (
    <Shell
      person={person}
      companies={companies}
      company={creating ? undefined : company}
      current={creating ? null : view.id}
      search={params?.toString() ?? ''}
      onSignOut={async () => {
        setBusy(true);
        try {
          await signOut();
          setPerson(null);
          setCompanies([]);
          setSelected('');
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Deconectarea nu a reușit.');
        } finally {
          setBusy(false);
        }
      }}
    >
      {creating ? (
        <>
          <div className="acc-contextbar">
            <h1>Companie nouă</h1>
          </div>
          <div className="acc-body">
            <Feedback error={error} />
            <CompanyForm
              busy={busy}
              create={createCompany}
              back={back ? companyUrl(back.id) : undefined}
            />
          </div>
        </>
      ) : (
        <>
          {error ? (
            <div className="acc-body acc-shell-error">
              <Feedback error={error} />
            </div>
          ) : null}
          <Workspace key={company.id} company={company} />
        </>
      )}
    </Shell>
  );
}

function CompanyForm({
  busy,
  create,
  back,
}: {
  busy: boolean;
  create: (body: { name: string; cui: string; year: number }) => Promise<void>;
  /** The company the person came from, when there is one. */
  back?: string;
}) {
  return (
    <form
      className="acc-stack acc-company-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void create({
          name: field(data, 'name'),
          cui: field(data, 'cui'),
          year: Number(field(data, 'year')),
        });
      }}
    >
      <TextField
        label="Denumire"
        name="name"
        isRequired
        minLength={2}
        autoComplete="organization"
      />
      <div className="acc-form-row">
        <TextField label="CUI" name="cui" inputMode="numeric" pattern="[0-9]{2,10}" isRequired />
        <NumberField
          label="An contabil"
          name="year"
          defaultValue={new Date().getFullYear()}
          minValue={2020}
          maxValue={2100}
          isRequired
        />
      </div>
      <div className="acc-form-actions">
        <Button type="submit" variant="primary" isDisabled={busy}>
          Adaugă compania
        </Button>
        {back ? <LinkButton href={back}>Renunță</LinkButton> : null}
      </div>
    </form>
  );
}
