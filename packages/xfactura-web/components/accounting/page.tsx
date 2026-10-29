'use client';

import { useEffect, useState } from 'react';
import { ApiError, command, field, get, signIn, signOut } from './api';
import Workspace from './workspace';

type Person = { id: string; name: string; email: string };
type Company = { id: string; name: string; cui: string };

export default function AccountingPage() {
  const [person, setPerson] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function createCompany(body: { name: string; cui: string; year: number }) {
    setBusy(true);
    setError('');
    try {
      const company = await command<Company>('/api/accounting/v1/companies', body);
      history.replaceState(null, '', `/contabilitate?company=${company.id}`);
      await load();
      setSelected(company.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Compania nu a putut fi creată.');
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const user = await get<Person>('/api/accounting/v1/session');
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (invite) {
      const company = await command<{ id: string }>('/api/accounting/v1/invitations/accept', {
        token: invite,
      });
      setSelected(company.id);
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
      .catch((error) => {
        if (active && !(error instanceof ApiError && error.status === 401))
          setError(error instanceof Error ? error.message : 'Conexiunea nu este disponibilă.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="accounting">
      <header className="acc-header">
        <a href="/" className="acc-brand">
          xfactura.ro
        </a>
        <span className="acc-header-section">Contabilitate</span>
        {person ? (
          <div className="acc-account">
            <span>{person.name}</span>
            <button
              className="acc-header-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await signOut();
                  setPerson(null);
                  setCompanies([]);
                  setSelected('');
                } catch (error) {
                  setError(error instanceof Error ? error.message : 'Deconectarea nu a reușit.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Deconectare
            </button>
          </div>
        ) : (
          <a href="/">Facturare</a>
        )}
      </header>
      <main className="acc-main">
        {loading ? (
          <div className="acc-loading" aria-busy="true">
            <div className="acc-skeleton" />
            <p>Se verifică sesiunea…</p>
          </div>
        ) : !person ? (
          <section className="acc-login">
            <h1>Autentificare</h1>

            <form
              className="acc-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                setBusy(true);
                setError('');
                try {
                  await signIn(field(data, 'email'), field(data, 'password'));
                  await load();
                } catch (error) {
                  setError(error instanceof Error ? error.message : 'Autentificarea nu a reușit.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Email
                <input name="email" type="email" autoComplete="username" required />
              </label>
              <label>
                Parolă
                <input name="password" type="password" autoComplete="current-password" required />
              </label>
              {error ? (
                <p role="alert" className="acc-error">
                  {error}
                </p>
              ) : null}
              <button disabled={busy} type="submit">
                {busy ? 'Se verifică…' : 'Intră în cont'}
              </button>
            </form>
          </section>
        ) : (
          <>
            {error ? (
              <p role="alert" className="acc-error">
                {error}
              </p>
            ) : null}
            {companies.length > 0 ? (
              <div className="acc-company-toolbar">
                <label>
                  Companie
                  <select
                    value={selected}
                    onChange={(event) => {
                      setSelected(event.target.value);
                      history.replaceState(
                        null,
                        '',
                        `/contabilitate?company=${event.target.value}`,
                      );
                    }}
                  >
                    <option value="" disabled>
                      Alege compania
                    </option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                </label>
                <details>
                  <summary>Adaugă o companie</summary>
                  <CompanyForm busy={busy} create={createCompany} />
                </details>
              </div>
            ) : null}
            {companies.some((company) => company.id === selected) ? (
              <Workspace
                key={selected}
                company={companies.find((company) => company.id === selected)!}
              />
            ) : (
              <section className="acc-onboarding">
                <h1>Companie nouă</h1>

                <CompanyForm busy={busy} create={createCompany} />
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
function CompanyForm({
  busy,
  create,
}: {
  busy: boolean;
  create: (body: { name: string; cui: string; year: number }) => Promise<void>;
}) {
  return (
    <form
      className="acc-form"
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
      <label>
        Denumire companie
        <input name="name" required minLength={2} />
      </label>
      <div className="acc-form-grid">
        <label>
          CUI
          <input name="cui" inputMode="numeric" pattern="[0-9]{2,10}" required />
        </label>
        <label>
          An contabil
          <input
            name="year"
            type="number"
            min="2020"
            max="2100"
            defaultValue={new Date().getFullYear()}
            required
          />
        </label>
      </div>
      <button disabled={busy}>Adaugă compania</button>
    </form>
  );
}
