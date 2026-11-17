'use client';

import { useLayoutEffect, useRef, useState } from 'react';

/** Forms whose first refused field has already taken focus during the current submission. */
const focused = new WeakSet<HTMLFormElement>();

/**
 * Focuses the element `target` returns after the next render, once a refused field shows its
 * reason, so assistive technology reads the reason with the field.
 */
export function useFocusAfterRender(target: () => HTMLElement | null | undefined) {
  const [request, setRequest] = useState(0);
  useLayoutEffect(() => {
    if (request) target()?.focus();
  }, [request]);
  return () => setRequest((count) => count + 1);
}

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
  /** Called when a submission is refused; `first` is true for the form's first refused field. */
  onInvalid: (first: boolean) => void;
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
        // The browser reports every refused control in order; only the first takes focus.
        const form = event.currentTarget.form;
        const first = !form || !focused.has(form);
        if (form && first) {
          focused.add(form);
          setTimeout(() => focused.delete(form));
        }
        onInvalid(first);
      }}
    />
  );
}
