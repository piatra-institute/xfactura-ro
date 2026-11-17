'use client';

import type { ReactNode } from 'react';
import {
  Cell as AriaCell,
  Column as AriaColumn,
  Row as AriaRow,
  Table as AriaTable,
  TableBody as AriaTableBody,
  TableHeader as AriaTableHeader,
  type CellProps as AriaCellProps,
  type ColumnProps as AriaColumnProps,
  type RowProps as AriaRowProps,
  type TableBodyProps as AriaTableBodyProps,
  type TableHeaderProps as AriaTableHeaderProps,
  type TableProps as AriaTableProps,
} from 'react-aria-components';

/**
 * A dense table: the header stays in view while the rows scroll, numeric columns align right with
 * tabular figures, and arrow keys move between cells. Amounts arrive formatted from the engine's
 * values; the table never totals them.
 */
export function Table({
  maxHeight,
  className,
  ...props
}: Omit<AriaTableProps, 'className'> & { maxHeight?: string; className?: string }) {
  return (
    <div className="acc-table-frame" style={maxHeight ? { maxHeight } : undefined}>
      <AriaTable {...props} className={['acc-table', className].filter(Boolean).join(' ')} />
    </div>
  );
}

export function TableHeader<T extends object>(props: Omit<AriaTableHeaderProps<T>, 'className'>) {
  return <AriaTableHeader {...props} className="acc-table-header" />;
}

export function Column({
  numeric,
  children,
  ...props
}: Omit<AriaColumnProps, 'className' | 'children'> & { numeric?: boolean; children: ReactNode }) {
  return (
    <AriaColumn
      {...props}
      className={numeric ? 'acc-table-column acc-numeric' : 'acc-table-column'}
    >
      {children}
    </AriaColumn>
  );
}

export function TableBody<T extends object>(props: Omit<AriaTableBodyProps<T>, 'className'>) {
  return <AriaTableBody {...props} className="acc-table-body" />;
}

export function Row<T extends object>(props: Omit<AriaRowProps<T>, 'className'>) {
  return <AriaRow {...props} className="acc-table-row" />;
}

export function Cell({
  numeric,
  ...props
}: Omit<AriaCellProps, 'className'> & { numeric?: boolean }) {
  return (
    <AriaCell {...props} className={numeric ? 'acc-table-cell acc-numeric' : 'acc-table-cell'} />
  );
}
