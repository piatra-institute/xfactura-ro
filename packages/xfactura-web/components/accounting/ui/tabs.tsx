'use client';

import type { ReactNode } from 'react';
import { Tab, TabList, TabPanel, Tabs as AriaTabs } from 'react-aria-components';

export type TabItem = { id: string; label: string };

/**
 * The parts of a section. The selected part comes from the address, so choosing a tab calls
 * `onSelect` and the panel shows whatever the address now selects. Arrow keys move between tabs;
 * Enter or Space opens one.
 */
export function Tabs({
  label,
  items,
  selectedKey,
  onSelect,
  children,
}: {
  label: string;
  items: readonly TabItem[];
  selectedKey: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <AriaTabs
      className="acc-tabs"
      selectedKey={selectedKey}
      onSelectionChange={(key) => {
        if (String(key) !== selectedKey) onSelect(String(key));
      }}
      keyboardActivation="manual"
    >
      <TabList aria-label={label} className="acc-tab-list" items={items}>
        {(item) => (
          <Tab id={item.id} className="acc-tab">
            {item.label}
          </Tab>
        )}
      </TabList>
      <TabPanel id={selectedKey} className="acc-tab-panel">
        {children}
      </TabPanel>
    </AriaTabs>
  );
}
