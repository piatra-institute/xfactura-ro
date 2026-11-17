'use client';

import type { ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  Header,
  Heading,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Modal,
  ModalOverlay,
  Popover,
  Separator,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type MenuSectionProps as AriaMenuSectionProps,
  type PopoverProps,
} from 'react-aria-components';
import { IconButton } from './button';
import { icons } from './icons';

export { MenuTrigger, DialogTrigger } from 'react-aria-components';

/** A menu of actions or links, opened by the trigger it is placed after inside a MenuTrigger. */
export function Menu<T extends object>({
  placement = 'bottom start',
  className,
  ...props
}: Omit<AriaMenuProps<T>, 'className'> & {
  placement?: PopoverProps['placement'];
  className?: string;
}) {
  return (
    <Popover
      className={['acc-layer', 'acc-popover', 'acc-menu-popover', className]
        .filter(Boolean)
        .join(' ')}
      placement={placement}
      offset={6}
    >
      <AriaMenu {...props} className="acc-menu" />
    </Popover>
  );
}

/** One entry of a menu; a selected entry, or the current one among links, shows a check. */
export function MenuItem({
  icon,
  isCurrent,
  children,
  className,
  ...props
}: Omit<AriaMenuItemProps, 'className' | 'children'> & {
  icon?: ReactNode;
  /** Marks the link to the place already shown, such as the company open now. */
  isCurrent?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <AriaMenuItem
      {...props}
      textValue={props.textValue ?? (typeof children === 'string' ? children : undefined)}
      data-current={isCurrent || undefined}
      className={['acc-menu-item', className].filter(Boolean).join(' ')}
    >
      {({ isSelected, selectionMode }) => (
        <>
          {icon ?? (selectionMode !== 'none' ? <span className="acc-icon" /> : null)}
          <span className="acc-menu-label">{children}</span>
          {isSelected || isCurrent ? <span className="acc-menu-check">{icons.check}</span> : null}
        </>
      )}
    </AriaMenuItem>
  );
}

/** A titled group of menu entries; it may hold its own single selection. */
export function MenuSection<T extends object>({
  title,
  children,
  ...props
}: Omit<AriaMenuSectionProps<T>, 'className' | 'children'> & {
  title?: string;
  children: ReactNode;
}) {
  return (
    <AriaMenuSection {...props} className="acc-menu-section">
      {title ? <Header className="acc-menu-header">{title}</Header> : null}
      {children}
    </AriaMenuSection>
  );
}

export function MenuSeparator() {
  return <Separator className="acc-menu-separator" />;
}

export type DialogProps = {
  title: string;
  children: ReactNode;
  /** Controlled open state; leave both out inside a DialogTrigger. */
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  /** Closing by Escape or by pressing outside; off for a dialog that holds unsaved input. */
  isDismissable?: boolean;
  /** Buttons along the dialog's foot. */
  footer?: ReactNode;
};

/** A modal question or form above the screen it concerns. */
export function Dialog({
  title,
  children,
  isOpen,
  onOpenChange,
  isDismissable = true,
  footer,
}: DialogProps) {
  return (
    <ModalOverlay
      className="acc-layer acc-overlay"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
    >
      <Modal className="acc-dialog-modal">
        <AriaDialog className="acc-dialog">
          {({ close }) => (
            <>
              <div className="acc-dialog-head">
                <Heading slot="title" className="acc-dialog-title">
                  {title}
                </Heading>
                <IconButton label="Închide" icon={icons.close} size="small" onPress={close} />
              </div>
              <div className="acc-dialog-body">{children}</div>
              {footer ? <div className="acc-dialog-foot">{footer}</div> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

export type DrawerProps = {
  /** The drawer's accessible name. */
  label: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  children: ReactNode;
};

/** A panel that slides in from the start edge, over the screen; Escape or a press outside closes it. */
export function Drawer({ label, isOpen, onOpenChange, children }: DrawerProps) {
  return (
    <ModalOverlay
      className="acc-layer acc-overlay acc-drawer-overlay"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
    >
      <Modal className="acc-drawer">
        <AriaDialog className="acc-drawer-dialog" aria-label={label}>
          <div className="acc-drawer-close">
            <IconButton
              label="Închide meniul"
              icon={icons.close}
              onPress={() => onOpenChange(false)}
            />
          </div>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
