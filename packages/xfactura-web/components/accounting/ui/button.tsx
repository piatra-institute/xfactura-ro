'use client';

import type { ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { followLink } from '../navigation';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'small' | 'normal';

const classes = (variant: ButtonVariant, size: ButtonSize, extra?: string) =>
  ['acc-button', `acc-button--${variant}`, `acc-button--${size}`, extra].filter(Boolean).join(' ');

export type ButtonProps = Omit<AriaButtonProps, 'className' | 'children'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
};

/** A command. Primary for the one action a screen exists for; secondary otherwise. */
export function Button({
  variant = 'secondary',
  size = 'normal',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <AriaButton {...props} className={classes(variant, size, className)}>
      {children}
    </AriaButton>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'children' | 'aria-label'> & {
  /** What the button does; it is the button's accessible name and its tooltip. */
  label: string;
  icon: ReactNode;
};

/** A button that shows only an icon; its label names it for assistive technology. */
export function IconButton({
  label,
  icon,
  variant = 'quiet',
  size = 'normal',
  className,
  ...props
}: IconButtonProps) {
  return (
    <AriaButton
      {...props}
      aria-label={label}
      className={classes(variant, size, ['acc-icon-button', className].filter(Boolean).join(' '))}
    >
      {icon}
    </AriaButton>
  );
}

/** A link inside the accounting interface that looks like a button; it is followed in place. */
export function LinkButton({
  href,
  variant = 'secondary',
  size = 'normal',
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} onClick={followLink} className={classes(variant, size, className)}>
      {children}
    </a>
  );
}
