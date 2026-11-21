import type { SVGProps } from "react";

/**
 * Icon set — inline SVG, no icon font, no remote assets.
 * Every glyph is decorative by default (`aria-hidden`); pass a `title` when the
 * icon is the only label of an interactive control.
 */
const PATHS = {
  chat: "M4 5.5h16v10H9l-5 4v-14Z",
  rooms: "M3 6h8v12H3zM13 6h8v12h-8z",
  search: "M10.5 4a6.5 6.5 0 1 0 4.1 11.6L20 21l1.4-1.4-5.4-5.4A6.5 6.5 0 0 0 10.5 4Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z",
  memory: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M6 6h12v12H6zM10 10h4v4h-4z",
  project: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  board: "M4 5h5v14H4zM10.5 5h5v9h-5zM17 5h3v6h-3z",
  graph: "M6 6a2 2 0 1 1 0-.1M18 6a2 2 0 1 1 0-.1M12 18a2 2 0 1 1 0-.1M7.5 7.5 11 16M16.5 7.5 13 16",
  code: "m8 7-5 5 5 5M16 7l5 5-5 5",
  branch: "M7 4v10a3 3 0 0 0 3 3h6M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  review: "M5 4h9l5 5v11H5zM14 4v6h5M8 14h7M8 17h5",
  ci: "M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Zm-1 5v5l4 2 .9-1.7-2.9-1.5V8h-2Z",
  debug: "M12 4a3 3 0 0 1 3 3v1h1a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4h1V7a3 3 0 0 1 3-3Zm-4 6v2H4v2h4v3h8v-3h4v-2h-4v-2",
  artifact: "M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Zm0 2.2 6.6 3.3L12 11.8 5.4 8.5 12 5.2ZM5 10.3l6 3v5.4l-6-3v-5.4Zm8 8.4v-5.4l6-3v5.4l-6 3Z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  approval: "M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Zm-1 12-3-3 1.4-1.4L11 12.2l4.6-4.6L17 9l-6 6Z",
  report: "M6 3h12v18H6zM9 8h6M9 12h6M9 16h4",
  admin: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.4 4-2-1.2-.5-1.3.5-2.3-1.7-1-.3-1.2-2.4.4-1.3-.5L11.4 3h-2l-.6 2.3-1.3.5-2.3-1.7-1 1.7-1.2.3.4 2.4-.5 1.3L1 12l1.2 2 .5 1.3-.4 2.4 2.4.4 1.3.5L8.6 21h2l.6-2.3 1.3-.5 2.3 1.7 1-1.7 1.2-.3-.4-2.4.5-1.3L20.4 12Z",
  audit: "M5 3h14v18H5zM8 7h8M8 11h8M8 15h5",
  backup: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8ZM12 16v5",
  bell: "M12 3a6 6 0 0 0-6 6v4l-2 4h16l-2-4V9a6 6 0 0 0-6-6Zm-2 16a2 2 0 1 0 4 0",
  gate: "M4 4h16v6H4zM4 14h16v6H4zM8 7h2M8 17h2",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  chevron: "m9 6 6 6-6 6",
  chevronDown: "m6 9 6 6 6-6",
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z",
  send: "M4 12 20 4l-6 16-3-6-7-2Z",
  paperclip: "M8 12.5 15 5.5a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l7.5-7.5",
  refresh: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5",
  copy: "M8 8h12v12H8zM4 16V4h12",
  external: "M14 4h6v6M20 4l-8 8M18 14v6H4V6h6",
  download: "M12 4v10m0 0 4-4m-4 4-4-4M5 19h14",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
  check: "m5 13 4 4L19 7",
  x: "M7 7l10 10M17 7 7 17",
  warning: "M12 3 2 20h20L12 3Zm0 5v6m0 3v.5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v.5M12 11v6",
  back: "M20 12H4m0 0 6-6m-6 6 6 6",
  menu: "M4 7h16M4 12h16M4 17h16",
  terminal: "M4 5h16v14H4zM8 10l2.5 2.5L8 15M13 15h3",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-8 17a8 8 0 0 1 16 0",
  sparkles: "M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15Z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3.5 2",
  hash: "M9 3 7 21M17 3l-2 18M3 9h18M2 15h18",
  filter: "M4 5h16l-6 7v6l-4 2v-8L4 5Z",
  pin: "M9 3h6l-1 5 4 4H6l4-4-1-5Zm3 9v9",
  bookmark: "M7 3h10v18l-5-4-5 4V3Z",
  reply: "M10 5 3 11l7 6v-4h5a5 5 0 0 0 5-5v-1",
  thread: "M5 4h14v9H10l-5 4V4Z",
  trash: "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13",
  edit: "M4 20h4l10-10-4-4L4 16v4Zm10-14 4 4",
  eye: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  lockOpen: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 5.6-1.5",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.5M8 17h.5",
  wifi: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 20h.5",
  wifiOff: "M2 2l20 20M8.5 15.5a5 5 0 0 1 6.5.4M5 12a10 10 0 0 1 4-2.4M2 9a15 15 0 0 1 4-2.4M19 12a10 10 0 0 0-3-2.2",
  key: "M15 4a5 5 0 1 1-4 8l-1.5 1.5H8V15H6v2H3v-3l7-7a5 5 0 0 1 5-3Z",
  play: "M7 4l13 8-13 8V4Z",
  pause: "M7 4h4v16H7zM13 4h4v16h-4z",
  columns: "M4 4h16v16H4zM10 4v16M15.5 4v16",
  history: "M12 3a9 9 0 1 0 8.5 12M12 3v6M12 3h6M4.5 9H3V7",
  diff: "M7 4v8M3 8h8M17 16v4M15 18h4",
  merge: "M7 4v10a4 4 0 0 0 4 4h6M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  shieldHalf: "M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Zm0 2v14",
  gauge: "M12 20a8 8 0 1 1 8-8M12 12l5-4",
  database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  /** Provide only when the icon carries meaning on its own. */
  title?: string;
}

export function Icon({ name, size = 16, title, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
