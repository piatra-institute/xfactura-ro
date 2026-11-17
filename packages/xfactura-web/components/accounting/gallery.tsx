'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';
import {
  Badge,
  Button,
  Chip,
  ComboBox,
  DateField,
  EmptyState,
  MoneyField,
  MonthField,
  Select,
} from './ui';

/**
 * The shared widgets in forms that show what they submit, for development and the browser suite.
 * Each form is labelled, so a test reaches its fields and its submitted values by name.
 */
export default function Gallery() {
  const [limit, setLimit] = useState('2026-01');
  return (
    <I18nProvider locale="ro-RO">
      <div className="accounting acc-gallery" lang="ro">
        <main className="acc-body">
          <h1>Componente</h1>
          <Sample title="Date">
            <DateField label="Data obligatorie" name="required" isRequired />
            <DateField label="Data opțională" name="optional" defaultValue="2026-11-17" />
          </Sample>
          <Sample title="Luni">
            <MonthField
              label="Luna limitată"
              name="bounded"
              defaultValue="2026-11"
              minValue={limit}
              maxValue="2027-12"
            />
            <Button onPress={() => setLimit('2027-01')}>Începe limita în 2027</Button>
          </Sample>
          <Sample title="Lună în afara limitelor">
            <MonthField
              label="Luna de dinainte"
              name="early"
              defaultValue="2026-11"
              minValue="2027-01"
            />
          </Sample>
          <Sample title="Sume">
            <MoneyField label="Sumă obligatorie" name="amount" isRequired />
            <MoneyField label="Sumă în yeni" name="yen" currency="JPY" />
            <MoneyField label="Sumă blocată" name="locked" defaultValue="1234.56" isDisabled />
          </Sample>
          <Sample title="Conturi">
            <ComboBox
              label="Cont"
              name="account"
              options={[
                { id: '401', code: '401', name: 'Furnizori' },
                { id: '4111', code: '4111', name: 'Clienți' },
                { id: '5121', code: '5121', name: 'Conturi la bănci în lei' },
              ]}
            />
            <Select
              label="Tip"
              name="kind"
              defaultValue="general"
              options={[
                { id: 'general', label: 'Înregistrare generală' },
                { id: 'opening', label: 'Poziție de deschidere' },
              ]}
            />
          </Sample>
          <section className="acc-stack" aria-label="Afișare">
            <p>
              <Badge count={3} label="3 de verificat" /> <Chip>D112 · ian–dec 2026</Chip>{' '}
              <Chip tone="warning">Termen depășit</Chip>
            </p>
            <EmptyState
              message="Nu există documente."
              action={{ label: 'Adaugă documente', href: '#' }}
            />
          </section>
        </main>
      </div>
    </I18nProvider>
  );
}

function Sample({ title, children }: { title: string; children: ReactNode }) {
  const [sent, setSent] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(
      [...new FormData(event.currentTarget).entries()].map(([key, value]) => [key, String(value)]),
    );
    setSent(JSON.stringify(values));
  };
  return (
    <form className="acc-stack acc-company-form" aria-label={title} onSubmit={submit}>
      <h2>{title}</h2>
      {children}
      <Button type="submit" variant="primary">
        Trimite
      </Button>
      <output aria-label="Valori trimise">{sent}</output>
    </form>
  );
}
