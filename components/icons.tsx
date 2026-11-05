import type { ReactNode } from 'react';

const glyphs = {
  'arrow-right': <><path d="M4.5 12h15" /><path d="m13 5.5 6.5 6.5L13 18.5" /></>,
  'arrow-left': <><path d="M19.5 12h-15" /><path d="m11 18.5-6.5-6.5L11 5.5" /></>,
  'arrow-up-right': <><path d="M7 17 17 7" /><path d="M8 7h9v9" /></>,
  activity: <><path d="M3 12h3l2.2-6 4.2 12 2.4-7H21" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3v4M16.5 3v4M3.5 10h17" /></>,
  check: <><path d="m5 12 4.2 4.2L19.5 6" /></>,
  'chevron-down': <><path d="m6 9 6 6 6-6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  eye: <><path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  'eye-off': <><path d="m3 3 18 18M10.6 6.2A9.9 9.9 0 0 1 12 6c6.3 0 9.5 6 9.5 6a15 15 0 0 1-3.1 3.7M6.2 6.3C3.8 8 2.5 12 2.5 12s3.2 6 9.5 6c.8 0 1.6-.1 2.3-.3" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.4 2.4 0 1 1 4.5 1.2c-.9 1.3-2.2 1.4-2.2 3" /><path d="M12 16.8v.1" /></>,
  join: <><path d="M7 5v4a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3v4" /><path d="M5 7 7 5l2 2M15 17l2 2 2-2" /><path d="M17 5v4a3 3 0 0 1-3 3h-4a3 3 0 0 0-3 3v4" /><path d="m15 7 2-2 2 2M5 17l2 2 2-2" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  lock: <><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  plug: <><path d="M8 7V3M16 7V3M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v4" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  shield: <><path d="M12 3 19 6v5c0 4.8-3 8.1-7 10-4-1.9-7-5.2-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></>,
  spark: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></>,
  users: <><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" /><circle cx="9.5" cy="7.5" r="3.5" /><path d="M17 4.3a3.5 3.5 0 0 1 0 6.8M21 20v-1.5a4 4 0 0 0-3-3.9" /></>,
  'trend-up': <><path d="m3.5 16 6-6 4 4L20.5 7" /><path d="M14.5 7h6v6" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs;

type IconProps = {
  name: IconName;
  size?: number;
  className?: string;
};

export function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[name]}
    </svg>
  );
}
