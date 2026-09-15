const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' };

export const ChevronLeft = () => <svg {...base}><path d="M15 18l-6-6 6-6" /></svg>;
export const ChevronRight = () => <svg {...base}><path d="M9 18l6-6-6-6" /></svg>;
export const ChevronDown = () => <svg {...base} width={14} height={14}><path d="M6 9l6 6 6-6" /></svg>;
export const ArrowRight = () => <svg {...base} width={14} height={14}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
export const CalendarIcon = () => (
  <svg {...base} width={17} height={17}>
    <rect x="3" y="4.5" width="18" height="16.5" rx="3" />
    <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
  </svg>
);
