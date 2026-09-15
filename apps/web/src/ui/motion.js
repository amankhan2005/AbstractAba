/**
 * Shared Framer Motion variants. Kept small and purposeful — premium means
 * fast and subtle, not a demo reel. Consumers pair these with the component's
 * own `useReducedMotion()` check; when reduced motion is requested we collapse
 * to instant transitions rather than removing the elements.
 */

export const pageVariants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16 } },
};

// Stagger container for KPI/card grids.
export const gridVariants = {
  animate: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

export const itemVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.34, ease: [0.22, 1, 0.36, 1] } },
};

export const drawerVariants = {
  initial: { x: '-100%' },
  animate: { x: 0, transition: { type: 'spring', stiffness: 420, damping: 40 } },
  exit: { x: '-100%', transition: { duration: 0.18 } },
};

export const scrimVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};
