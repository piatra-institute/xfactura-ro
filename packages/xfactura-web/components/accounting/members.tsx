'use client';

import { useState, type FormEvent } from 'react';
import { Input, TextField as AriaTextField, Label } from 'react-aria-components';
import { field } from './api';
import { useAccountingData } from './use-data';
import {
  Button,
  Cell,
  Column,
  Dialog,
  Row,
  Select,
  Table,
  TableBody,
  TableHeader,
  TextField,
} from './ui';
import { useWorkspace } from './workspace';

type Member = { userId: string; name: string; email: string; role: string; active: boolean };
type Invitation = { id: string; expiresInHours: number; token: string };

const roleLabels: Record<string, string> = {
  owner: 'Proprietar',
  reviewer: 'Revizor',
  viewer: 'Vizitator',
};
/** „48 de ore”, „12 ore”: from 20 on, Romanian puts „de” before the noun, except after 1–19
 * in each hundred. */
const hours = (count: number) =>
  `${count}${count >= 20 && (count % 100 === 0 || count % 100 >= 20) ? ' de' : ''} ore`;
const invitedRoles = [
  { id: 'reviewer', label: roleLabels.reviewer! },
  { id: 'viewer', label: roleLabels.viewer! },
];

/** Membri: who has access to the company, inviting someone and revoking a member's access. */
export default function Members() {
  const { can, invoke, act } = useWorkspace();
  const { data, error, loading } = useAccountingData<Member[]>('company.members', {}, true, true);
  const [revoking, setRevoking] = useState<Member | null>(null);
  const members = (data ?? []).filter((member) => member.active);
  const mayRevoke = can('company.revoke');
  return (
    <div className="acc-members">
      {error ? (
        <p role="alert" className="acc-error">
          {error}
        </p>
      ) : null}
      {data === null && !error ? (
        <p className="acc-loading" aria-busy="true">
          Se încarcă membrii…
        </p>
      ) : (
        <div aria-busy={loading || undefined}>
          <Table aria-label="Membri">
            <TableHeader>
              <Column isRowHeader>Nume</Column>
              <Column>Email</Column>
              <Column>Rol</Column>
              <Column>
                <span className="acc-visually-hidden">Acțiuni</span>
              </Column>
            </TableHeader>
            <TableBody items={members} renderEmptyState={() => 'Niciun membru activ.'}>
              {(member) => (
                <Row id={member.userId}>
                  <Cell>{member.name}</Cell>
                  <Cell>{member.email}</Cell>
                  <Cell>{roleLabels[member.role] ?? member.role}</Cell>
                  <Cell>
                    {mayRevoke && member.role !== 'owner' ? (
                      <div className="acc-row-actions">
                        <Button size="small" variant="quiet" onPress={() => setRevoking(member)}>
                          Revocă
                        </Button>
                      </div>
                    ) : null}
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {can('company.invite') ? <Invite /> : null}
      <Dialog
        title="Revocă accesul"
        isOpen={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        footer={
          <>
            <Button variant="quiet" onPress={() => setRevoking(null)}>
              Renunță
            </Button>
            <Button
              variant="danger"
              onPress={async () => {
                if (!revoking) return;
                const member = revoking;
                if (
                  await act(
                    () => invoke('company.revoke', { userId: member.userId }),
                    `Accesul pentru ${member.name} a fost revocat.`,
                  )
                )
                  setRevoking(null);
              }}
            >
              Revocă
            </Button>
          </>
        }
      >
        {revoking ? (
          <p>
            {revoking.name} ({revoking.email}) nu va mai avea acces la companie, iar credențialele
            de agent emise de această persoană încetează.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

/** The invitation form; the link it creates is shown once, here, with a way to copy it. */
function Invite() {
  const { invoke, act } = useWorkspace();
  const [role, setRole] = useState<string | null>('reviewer');
  const [invitation, setInvitation] = useState<{ email: string; link: string; hours: number }>();
  const [copied, setCopied] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = field(new FormData(form), 'email');
    void act(async () => {
      const created = await invoke<Invitation>('company.invite', {
        email,
        role: role ?? 'reviewer',
      });
      setInvitation({
        email,
        link: `${location.origin}/contabilitate#invite=${created.token}`,
        hours: created.expiresInHours,
      });
      setCopied(false);
      form.reset();
    }, 'Invitația a fost creată.');
  };
  return (
    <section className="acc-invite" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invită un membru</h2>
      <form className="acc-invite-form" onSubmit={submit}>
        <TextField label="Email" name="email" type="email" autoComplete="off" isRequired />
        <Select label="Rol" options={invitedRoles} value={role} onChange={setRole} />
        <Button type="submit" variant="primary">
          Invită
        </Button>
      </form>
      {invitation ? (
        <div className="acc-invitation">
          <AriaTextField
            className="acc-field acc-invitation-link"
            value={invitation.link}
            isReadOnly
          >
            <Label className="acc-field-label">Link de invitație pentru {invitation.email}</Label>
            <Input className="acc-input" onFocus={(event) => event.currentTarget.select()} />
          </AriaTextField>
          <Button
            onPress={async () => {
              await navigator.clipboard.writeText(invitation.link);
              setCopied(true);
            }}
          >
            {copied ? 'Copiat' : 'Copiază linkul'}
          </Button>
          <p className="acc-hint">
            Trimite linkul persoanei invitate; expiră în {hours(invitation.hours)}.
          </p>
        </div>
      ) : null}
    </section>
  );
}
