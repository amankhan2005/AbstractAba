/**
 * Inline stroke icons for the public website (24-grid, 1.75 stroke, round caps,
 * currentColor). Decorative by default; pass `label` for a meaningful icon.
 */
function Svg({ children, size = 18, label, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined}
      aria-label={label} focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const Icon = {
  Grid: (p) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></Svg>,
  Users: (p) => <Svg {...p}><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" /><circle cx="10" cy="8" r="3.2" /><path d="M20 19v-1.4a3.4 3.4 0 0 0-2.6-3.3" /><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" /></Svg>,
  User: (p) => <Svg {...p}><circle cx="12" cy="8" r="3.4" /><path d="M5.5 19a6.5 6.5 0 0 1 13 0" /></Svg>,
  Child: (p) => <Svg {...p}><circle cx="12" cy="7" r="3" /><path d="M7 21v-4l-1.5-2.5a2 2 0 0 1 1.7-3H17.8a2 2 0 0 1 1.7 3L18 17v4" /></Svg>,
  Calendar: (p) => <Svg {...p}><rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M3.5 9h17M8 3v3M16 3v3" /></Svg>,
  Clock: (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></Svg>,
  Clipboard: (p) => <Svg {...p}><rect x="5" y="4.5" width="14" height="16" rx="2.5" /><path d="M9 4.5V3.5A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5v1" /><path d="M8.5 11h7M8.5 15h4.5" /></Svg>,
  Check: (p) => <Svg {...p}><path d="M4.5 12.5l5 5 10-11" /></Svg>,
  CheckCircle: (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.5 2.5 4.7-5.2" /></Svg>,
  Inbox: (p) => <Svg {...p}><path d="M3.5 13.5 6 6a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 6l2.5 7.5" /><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5v3.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" /></Svg>,
  Wallet: (p) => <Svg {...p}><rect x="3.5" y="6" width="17" height="13" rx="2.5" /><path d="M3.5 10h17" /><circle cx="16.5" cy="14" r="1.2" /></Svg>,
  Shield: (p) => <Svg {...p}><path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" /><path d="M9 12l2 2 4-4.5" /></Svg>,
  Building: (p) => <Svg {...p}><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h6" /></Svg>,
  Alert: (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5M12 16h.01" /></Svg>,
  Cog: (p) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.6l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></Svg>,
  Arrow: (p) => <Svg {...p}><path d="M5 12h14m-6-6 6 6-6 6" /></Svg>,
  Doc: (p) => <Svg {...p}><path d="M7 3h7l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M14 3v4h4M9 13h6M9 16h6" /></Svg>,
  Sparkle: (p) => <Svg {...p}><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" /></Svg>,
  Lock: (p) => <Svg {...p}><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>,
  Mail: (p) => <Svg {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4.5 7 7.5 6 7.5-6" /></Svg>,
};
