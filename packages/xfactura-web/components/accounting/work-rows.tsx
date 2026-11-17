'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatDate, formatPeriod, formatPeriods } from './format';
import { yearForReturn, useAccountingNavigation } from './navigation';
import { focusFact } from './profile-card';
import { Button, Chip, LinkButton, icons } from './ui';
import { WorkItemDetail } from './work-item-detail';
import {
  affectedReturns,
  firstDue,
  itemTitle,
  periodCount,
  refusal,
  returnChips,
  returnStatuses,
  returnTones,
  rowAction,
  whoActs,
  type WorkItem,
  type WorkRowModel,
} from './work-model';
import { useLoad, useWorkspace } from './workspace';

type ItemRead = {
  state: 'open' | 'disposed' | 'resolved';
  item: WorkItem | null;
  disposition: { reason: string } | null;
};

/** Which rows are open, kept above the rows so a row moving to another group stays open. */
export type Expanded = { has: (key: string) => boolean; set: (key: string, open: boolean) => void };
export function useExpanded(): Expanded {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  return {
    has: (key) => opened.has(key),
    set: (key, open) =>
      setOpened((current) => {
        const next = new Set(current);
        if (open) next.add(key);
        else next.delete(key);
        return next;
      }),
  };
}

/** A proposal keeps its row while its kind changes (awaiting approval, approved). */
export const rowKey = (item: WorkItem) =>
  item.subject.kind === 'proposal' ? `proposal:${item.subject.id}` : item.id;

