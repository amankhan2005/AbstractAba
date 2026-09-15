import { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';

/**
 * A KPI number that counts up on mount. Honours prefers-reduced-motion by
 * jumping straight to the final value. `format` lets a caller render a percent
 * or a currency string while the raw number still animates underneath.
 */
export function CountUp({ value = 0, duration = 0.9, format = (n) => Math.round(n).toLocaleString() }) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(reduce ? value : 0);
  const node = useRef(value);

  useEffect(() => {
    if (reduce) { setDisplay(value); return undefined; }
    const controls = animate(node.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v),
    });
    node.current = value;
    return () => controls.stop();
  }, [value, duration, reduce]);

  return <span>{format(display)}</span>;
}

export default CountUp;
