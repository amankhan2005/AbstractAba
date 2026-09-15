import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import { Icon, Spinner } from '@/ui';

/**
 * Full-page email composer — editor LEFT, live preview RIGHT.
 *
 * Pure and presentational: all data (subject/body/preview/recipient/sender) and
 * all actions are passed in, so it holds no fetching logic and is unit-testable
 * in isolation. It renders inside the existing React app as a fixed overlay —
 * it never opens a new browser tab/window. The preview it shows is the SAME
 * server-rendered content the send path uses; recipient and sender are
 * server-resolved and read-only here (the frontend cannot spoof them).
 *
 * Responsive: two columns on desktop/tablet, stacked (editor → preview) on
 * mobile, via the .rx-emailfs CSS grid (no horizontal overflow).
 */
export function EmailComposerFullscreen({
  templateName,
  subject,
  body,
  variables = [],
  preview,          // { isPending, isError, error, data }
  sending = false,
  canSend = false,
  onSubjectChange,
  onBodyChange,
  onInsertVar,
  onSend,
  onBack,
  onClose,
}) {
  // Lock body scroll while the full-screen composer is open (same behaviour as
  // the design-system Modal), and restore it on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const d = preview?.data;
  const recipientText = d
    ? (d.recipient?.available
        ? `${d.recipient.name || 'Guardian'} <${d.recipient.email}>`
        : 'Guardian email not available')
    : 'Resolving…';
  const companyText = d?.sender?.name || '—';

  return createPortal(
    <div className="rx-emailfs" role="dialog" aria-modal="true" aria-label="Full-screen email composer">
      <header className="rx-emailfs__bar">
        <div className="rx-emailfs__barleft">
          <button type="button" className="rx-emailfs__iconbtn" onClick={onBack} aria-label="Back">
            <Icon.Return size={18} />
          </button>
          <div className="rx-emailfs__title">{templateName || 'Compose email'}</div>
        </div>
        <div className="rx-emailfs__barmeta">
          <div className="rx-emailfs__metacol">
            <span className="rx-emailfs__metalabel">Recipient</span>
            <span className="rx-emailfs__metaval" title={recipientText}>{recipientText}</span>
          </div>
          <div className="rx-emailfs__metacol">
            <span className="rx-emailfs__metalabel">Company</span>
            <span className="rx-emailfs__metaval" title={companyText}>{companyText}</span>
          </div>
          <button type="button" className="rx-emailfs__iconbtn" onClick={onClose} aria-label="Close">
            <Icon.Close size={18} />
          </button>
        </div>
      </header>

      <div className="rx-emailfs__body">
        {/* LEFT — editor */}
        <section className="rx-emailfs__editor" aria-label="Editor">
          <label className="rx-emailfs__field">
            <span className="rx-emailfs__flabel">Subject</span>
            <input
              className="rx-input"
              value={subject}
              maxLength={300}
              onChange={(e) => onSubjectChange?.(e.target.value)}
            />
          </label>
          <label className="rx-emailfs__field rx-emailfs__field--grow">
            <span className="rx-emailfs__flabel">Message</span>
            <textarea
              className="rx-input rx-emailfs__textarea"
              value={body}
              maxLength={8000}
              onChange={(e) => onBodyChange?.(e.target.value)}
            />
          </label>
          {variables.length > 0 && (
            <div className="rx-emailfs__vars">
              <div className="rx-row__meta" style={{ marginBottom: 6 }}>Insert a variable</div>
              <div className="rx-emailfs__chips">
                {variables.map((v) => (
                  <button key={v} type="button" className="rx-emailfs__chip" onClick={() => onInsertVar?.(v)}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* RIGHT — live preview (server-rendered) */}
        <section className="rx-emailfs__preview" aria-label="Live preview">
          <div className="rx-emailfs__previewhead">Live preview <span className="rx-row__meta">· rendered by the server</span></div>
          {preview?.isPending && !d ? <Spinner /> : preview?.isError ? (
            <p className="rx-formfield__err">{preview.error?.response?.data?.error?.message ?? 'Preview unavailable.'}</p>
          ) : d ? (
            <div className="rx-emailfs__previewcard">
              <div className="rx-emailfs__prow"><span className="rx-emailfs__plabel">To</span><span className={d.recipient?.available ? '' : 'rx-emailfs__warn'}>{recipientText}</span></div>
              <div className="rx-emailfs__prow"><span className="rx-emailfs__plabel">From</span><span>{companyText} (company sender)</span></div>
              <div className="rx-emailfs__prow"><span className="rx-emailfs__plabel">Subject</span><span>{d.subject}</span></div>
              <div className="rx-emailfs__prbody">{d.bodyText}</div>
              {d.unavailableVariables?.length > 0 && (
                <p className="rx-row__meta" style={{ marginTop: 8 }}>Unavailable: {d.unavailableVariables.join(', ')} (shown as “Not available”)</p>
              )}
            </div>
          ) : <p className="rx-row__meta">Start typing to preview.</p>}
        </section>
      </div>

      <footer className="rx-emailfs__foot">
        <span className="rx-row__meta">Recipient &amp; sender are resolved on the server.</span>
        <div className="rx-emailfs__footbtns">
          <button type="button" className="rx-btn rx-btn--ghost" onClick={onBack} disabled={sending}>Back</button>
          <button type="button" className="rx-btn rx-btn--primary" onClick={onSend} disabled={!canSend || sending}>
            {sending ? 'Sending…' : 'Send email'}
          </button>
        </div>
      </footer>
    </div>
  , document.body);
}

export default EmailComposerFullscreen;
