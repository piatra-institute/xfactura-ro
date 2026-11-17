'use client';

import { parseDate, type CalendarDate } from '@internationalized/date';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Button as AriaButton,
  DateField as AriaDateField,
  DateInput,
  DateSegment,
  Dialog,
  DialogTrigger,
  FieldError,
  Label,
  Popover,
  Text,
} from 'react-aria-components';
import { formatMonth, monthName } from '../format';
import { Button, IconButton } from './button';
import { FormValue, useFocusAfterRender } from './form-value';
import { icons } from './icons';
import { dateComplete, dateProblem, dateRangeProblem, monthProblem } from './validation';

/** An ISO date as the widgets' calendar date; anything else is no date. */
function calendarDate(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  try {
    return parseDate(value);
  } catch {
    return null;
  }
}

export type DateFieldProps = {
  label: string;
  /** The form field that carries the ISO date. */
  name?: string;
  /** An ISO date, `2026-11-17`; null when empty. */
  value?: string | null;
  defaultValue?: string;
  onChange?: (value: string | null) => void;
  minValue?: string;
  maxValue?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  description?: ReactNode;
  className?: string;
};

/**
 * A day, typed and shown as 17.11.2026 under the Romanian locale; its value is the ISO date. A
 * date with some parts left empty, a day that does not exist, or a day outside the bounds is no
 * date to submit: the field refuses the form, with its reason beside it and on every part of the
 * date, until the person corrects it or clears it.
 */
export function DateField({
  label,
  name,
  value,
  defaultValue,
  onChange,
  minValue,
  maxValue,
  description,
  className,
  isRequired,
  isDisabled,
}: DateFieldProps) {
  const root = useRef<HTMLDivElement>(null);
  const [attempted, setAttempted] = useState(false);
  const [report, setReport] = useState({ problem: '', settled: false });
  // A wrong whole date is shown at once; a missing or partial one once the form is submitted.
  const shown = report.problem && (attempted || report.settled) ? report.problem : '';
  const focus = useFocusAfterRender(() => {
    const parts = [
      ...(root.current?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? []),
    ];
    return parts.find((part) => part.hasAttribute('data-placeholder')) ?? parts[0];
  });
  return (
    <AriaDateField
      ref={root}
      value={calendarDate(value)}
      defaultValue={calendarDate(defaultValue)}
      minValue={calendarDate(minValue)}
      maxValue={calendarDate(maxValue)}
      onChange={(date: CalendarDate | null) => onChange?.(date ? date.toString() : null)}
      isRequired={isRequired}
      isDisabled={isDisabled}
      // The field's own reason replaces React Aria's validation, whose messages follow the
      // browser's language rather than the interface's.
      isInvalid={!!shown}
      validationBehavior="aria"
      shouldForceLeadingZeros
      className={['acc-field', className].filter(Boolean).join(' ')}
    >
      {({ state }) => {
        const entered = state.value ? state.value.toString() : null;
        const parts = dateProblem(state.segments, isRequired, entered);
        const problem = parts || dateRangeProblem(entered, { minValue, maxValue });
        const complete = dateComplete(state.segments);
        // React Aria clamps a day that does not exist (31.02) to a real one when focus leaves the
        // field; the person's draft stays instead, refused, until they correct it.
        const confirm = state.confirmPlaceholder;
        state.confirmPlaceholder = () => {
          if (!(complete && parts)) confirm();
        };
        return (
          <>
            <Report
              problem={problem}
              settled={complete && !!problem}
              onReport={(problem, settled) => setReport({ problem, settled })}
            />
            <Label className="acc-field-label">{label}</Label>
            <DateInput className="acc-input acc-date-input">
              {(segment) => <DateSegment segment={segment} className="acc-date-segment" />}
            </DateInput>
            <FormValue
              name={name}
              value={parts ? '' : (entered ?? '')}
              problem={problem}
              isDisabled={isDisabled}
              onInvalid={(first) => {
                setAttempted(true);
                if (first) focus();
              }}
            />
            {description ? (
              <Text slot="description" className="acc-field-description">
                {description}
              </Text>
            ) : null}
            <FieldError className="acc-field-error">{shown}</FieldError>
          </>
        );
      }}
    </AriaDateField>
  );
}

/** Passes a problem found while rendering up to the field, after the render. */
function Report({
  problem,
  settled,
  onReport,
}: {
  problem: string;
  settled: boolean;
  onReport: (problem: string, settled: boolean) => void;
}) {
  useLayoutEffect(() => onReport(problem, settled), [problem, settled]);
  return null;
}

const pad = (month: number) => String(month).padStart(2, '0');

export type MonthFieldProps = {
  label: string;
  /** The form field that carries the month. */
  name?: string;
  /** A month, `2026-11`; null when none is chosen. */
  value?: string | null;
  defaultValue?: string;
  onChange?: (value: string | null) => void;
  /** The first and last months that may be chosen, `YYYY-MM`. */
  minValue?: string;
  maxValue?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  placeholder?: string;
  /** Offers to clear the choice, with this label. */
  clearLabel?: string;
  description?: ReactNode;
  className?: string;
};