/** The groups of the worklist, each a heading and its rows. */
export function WorkGroups({
  groups,
  expanded,
}: {
  groups: { who: string; heading: string; rows: WorkRowModel[] }[];
  expanded: Expanded;
}) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.who} className="acc-work-group" aria-label={group.heading}>
          <h2>{group.heading}</h2>
          <ul className="acc-work-list">
            {group.rows.map((row) => (
              <WorkRow key={workRowKey(row)} row={row} expanded={expanded} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** A row's React key: an item keeps its own (`rowKey`), a group its key. */
export const workRowKey = (row: WorkRowModel) => (row.kind === 'item' ? rowKey(row.item) : row.key);

/** Any row of the worklist: an item, a cause its items share, or one return's periods. */
export function WorkRow({ row, expanded }: { row: WorkRowModel; expanded: Expanded }) {
  if (row.kind === 'cause') return <CauseRow row={row} expanded={expanded} />;
  if (row.kind === 'return') return <ReturnRow row={row} expanded={expanded} />;
  return <ItemRow row={row} expanded={expanded} />;
}

/** A row's line: its title as the button that opens it, what it affects, its meta, its action. */
function RowLine({
  id,
  title,
  open,
  onToggle,
  chips,
  meta,
  action,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  chips: ReactNode;
  meta: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="acc-work-line">
      <h3 className="acc-work-heading">
        <button
          type="button"
          className="acc-work-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          {icons.chevronRight}
          <span className="acc-work-title">{title}</span>
        </button>
      </h3>
      {chips || meta ? (
        <div className="acc-work-facts">
          {chips}
          {meta}
        </div>
      ) : null}
      {action ? <div className="acc-work-action">{action}</div> : null}
    </div>
  );
}

/** The button or link at the right of a closed row. */
function ActionControl({ row, open }: { row: WorkRowModel; open: () => void }) {
  const { href } = useAccountingNavigation();
  const { years } = useWorkspace();
  const action = rowAction(row);
  if (action.kind === 'link') {
    const filters =
      action.section === 'deadlines' && action.filters.return
        ? { ...action.filters, year: yearForReturn(years, action.filters.return)?.id ?? null }
        : action.filters;
    return (
      <LinkButton href={href(action.section, filters)} size="small">
        {action.label}
      </LinkButton>
    );
  }
  return (
    <Button size="small" onPress={() => (action.kind === 'fact' ? focusFact(action.fact) : open())}>
      {action.label}
    </Button>
  );
}

/** Its due date, its period by name and, when it blocks, a badge; nothing that has no value. An
 * item nobody here may move on says why, in one line. */
function ItemMeta({ item, period = true }: { item: WorkItem; period?: boolean }) {
  const status = item.kind === 'obligation.due' ? String(item.details?.status ?? '') : '';
  const refused = whoActs(item) === 'access' ? item.next.find((step) => !step.allowed) : undefined;
  const parts = [
    status && returnStatuses[status] ? (
      <Chip key="status" tone={returnTones[status] ?? 'neutral'}>
        {returnStatuses[status]}
      </Chip>
    ) : item.severity === 'block' ? (
      <Chip key="severity" tone="danger">
        Blocant
      </Chip>
    ) : null,
    item.due ? (
      <span key="due" className="acc-work-meta-text">
        Termen <time dateTime={item.due}>{formatDate(item.due)}</time>
      </span>
    ) : null,
    period && item.period && item.kind !== 'obligation.due' ? (
      <span key="period" className="acc-work-meta-text">
        {formatPeriod(item.period)}
      </span>
    ) : null,
    refused ? (
      <span key="refused" className="acc-work-refusal">
        {refusal(refused)}
      </span>
    ) : null,
  ].filter(Boolean);
  return parts.length ? <>{parts}</> : null;
}

const chipsOf = (keys: string[]) => {
  const chips = returnChips(keys);
  return chips.length ? (
    <>
      {chips.map((chip) => (
        <Chip key={chip}>{chip}</Chip>
      ))}
    </>
  ) : null;
};

/** An item: opened, it is read again (`work.get`) and shows its details and steps. */
export function ItemRow({
  row,
  expanded,
}: {
  row: Extract<WorkRowModel, { kind: 'item' }>;
  expanded: Expanded;
}) {
  const item = row.item;
  const key = rowKey(item);
  const open = expanded.has(key);
  const panel = useId();
  const body = useRef<HTMLDivElement>(null);
  const focusBody = useRef(false);
  const { data, error } = useLoad<ItemRead>('work.get', { id: item.id }, open);
  const shown = data?.item ?? item;
  useEffect(() => {
    if (open && focusBody.current && body.current) {
      focusBody.current = false;
      body.current.focus();
    }
  });
  return (
    <li
      className="acc-work-row"
      data-work-kind={item.kind}
      data-work-id={item.id}
      data-open={open || undefined}
    >
      <RowLine
        id={panel}
        title={itemTitle(shown)}
        open={open}
        onToggle={() => expanded.set(key, !open)}
        chips={chipsOf(affectedReturns(shown))}
        meta={<ItemMeta item={shown} />}
        action={
          open ? null : (
            <ActionControl
              row={row}
              open={() => {
                focusBody.current = true;
                expanded.set(key, true);
              }}
            />
          )
        }
      />
      {open ? (
        <div
          id={panel}
          ref={body}
          tabIndex={-1}
          className="acc-work-body"
          role="region"
          aria-label={itemTitle(shown)}
        >
          {error ? (
            <p role="alert" className="acc-error">
              {error}
            </p>
          ) : !data ? (
            <p className="acc-hint">Se încarcă elementul…</p>
          ) : data.state !== 'open' ? (
            <p>
              {data.state === 'disposed'
                ? `Elementul a fost închis. ${data.disposition?.reason ?? ''}`
                : 'Elementul nu mai așteaptă verificare.'}
            </p>
          ) : data.item ? (
            <WorkItemDetail item={data.item} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Items blocked by the same cause, as one row: the cause, the returns it blocks as chips, and
 * the items themselves once opened. */
function CauseRow({
  row,
  expanded,
}: {
  row: Extract<WorkRowModel, { kind: 'cause' }>;
  expanded: Expanded;
}) {
  const open = expanded.has(row.key);
  const panel = useId();
  const returns = row.items.flatMap((item) =>
    item.kind === 'obligation.due' ? [item.subject.id] : affectedReturns(item),
  );
  const blocking = row.items.some((item) => item.severity === 'block');
  return (
    <li
      className="acc-work-row acc-work-cause"
      data-cause={row.cause.id}
      data-open={open || undefined}
    >
      <RowLine
        id={panel}
        title={row.cause.message}
        open={open}
        onToggle={() => expanded.set(row.key, !open)}
        chips={chipsOf(returns)}
        meta={blocking ? <Chip tone="danger">Blocant</Chip> : null}
        action={open ? null : <ActionControl row={row} open={() => expanded.set(row.key, true)} />}
      />
      {open ? (
        <ul id={panel} className="acc-work-list acc-work-members">
          {row.items.map((item) => (
            <ItemRow
              key={rowKey(item)}
              row={{ kind: 'item', key: item.id, who: row.who, item, fact: null }}
              expanded={expanded}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The periods of one return in one state, as one row: the return, its periods as one chip, how
 * many, the state, the earliest deadline; opened, each period with its own deadline and action. */
function ReturnRow({
  row,
  expanded,
}: {
  row: Extract<WorkRowModel, { kind: 'return' }>;
  expanded: Expanded;
}) {
  const open = expanded.has(row.key);
  const panel = useId();
  const periods = row.items.map((item) => item.subject.id.split('|')[1] ?? item.period ?? '');
  const first = firstDue(row.items);
  return (
    <li
      className="acc-work-row acc-work-return"
      data-return-group={`${row.form}|${row.status}`}
      data-open={open || undefined}
    >
      <RowLine
        id={panel}
        title={row.form}
        open={open}
        onToggle={() => expanded.set(row.key, !open)}
        chips={<Chip>{formatPeriods(periods)}</Chip>}
        meta={
          <>
            <span className="acc-work-meta-text">{periodCount(periods)}</span>
            {returnStatuses[row.status] ? (
              <Chip tone={returnTones[row.status] ?? 'neutral'}>{returnStatuses[row.status]}</Chip>
            ) : null}
            {first.due ? (
              <span className="acc-work-meta-text">
                Termen <time dateTime={first.due}>{formatDate(first.due)}</time>
              </span>
            ) : null}
          </>
        }
        action={open ? null : <ActionControl row={row} open={() => expanded.set(row.key, true)} />}
      />
      {open ? (
        <ul id={panel} className="acc-work-list acc-work-members">
          {row.items.map((item) => (
            <ItemRow
              key={rowKey(item)}
              row={{ kind: 'item', key: item.id, who: row.who, item, fact: null }}
              expanded={expanded}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
