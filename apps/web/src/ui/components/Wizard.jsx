import { motion } from 'framer-motion';
import { Icon } from '../icons.jsx';

/** Step progress indicator. steps: [{ id, label }]; current = index. */
export function Stepper({ steps = [], current = 0 }) {
  return (
    <ol className="rx-stepper">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s.id} className={`rx-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="rx-step__dot">{state === 'done' ? <Icon.Check size={14} /> : i + 1}</span>
            <span className="rx-step__label">{s.label}</span>
            {i < steps.length - 1 && <span className="rx-step__bar" />}
          </li>
        );
      })}
    </ol>
  );
}

export function WizardPanel({ children }) {
  return (
    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.div>
  );
}