/**
 * A month, shown by name („noiembrie 2026”) and chosen from a year of months. Its value is
 * `YYYY-MM`. Arrow keys move between months; Page Up and Page Down change the year. A value that
 * is not a month or lies outside the bounds, however it was set, refuses the form with its reason.
 */
export function MonthField({
  label,
  name,
  value,
  defaultValue,
  onChange,
  minValue,
  maxValue,
  isRequired,
  isDisabled,
  placeholder = 'Alege luna',
  clearLabel,
  description,
  className,
}: MonthFieldProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const controlled = value !== undefined;
  const [own, setOwn] = useState<string | null>(defaultValue ?? null);
  const current = controlled ? value : own;
  const [open, setOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const focusTrigger = useFocusAfterRender(() => trigger.current);
  const problem = monthProblem(current, { minValue, maxValue, isRequired });
  // A wrong value is shown at once; a missing required one once the form is submitted.
  const shown = problem && (attempted || !!current) ? problem : '';
  const [year, setYear] = useState(() => Number((current ?? maxValue ?? '').slice(0, 4)) || 0);
  const firstYear = minValue ? Number(minValue.slice(0, 4)) : -Infinity;
  const lastYear = maxValue ? Number(maxValue.slice(0, 4)) : Infinity;
  const outside = (month: string) =>
    (!!minValue && month < minValue) || (!!maxValue && month > maxValue);
  const choose = (month: string | null) => {
    if (!controlled) setOwn(month);
    setOpen(false);
    if (month !== current) onChange?.(month);
  };
  const show = (isOpen: boolean) => {
    if (isOpen) {
      const today = new Date().getFullYear();
      const start = Number(current?.slice(0, 4)) || today;
      setYear(Math.min(Math.max(start, firstYear), lastYear));
    }
    setOpen(isOpen);
  };
  const focusable = (month: string) => !outside(month);
  const target =
    current && current.startsWith(`${year}-`)
      ? current
      : (Array.from({ length: 12 }, (_, index) => `${year}-${pad(index + 1)}`).find(focusable) ??
        null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -3,
      ArrowDown: 3,
    };
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      const next = year + (event.key === 'PageUp' ? -1 : 1);
      if (next >= firstYear && next <= lastYear) setYear(next);
      return;
    }
    const step = steps[event.key];
    if (step === undefined || index < 0) return;
    event.preventDefault();
    buttons[Math.min(Math.max(index + step, 0), buttons.length - 1)]?.focus();
  };
  return (
    <div
      className={['acc-field', 'acc-month-field', className].filter(Boolean).join(' ')}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={
        [description ? `${id}-description` : '', shown ? `${id}-problem` : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      data-invalid={shown ? true : undefined}
    >
      <span id={`${id}-label`} className="acc-field-label">
        {label}
      </span>
      <DialogTrigger isOpen={open} onOpenChange={show}>
        <AriaButton
          ref={trigger}
          isDisabled={isDisabled}
          className="acc-input acc-month-trigger"
          aria-labelledby={`${id}-label ${id}-value`}
          aria-describedby={shown ? `${id}-problem` : undefined}
          aria-invalid={shown ? true : undefined}
          data-empty={current ? undefined : true}
        >
          <span id={`${id}-value`}>{current ? formatMonth(current) : placeholder}</span>
          {icons.calendar}
        </AriaButton>
        <Popover className="acc-layer acc-popover acc-month-popover" placement="bottom start">
          <Dialog className="acc-month-dialog" aria-labelledby={`${id}-label`}>
            <div className="acc-month-header">
              <IconButton
                label="Anul anterior"
                icon={icons.chevronLeft}
                size="small"
                isDisabled={year <= firstYear}
                onPress={() => setYear((shown) => shown - 1)}
              />
              <span className="acc-month-year" aria-live="polite">
                {year}
              </span>
              <IconButton
                label="Anul următor"
                icon={icons.chevronRight}
                size="small"
                isDisabled={year >= lastYear}
                onPress={() => setYear((shown) => shown + 1)}
              />
            </div>
            <div className="acc-month-grid" onKeyDown={move}>
              {Array.from({ length: 12 }, (_, index) => {
                const month = `${year}-${pad(index + 1)}`;
                return (
                  <AriaButton
                    key={month}
                    className="acc-month-option"
                    aria-label={formatMonth(month)}
                    aria-pressed={month === current}
                    isDisabled={outside(month)}
                    autoFocus={month === target}
                    onPress={() => choose(month)}
                  >
                    {monthName(index + 1, true)}
                  </AriaButton>
                );
              })}
            </div>
            {clearLabel && current ? (
              <div className="acc-month-foot">
                <Button variant="quiet" size="small" onPress={() => choose(null)}>
                  {clearLabel}
                </Button>
              </div>
            ) : null}
          </Dialog>
        </Popover>
      </DialogTrigger>
      <FormValue
        name={name}
        value={current ?? ''}
        problem={problem}
        isDisabled={isDisabled}
        onInvalid={(first) => {
          setAttempted(true);
          if (first) focusTrigger();
        }}
      />
      {description ? (
        <p id={`${id}-description`} className="acc-field-description">
          {description}
        </p>
      ) : null}
      {shown ? (
        <p id={`${id}-problem`} className="acc-field-error">
          {shown}
        </p>
      ) : null}
    </div>
  );
}
