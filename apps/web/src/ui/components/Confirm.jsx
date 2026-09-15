import { Modal } from './Modal.jsx';
import { Button } from '../primitives.jsx';

/**
 * A designed confirmation dialog — the only confirm surface in the redesigned
 * app. Never uses window.confirm. `tone='danger'` styles the primary action as
 * destructive.
 */
export function Confirm({ open, title, message, confirmLabel = 'Confirm', tone, busy, onConfirm, onCancel }) {
  return (
    <Modal open={open} onClose={onCancel} title={title} description={message} size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'primary' : 'primary'} onClick={onConfirm} loading={busy}
            className={tone === 'danger' ? 'rx-btn--danger' : ''}>{confirmLabel}</Button>
        </>
      }
    >{null}</Modal>
  );
}

export default Confirm;
