'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  FieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  NumberField as AriaNumberField,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  TextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import { formatMoneyInput, parseMoney } from '../format';
import { FormValue, useFocusAfterRender } from './form-value';
import { icons } from './icons';
import { moneyProblem } from './validation';

/** What every field shares: a visible label, an optional hint and an error the field reports. */
type FieldBase = {
  label: string;
  description?: ReactNode;
  errorMessage?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  className?: string;
};

function FieldFoot({ description, errorMessage }: Pick<FieldBase, 'description' | 'errorMessage'>) {
  return (
    <>
      {description ? (
        <Text slot="description" className="acc-field-description">
          {description}
        </Text>
      ) : null}
      <FieldError className="acc-field-error">{errorMessage}</FieldError>
    </>
  );
}

const fieldClass = (className?: string) => ['acc-field', className].filter(Boolean).join(' ');

export type TextFieldProps = FieldBase &
  Omit<AriaTextFieldProps, 'className' | 'children' | 'isRequired' | 'isDisabled'> & {
    multiline?: boolean;
    placeholder?: string;
  };

/** Free text: a name, a reference, an explanation. */
export function TextField({
  label,
  description,
  errorMessage,
  multiline,
  placeholder,
  className,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField {...props} className={fieldClass(className)}>
      <Label className="acc-field-label">{label}</Label>
      {multiline ? (
        <TextArea className="acc-input acc-textarea" placeholder={placeholder} />
      ) : (
        <Input className="acc-input" placeholder={placeholder} />
      )}
      <FieldFoot description={description} errorMessage={errorMessage} />
    </AriaTextField>
  );
}

export type NumberFieldProps = FieldBase & {
  name?: string;
  value?: number | null;
  defaultValue?: number;
  onChange?: (value: number | null) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  /** Defaults to whole numbers without grouping, as for a year or a count of days. */
  formatOptions?: Intl.NumberFormatOptions;
};

/** A count or a year, typed and shown in the Romanian locale. Amounts use MoneyField. */
export function NumberField({
  label,
  description,
  errorMessage,
  className,
  value,
  onChange,
  formatOptions = { useGrouping: false, maximumFractionDigits: 0 },
  ...props
}: NumberFieldProps) {
  return (
    <AriaNumberField
      {...props}
      value={value === null ? NaN : value}
      onChange={(next) => onChange?.(Number.isNaN(next) ? null : next)}
      formatOptions={formatOptions}
      className={fieldClass(className)}
    >
      <Label className="acc-field-label">{label}</Label>
      <Input className="acc-input acc-number-input" />
      <FieldFoot description={description} errorMessage={errorMessage} />
    </AriaNumberField>
  );
}

export type MoneyFieldProps = FieldBase & {
  /** The form field that carries the engine's decimal string. */
  name?: string;
  /** The engine's decimal string, `1234.56`; null when empty or not an amount. */
  value?: string | null;
  defaultValue?: string;
  onChange?: (value: string | null) => void;
  currency?: string;
};

/**
 * An amount typed and shown as `1.234,56`. Its value is the decimal string the engine expects for
 * the currency (`1234.56`; `1234` for a currency without minor units), read from the text without
 * floating point. An empty required amount, or text that is not an amount, refuses the form with
 * its reason beside the field.
 */
export function MoneyField({
  label,
  description,
  errorMessage,
  className,
  name,
  value,
  defaultValue,
  onChange,
  currency = 'RON',
  isRequired,
  isDisabled,
}: MoneyFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const controlled = value !== undefined;
  const [own, setOwn] = useState<string | null>(defaultValue ?? null);
  const current = controlled ? value : own;
  const [text, setText] = useState(current ? formatMoneyInput(current, currency) : '');
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const focusInput = useFocusAfterRender(() => input.current);
  // A value set from outside replaces the text, unless the person is typing it.
  useEffect(() => {
    if (!focused && controlled) setText(value ? formatMoneyInput(value, currency) : '');
  }, [controlled, value, focused, currency]);
  const parsed = text.trim() ? parseMoney(text, currency) : null;
  const problem = moneyProblem(text, currency, isRequired);
  const shown = problem && (attempted || (touched && text.trim() !== '')) ? problem : '';
  return (
    <AriaTextField
      className={fieldClass(['acc-money-field', className].filter(Boolean).join(' '))}
      value={text}
      inputMode="decimal"
      autoComplete="off"
      isRequired={isRequired}
      isDisabled={isDisabled}
      isInvalid={!!shown}
      validationBehavior="aria"
      onFocus={() => setFocused(true)}
      onChange={(next) => {
        setText(next);
        const amount = next.trim() ? parseMoney(next, currency) : null;
        if (amount !== current) {
          if (!controlled) setOwn(amount);
          onChange?.(amount);
        }
      }}
      onBlur={() => {
        setFocused(false);
        setTouched(true);
        if (parsed !== null) setText(formatMoneyInput(parsed, currency));
      }}
    >
      <Label className="acc-field-label">{label}</Label>
      <div className="acc-input acc-money">
        <Input ref={input} className="acc-money-input" />
        <span className="acc-money-currency" aria-hidden="true">
          {currency}
        </span>
      </div>
      <FieldFoot description={description} errorMessage={errorMessage ?? shown} />
      <FormValue
        name={name}
        value={parsed ?? ''}
        problem={problem}
        isDisabled={isDisabled}
        onInvalid={(first) => {
          setAttempted(true);
          if (first) focusInput();
        }}
      />
    </AriaTextField>
  );
}

