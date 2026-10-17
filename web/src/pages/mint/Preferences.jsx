import { useRef } from 'react';
import { useApp } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { commitMinPrice, commitSpeedPreference, setPreferenceDraft } from '../../state/controller.js';
import { Card, CardHead, Field } from '../../components/ui.jsx';

/** The exporter's constraints. The agent enforces them, so they are stored on the server per case. */
export function Preferences() {
  const preferences = useApp((s) => s.preferences);
  const disabled = useApp((s) => s.busy || Boolean(s.preferencesError));
  // Like a native change event: only a value that differs from the one on focus is committed.
  const focusValue = useRef(null);
  const commit = () => {
    if (focusValue.current === preferences.minPrice) return;
    focusValue.current = preferences.minPrice;
    commitMinPrice();
  };
  return (
    <Card aria-labelledby="prefs-h">
      <CardHead id="prefs-h" title={t('exporter_preferences')} level={3} />
      <p className="muted small">{t('prefs_hint')}</p>
      <div className="form-grid">
        <Field label={t('pref_min_price')} htmlFor="pref-min-price">
          <input
            id="pref-min-price"
            className="input"
            type="number"
            step="0.01"
            min="0"
            max="1"
            disabled={disabled}
            value={preferences.minPrice}
            onChange={(event) => setPreferenceDraft({ minPrice: event.target.value })}
            onFocus={() => { focusValue.current = preferences.minPrice; }}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
          />
        </Field>
        <Field label={t('pref_speed')} htmlFor="pref-speed">
          <select id="pref-speed" className="select" disabled={disabled} value={preferences.speed} onChange={(event) => commitSpeedPreference(event.target.value)}>
            <option value="">{t('pref_ai_recommended')}</option>
            <option value="FAST">{t('speed_FAST_label')}</option>
            <option value="BALANCED">{t('speed_BALANCED_label')}</option>
            <option value="LOW_COST">{t('speed_LOW_COST_label')}</option>
          </select>
        </Field>
      </div>
    </Card>
  );
}
