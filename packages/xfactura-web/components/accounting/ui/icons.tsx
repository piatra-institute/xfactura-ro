import type { ReactNode } from 'react';

/** Line icons drawn on a 20-unit grid in the current text colour; decorative unless labelled. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="acc-icon"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const icons = {
  home: (
    <Icon>
      <path d="M3.5 9 10 3.5 16.5 9" />
      <path d="M5 8v8.5h10V8" />
      <path d="M8.5 16.5v-4.5h3v4.5" />
    </Icon>
  ),
  review: (
    <Icon>
      <path d="M4 5.5 5.5 7 8 4.5" />
      <path d="M4 11.5 5.5 13 8 10.5" />
      <path d="M10.5 6h6M10.5 12h6M4 16.5h12.5" />
    </Icon>
  ),
  questions: (
    <Icon>
      <path d="M3.5 4.5h13v9h-7l-4 3v-3h-2z" />
      <path d="M8.5 7.5a1.5 1.5 0 1 1 2 1.4c-.4.2-.5.5-.5.9" />
      <path d="M10 11.5v.01" />
    </Icon>
  ),
  documents: (
    <Icon>
      <path d="M5 2.5h6.5l3.5 3.5v11.5H5z" />
      <path d="M11.5 2.5V6H15" />
      <path d="M7.5 10h5M7.5 13h5" />
    </Icon>
  ),
  bank: (
    <Icon>
      <path d="M3 7.5 10 3.5l7 4" />
      <path d="M4.5 8.5v6M8.5 8.5v6M11.5 8.5v6M15.5 8.5v6" />
      <path d="M3 16.5h14" />
    </Icon>
  ),
  registers: (
    <Icon>
      <path d="M4.5 3h9a2 2 0 0 1 2 2v12h-9a2 2 0 0 1-2-2z" />
      <path d="M4.5 15a2 2 0 0 1 2-2h9" />
      <path d="M8 6.5h4.5" />
    </Icon>
  ),
  deadlines: (
    <Icon>
      <path d="M3.5 5h13v11.5h-13z" />
      <path d="M3.5 8.5h13M7 3v3.5M13 3v3.5" />
      <path d="M7.5 12.5l1.5 1.5 3.5-3.5" />
    </Icon>
  ),
  settings: (
    <Icon>
      <path d="M3.5 6h6M13.5 6h3M3.5 14h3M10.5 14h6" />
      <circle cx="11.5" cy="6" r="2" />
      <circle cx="8.5" cy="14" r="2" />
    </Icon>
  ),
  menu: (
    <Icon>
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
    </Icon>
  ),
  close: (
    <Icon>
      <path d="M5 5l10 10M15 5 5 15" />
    </Icon>
  ),
  chevronDown: (
    <Icon>
      <path d="M6 8l4 4 4-4" />
    </Icon>
  ),
  chevronUpDown: (
    <Icon>
      <path d="M7 7.5 10 4.5l3 3M7 12.5l3 3 3-3" />
    </Icon>
  ),
  chevronLeft: (
    <Icon>
      <path d="M12 5 7 10l5 5" />
    </Icon>
  ),
  chevronRight: (
    <Icon>
      <path d="M8 5l5 5-5 5" />
    </Icon>
  ),
  check: (
    <Icon>
      <path d="M4.5 10.5 8 14l7.5-8" />
    </Icon>
  ),
  plus: (
    <Icon>
      <path d="M10 4.5v11M4.5 10h11" />
    </Icon>
  ),
  calendar: (
    <Icon>
      <path d="M3.5 5h13v11.5h-13z" />
      <path d="M3.5 8.5h13M7 3v3.5M13 3v3.5" />
    </Icon>
  ),
  signOut: (
    <Icon>
      <path d="M8 3.5H4v13h4" />
      <path d="M12 6.5 15.5 10 12 13.5M15.5 10H8" />
    </Icon>
  ),
} as const;