export type Option = { id: string; label: string };

export type SelectProps = FieldBase & {
  options: readonly Option[];
  name?: string;
  value?: string | null;
  defaultValue?: string;
  onChange?: (value: string | null) => void;
  placeholder?: string;
};

/** One choice from a short list, labelled in plain language. */
export function Select({
  label,
  description,
  errorMessage,
  className,
  options,
  value,
  defaultValue,
  onChange,
  placeholder = 'Alege',
  ...props
}: SelectProps) {
  return (
    <AriaSelect
      {...props}
      value={value}
      defaultValue={defaultValue}
      onChange={(key) => onChange?.(key === null ? null : String(key))}
      placeholder={placeholder}
      className={fieldClass(className)}
    >
      <Label className="acc-field-label">{label}</Label>
      <AriaButton className="acc-input acc-select-trigger">
        <SelectValue className="acc-select-value" />
        {icons.chevronUpDown}
      </AriaButton>
      <FieldFoot description={description} errorMessage={errorMessage} />
      <Popover className="acc-layer acc-popover acc-listbox-popover" offset={4}>
        <ListBox className="acc-listbox" items={options}>
          {(option) => (
            <ListBoxItem id={option.id} textValue={option.label} className="acc-option">
              {({ isSelected }) => (
                <>
                  <span className="acc-option-label">{option.label}</span>
                  {isSelected ? icons.check : null}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

export type ComboOption = { id: string; code?: string; name: string };

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('ro-RO');

/** Every word typed appears in the option's code or name, ignoring case and diacritics. */
export function matchesOption(textValue: string, typed: string) {
  const haystack = fold(textValue);
  return fold(typed)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export type ComboBoxProps = FieldBase & {
  options: readonly ComboOption[];
  name?: string;
  value?: string | null;
  defaultValue?: string;
  onChange?: (value: string | null) => void;
  placeholder?: string;
  emptyMessage?: string;
};

/** A choice from a long list, searched by code and by name (accounts, partners, documents). */
export function ComboBox({
  label,
  description,
  errorMessage,
  className,
  options,
  value,
  defaultValue,
  onChange,
  placeholder,
  emptyMessage = 'Niciun rezultat',
  name,
  ...props
}: ComboBoxProps) {
  return (
    <AriaComboBox
      {...props}
      name={name}
      formValue="key"
      defaultItems={options}
      value={value}
      defaultValue={defaultValue}
      onChange={(key) => onChange?.(key === null ? null : String(key))}
      defaultFilter={matchesOption}
      className={fieldClass(className)}
    >
      <Label className="acc-field-label">{label}</Label>
      <div className="acc-input acc-combo">
        <Input className="acc-combo-input" placeholder={placeholder} />
        <AriaButton className="acc-combo-button">{icons.chevronDown}</AriaButton>
      </div>
      <FieldFoot description={description} errorMessage={errorMessage} />
      <Popover className="acc-layer acc-popover acc-listbox-popover" offset={4}>
        <ListBox
          className="acc-listbox"
          renderEmptyState={() => <p className="acc-listbox-empty">{emptyMessage}</p>}
        >
          {(option: ComboOption) => (
            <ListBoxItem
              id={option.id}
              textValue={option.code ? `${option.code} ${option.name}` : option.name}
              className="acc-option"
            >
              {option.code ? <span className="acc-option-code">{option.code}</span> : null}
              <span className="acc-option-label">{option.name}</span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
