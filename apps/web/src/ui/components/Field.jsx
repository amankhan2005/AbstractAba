import { useState } from 'react';
import { Icon } from '../icons.jsx';

/** Premium form field wrapper: label, helper, error, required marker. */
export function Field({ label, htmlFor, hint, error, required, children }) {
  return (
    <div className="rx-formfield">
      {label && <label htmlFor={htmlFor}>{label}{required && <span className="rx-req">*</span>}</label>}
      {children}
      {error ? <span className="rx-formfield__err"><Icon.Bell size={13} /> {error}</span>
        : hint ? <span className="rx-formfield__hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({ error, icon: IconCmp, ...rest }) {
  return (
    <div className={`rx-input${error ? ' rx-input--error' : ''}`}>
      {IconCmp && <IconCmp size={17} />}
      <input {...rest} />
    </div>
  );
}

/**
 * A password field with its own show / hide control. The toggle only switches
 * the input between type="password" and type="text" — the value, autofill
 * (autoComplete passes through) and the field's validation are untouched, and
 * each PasswordInput toggles independently.
 */
export function PasswordInput({ error, id, ...rest }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={`rx-input rx-input--password${error ? ' rx-input--error' : ''}`}>
      <input id={id} {...rest} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="rx-input__btn"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        {...(id ? { 'aria-controls': id } : {})}
      >
        {visible ? <Icon.EyeOff size={18} aria-hidden="true" /> : <Icon.Eye size={18} aria-hidden="true" />}
      </button>
    </div>
  );
}

export function Textarea({ error, rows = 4, ...rest }) {
  return <textarea className={`rx-textarea${error ? ' rx-input--error' : ''}`} rows={rows} {...rest} />;
}
