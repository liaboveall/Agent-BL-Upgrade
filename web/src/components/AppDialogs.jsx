import { useEffect, useState } from 'react';
import { useStore } from '../state/hooks.js';
import { t } from '../lib/i18n.js';
import { answerDialog, dialogStore } from '../lib/dialogs.js';
import { Button, Dialog, DialogHeader, Field } from './ui.jsx';

/** One host for the app's small questions, so a token or a reason is asked in the page's own style (and a token is masked). */
export function AppDialogs() {
  const request = useStore(dialogStore, (state) => state.request);
  const [value, setValue] = useState('');
  useEffect(() => { setValue(''); }, [request?.id]);
  // showModal() focuses the first control (the close button); the question itself should take the focus.
  const requestId = request?.id;
  useEffect(() => {
    if (requestId) document.querySelector('#app-dialog [data-autofocus]')?.focus();
  }, [requestId]);
  const confirm = request?.kind === 'confirm';
  const cancel = () => answerDialog(confirm ? false : null);
  const submit = (event) => {
    event.preventDefault();
    if (!request) return;
    answerDialog(confirm ? true : value.trim());
  };
  const missing = request?.kind === 'text' && !request.optional && !value.trim();
  return (
    <Dialog id="app-dialog" open={Boolean(request)} onClose={cancel} labelledBy="app-dialog-title" variant="center" className="app-dialog">
      {request ? (
        <form className="app-dialog-form" onSubmit={submit}>
          <DialogHeader id="app-dialog-title" title={request.title} onClose={cancel} />
          <div className="dialog-body">
            {request.body ? <p>{request.body}</p> : null}
            {request.kind === 'text' ? (
              <Field label={request.label} htmlFor="app-dialog-input" hint={request.hint}>
                {request.multiline
                  ? <textarea id="app-dialog-input" className="code-area app-dialog-text" rows={3} data-autofocus value={value} onChange={(event) => setValue(event.target.value)} />
                  : <input id="app-dialog-input" className="input" type={request.secret ? 'password' : 'text'} autoComplete="off" data-autofocus value={value} onChange={(event) => setValue(event.target.value)} />}
              </Field>
            ) : null}
            <div className="button-row end">
              <Button variant="ghost" onClick={cancel}>{t('dialog_cancel')}</Button>
              <Button type="submit" variant="primary" disabled={missing} data-autofocus={confirm ? '' : undefined}>{request.confirmLabel ?? t('dialog_ok')}</Button>
            </div>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
