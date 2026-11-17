'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * The value a widget submits with its form. The widget's problem is attached as the control's
 * validity, so the browser refuses to submit the form while it stands; the browser's own bubble
 * is suppressed and `onInvalid` lets the widget show the problem beside itself and take focus.
 * The control is hidden from view and from assistive technology; the widget is what people use.
 */
export function FormValue({
  name,
  value,
  problem,
  isDisabled,
  onInvalid,
}: {
  name?: string;
  value: string;
  problem: string;
  isDisabled?: boolean;
  onInvalid: () => void;
}) {
  const control = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => control.current?.setCustomValidity(problem), [problem]);
  return (
    <input
      ref={control}
      className="acc-validation-input"
      tabIndex={-1}
      aria-hidden="true"
      name={name}
      value={value}
      disabled={isDisabled}
      onChange={() => {}}
      onInvalid={(event) => {
        event.preventDefault();
        onInvalid();
      }}
    />
  );
}
