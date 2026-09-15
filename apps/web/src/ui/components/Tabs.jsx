import { motion } from 'framer-motion';

/** Animated tab bar with a sliding indicator. tabs: [{ id, label, icon? }] */
export function Tabs({ tabs = [], value, onChange }) {
  return (
    <div className="rx-tabs" role="tablist">
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button key={t.id} role="tab" aria-selected={active}
            className={`rx-tab${active ? ' is-active' : ''}`} onClick={() => onChange?.(t.id)}>
            {t.icon && <t.icon size={16} />}
            <span>{t.label}</span>
            {active && <motion.span layoutId="rx-tab-underline" className="rx-tab__underline" />}
          </button>
        );
      })}
    </div>
  );
}
