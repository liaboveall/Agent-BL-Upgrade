import { useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import { Button, Dialog, DialogHeader, Field } from '../../components/ui.jsx';
import {
  advancedShareAvailable, closePassportShare, exportPassportJson, exportPassportPng, mysteryState, mysteryStore, printPassport, shareText, updateShare
} from './mystery.js';

/** Share a Voyage Passport: a sanitized card only; a public transaction link needs two explicit opt-ins. */
export function ShareDialog() {
  useStore(mysteryStore, (s) => s.version);
  const credential = mysteryState.selectedPassport;
  const share = mysteryState.share;
  const available = advancedShareAvailable(credential);
  return (
    <Dialog id="passport-share-modal" open={mysteryState.shareOpen} onClose={closePassportShare} labelledBy="passport-share-title" className="passport-share-modal">
      <DialogHeader id="passport-share-title" title={t('passport_share_title')} onClose={closePassportShare} />
      <div className="dialog-body form-stack">
        <Field label={t('passport_nickname')} htmlFor="passport-share-nickname">
          <input id="passport-share-nickname" className="input" type="text" maxLength={32} autoComplete="off" placeholder={t('passport_nickname_placeholder')}
            value={share.nickname} onChange={(event) => updateShare({ nickname: event.target.value })} />
        </Field>
        <pre id="passport-share-preview" className="share-preview" aria-live="polite">{shareText()}</pre>
        <details className="disclosure passport-advanced">
          <summary>{t('passport_advanced_share')}</summary>
          <div className="disclosure-body">
            <p id="passport-advanced-note" className="muted small">{available ? t('passport_advanced_note') : t('passport_advanced_unavailable')}</p>
            <label className="check"><input id="passport-advanced-share" type="checkbox" disabled={!available} checked={share.advanced} onChange={(event) => updateShare({ advanced: event.target.checked })} />{t('passport_advanced_enable')}</label>
            <label className="check"><input id="passport-advanced-confirm" type="checkbox" disabled={!share.advanced} checked={share.confirmed} onChange={(event) => updateShare({ confirmed: event.target.checked })} />{t('passport_advanced_confirm')}</label>
          </div>
        </details>
        <Field label={t('passport_sanitized_json')} htmlFor="passport-json-preview">
          <textarea id="passport-json-preview" className="code-area" readOnly spellCheck={false} value={mysteryState.shareCard ? JSON.stringify(mysteryState.shareCard, null, 2) : ''} />
        </Field>
        <p className="notice">{t('passport_fixed_disclaimer')}</p>
        <div className="button-row end">
          <Button id="passport-share-copy" variant="ghost" onClick={async () => {
            try { await navigator.clipboard.writeText(shareText()); toast(t('passport_copied')); } catch { toast(t('passport_copy_failed'), true); }
          }}>{t('passport_copy')}</Button>
          <Button id="passport-export-json" variant="ghost" onClick={exportPassportJson}>{t('passport_export_json')}</Button>
          <Button id="passport-export-png" variant="ghost" onClick={exportPassportPng}>{t('passport_export_png')}</Button>
          <Button id="passport-print" variant="primary" onClick={printPassport}>{t('passport_export_pdf')}</Button>
        </div>
      </div>
    </Dialog>
  );
}
