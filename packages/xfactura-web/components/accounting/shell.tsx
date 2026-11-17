'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { accountingViews, followLink, sectionUrl, type ViewId } from './navigation';
import {
  Drawer,
  IconButton,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  icons,
  themeLabels,
  useTheme,
  type Theme,
} from './ui';

export type Person = { id: string; name: string; email: string };
export type Company = { id: string; name: string; cui: string };

/** The address of the page that creates a company. */
export const newCompanyUrl = '/contabilitate?company=new';
export const companyUrl = (id: string) => `/contabilitate?company=${encodeURIComponent(id)}`;

const sectionIcons: Record<ViewId, ReactNode> = {
  home: icons.home,
  review: icons.review,
  questions: icons.questions,
  documents: icons.documents,
  bank: icons.bank,
  registers: icons.registers,
  deadlines: icons.deadlines,
  settings: icons.settings,
};

/** Two letters that stand for a name in the switcher and the account button. */
function initials(name: string) {
  const words = name
    .replace(/\b(S\.?R\.?L\.?|S\.?A\.?|P\.?F\.?A\.?|I\.?I\.?)\b/gi, '')
    .split(/\s+/)
    .filter((word) => /\p{L}|\d/u.test(word));
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? name).slice(0, 2);
  return letters.toLocaleUpperCase('ro-RO');
}

export type ShellProps = {
  person: Person;
  companies: Company[];
  /** The company whose sections the sidebar opens; none before the first company exists. */
  company: Company | undefined;
  /** The view shown, when it belongs to the company; none on the new company page. */
  current: ViewId | null;
  /** The address the sidebar's section links are built from. */
  search: string;
  onSignOut: () => void;
  children: ReactNode;
};

/**
 * The frame of every signed-in screen: a fixed sidebar with the company switcher, the sections
 * and the account menu. Below 900px the sidebar is a drawer behind a top bar.
 */
export function Shell({
  person,
  companies,
  company,
  current,
  search,
  onSignOut,
  children,
}: ShellProps) {
  // Following any link in the drawer, a section, a company or „Companie nouă”, closes it.
  const address = useSearchParams()?.toString() ?? '';
  const [drawer, setDrawer] = useState(false);
  const [shownAt, setShownAt] = useState(address);
  if (shownAt !== address) {
    setShownAt(address);
    setDrawer(false);
  }
  // The drawer belongs to narrow screens; widening the window closes it.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 900px)');
    const close = () => wide.matches && setDrawer(false);
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  }, []);
  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      person={person}
      companies={companies}
      company={company}
      current={current}
      search={search}
      onSignOut={onSignOut}
      onNavigate={inDrawer ? () => setDrawer(false) : undefined}
    />
  );
  return (
    <div className="accounting acc-app" lang="ro">
      <div className="acc-sidebar">{sidebar(false)}</div>
      <header className="acc-topbar">
        <IconButton label="Meniu" icon={icons.menu} onPress={() => setDrawer(true)} />
        <span className="acc-topbar-company acc-company-current">
          {company?.name ?? 'Companie nouă'}
        </span>
      </header>
      <Drawer label="Meniu" isOpen={drawer} onOpenChange={(open) => !open && setDrawer(false)}>
        {sidebar(true)}
      </Drawer>
      <main className="acc-main">{children}</main>
    </div>
  );
}

function Sidebar({
  person,
  companies,
  company,
  current,
  search,
  onSignOut,
  onNavigate,
}: Omit<ShellProps, 'children'> & { onNavigate?: () => void }) {
  const link = (view: (typeof accountingViews)[number]) => {
    const href = sectionUrl(view.sections[0].id, {}, search);
    return (
      <li key={view.id}>
        <a
          className="acc-nav-link"
          href={href}
          aria-current={current === view.id ? 'page' : undefined}
          onClick={(event) => {
            followLink(event);
            onNavigate?.();
          }}
        >
          {sectionIcons[view.id]}
          <span>{view.label}</span>
        </a>
      </li>
    );
  };
  return (
    <div className="acc-sidebar-body">
      <CompanySwitcher companies={companies} company={company} />
      {company ? (
        <nav className="acc-nav" aria-label="Secțiuni">
          <ul className="acc-nav-list">
            {accountingViews.filter((view) => view.id !== 'settings').map(link)}
          </ul>
          <ul className="acc-nav-list acc-nav-foot">
            {accountingViews.filter((view) => view.id === 'settings').map(link)}
          </ul>
        </nav>
      ) : (
        <div className="acc-nav" />
      )}
      <AccountMenu person={person} onSignOut={onSignOut} />
    </div>
  );
}

function CompanySwitcher({
  companies,
  company,
}: {
  companies: Company[];
  company: Company | undefined;
}) {
  const name = company?.name ?? 'Companie nouă';
  return (
    <MenuTrigger>
      <AriaButton className="acc-switcher" aria-label={name}>
        <span className="acc-monogram" aria-hidden="true">
          {company ? initials(company.name) : '+'}
        </span>
        <span className="acc-switcher-text">
          <span className="acc-switcher-name acc-company-current">{name}</span>
          {company ? <span className="acc-switcher-meta">CUI {company.cui}</span> : null}
        </span>
        {icons.chevronUpDown}
      </AriaButton>
      <Menu placement="bottom start">
        <MenuSection title="Companii">
          {companies.map((choice) => (
            <MenuItem
              key={choice.id}
              id={choice.id}
              href={companyUrl(choice.id)}
              textValue={choice.name}
              isCurrent={choice.id === company?.id}
              icon={<span className="acc-icon" />}
            >
              {choice.name}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSection>
          <MenuItem id="new" href={newCompanyUrl} icon={icons.plus} isCurrent={!company}>
            Companie nouă
          </MenuItem>
        </MenuSection>
      </Menu>
    </MenuTrigger>
  );
}

function AccountMenu({ person, onSignOut }: { person: Person; onSignOut: () => void }) {
  const { theme, setTheme } = useTheme();
  return (
    <MenuTrigger>
      <AriaButton className="acc-account">
        <span className="acc-avatar" aria-hidden="true">
          {initials(person.name)}
        </span>
        <span className="acc-account-name">{person.name}</span>
        {icons.chevronUpDown}
      </AriaButton>
      <Menu
        placement="top start"
        onAction={(key) => {
          if (key === 'signOut') onSignOut();
        }}
      >
        <MenuSection
          title="Temă"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[theme]}
          onSelectionChange={(keys) => {
            const [chosen] = keys === 'all' ? [] : [...keys];
            if (chosen) setTheme(String(chosen) as Theme);
          }}
        >
          {(Object.keys(themeLabels) as Theme[]).map((choice) => (
            <MenuItem key={choice} id={choice}>
              {themeLabels[choice]}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSection>
          <MenuItem id="signOut" icon={icons.signOut}>
            Deconectare
          </MenuItem>
        </MenuSection>
      </Menu>
    </MenuTrigger>
  );
}
