'use client';

import { useState } from 'react';
import type { JobView } from 'xfactura-api/contracts';
import { companyPath, field } from './api';
import { useList, useWorkspace } from './workspace';

type Fact = { id: string; axis: string; value: string; effectiveFrom: string };
const axes: Record<string, { label: string; values: Record<string, string> }> = {
  'vat.status': {
    label: 'Regim TVA',
    values: { normal_vat: 'Plătitor de TVA', non_vat: 'Neplătitor de TVA' },
  },
  'vat.period': {
    label: 'Perioadă fiscală TVA',
    values: { monthly: 'Lunară', quarterly: 'Trimestrială' },
  },
  'vat.cash': { label: 'TVA la încasare', values: { no: 'Nu', yes: 'Da' } },
  income_tax: {
    label: 'Impozit',
    values: { micro: 'Microîntreprindere', profit: 'Impozit pe profit' },
  },
  employer: { label: 'Angajator', values: { no: 'Nu', yes: 'Da' } },
  'books.assurance': {
    label: 'Regim de lucru',
    values: {
      preview: 'Previzualizare (parametri neverificați)',
      shadow: 'În paralel',
      live: 'Registre oficiale',
    },
  },
};

export default function Settings() {
  const { company, can, evidence, invoke, act } = useWorkspace();
  const { data: facts } = useList<Fact>('profile.read', {});
  const [axis, setAxis] = useState('vat.status');
  const [exportJob, setExportJob] = useState<JobView | null>(null);
  const [invitation, setInvitation] = useState('');
  return (
    <>
      <div className="acc-section-heading">
        <h2>Profilul companiei</h2>
        <p>Fapte datate, fiecare cu documentul care le dovedește.</p>
      </div>
      <div className="acc-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Axă</th>
              <th scope="col">Valoare</th>
              <th scope="col">De la</th>
            </tr>
          </thead>
          <tbody>
            {(facts ?? []).map((fact) => (
              <tr key={fact.id}>
                <td>{axes[fact.axis]?.label ?? fact.axis}</td>
                <td>{axes[fact.axis]?.values[fact.value] ?? fact.value}</td>
                <td>{fact.effectiveFrom}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can('profile.record') ? (
        <form
          className="acc-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void act(
              () =>
                invoke('profile.record', {
                  axis,
                  value: field(data, 'value'),
                  effectiveFrom: field(data, 'effectiveFrom'),
                  evidenceId: field(data, 'evidenceId'),
                }),
              'Faptul a fost înregistrat.',
            );
          }}
        >
          <div className="acc-form-grid">
            <label>
              Axă
              <select value={axis} onChange={(event) => setAxis(event.target.value)}>
                {Object.entries(axes).map(([id, definition]) => (
                  <option key={id} value={id}>
                    {definition.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Valoare
              <select name="value">
                {Object.entries(axes[axis]!.values).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              De la
              <input name="effectiveFrom" type="date" required />
            </label>
            <label>
              Document justificativ
              <select name="evidenceId" required>
                {evidence.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.filename}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button>Înregistrează faptul</button>
        </form>
      ) : null}
      {can('company.invite') ? (
        <>
          <h2>Membri</h2>
          <form
            className="acc-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void act(async () => {
                const result = await invoke<{ token: string }>('company.invite', {
                  email: field(data, 'email'),
                  role: field(data, 'role'),
                });
                setInvitation(`${location.origin}/contabilitate#invite=${result.token}`);
              }, 'Invitația a fost creată.');
            }}
          >
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Rol
              <select name="role">
                <option value="reviewer">Revizor</option>
                <option value="viewer">Vizitator</option>
              </select>
            </label>
            <button>Invită</button>
          </form>
          {invitation ? (
            <p className="acc-hint">
              Trimiteți acest link persoanei invitate (valabil 48 de ore): <code>{invitation}</code>
            </p>
          ) : null}
        </>
      ) : null}
      {can('exports.request') ? (
        <>
          <h2>Export complet</h2>
          <div className="acc-actions">
            <button
              className="acc-secondary"
              onClick={() =>
                act(
                  async () => setExportJob(await invoke<JobView>('exports.request')),
                  'Exportul a fost cerut.',
                )
              }
            >
              Cere exportul
            </button>
            {exportJob ? (
              <button
                className="acc-secondary"
                onClick={() =>
                  act(
                    async () =>
                      setExportJob(await invoke<JobView>('exports.get', { id: exportJob.id })),
                    'Starea exportului a fost actualizată.',
                  )
                }
              >
                Verifică starea
              </button>
            ) : null}
            {exportJob?.status === 'done' ? (
              <a href={`${companyPath(company.id)}/exports/${exportJob.id}`}>Descarcă exportul</a>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
