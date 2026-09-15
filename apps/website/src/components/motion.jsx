import { motion, useReducedMotion } from 'framer-motion';

/**
 * Motion helpers for the public website. Every animation is short, eases out,
 * and is removed entirely when the visitor prefers reduced motion (content is
 * then rendered in its final state with no transform or fade).
 */
export const EASE = [0.22, 1, 0.36, 1];

/** Fade + rise into view once, when the element scrolls into the viewport. */
export function Reveal({ as = 'div', delay = 0, y = 18, className, children, ...rest }) {
  const reduce = useReducedMotion();
  const Tag = motion[as] ?? motion.div;
  if (reduce) {
    const Plain = as;
    return <Plain className={className} {...rest}>{children}</Plain>;
  }
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.6, delay, ease: EASE }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Staggered container: children using `revealItem` animate in sequence. */
export function Stagger({ as = 'div', className, children, gap = 0.07, ...rest }) {
  const reduce = useReducedMotion();
  if (reduce) {
    const Plain = as;
    return <Plain className={className} {...rest}>{children}</Plain>;
  }
  const Tag = motion[as] ?? motion.div;
  return (
    <Tag
      className={className}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: '0px 0px -10% 0px' }}
      variants={{ hidden: {}, shown: { transition: { staggerChildren: gap } } }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export const revealItem = {
  hidden: { opacity: 0, y: 16 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

/** A child of <Stagger>. Renders a plain element under reduced motion. */
export function StaggerItem({ as = 'div', className, children, ...rest }) {
  const reduce = useReducedMotion();
  if (reduce) {
    const Plain = as;
    return <Plain className={className} {...rest}>{children}</Plain>;
  }
  const Tag = motion[as] ?? motion.div;
  return <Tag className={className} variants={revealItem} {...rest}>{children}</Tag>;
}
