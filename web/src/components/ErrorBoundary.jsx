import { Component } from 'react';
import { t } from '../lib/i18n.js';

/**
 * Contains a render error to the region that failed. Without it one bad value (a date the chain returned,
 * a field a newer server dropped) unmounts the whole tree and leaves a blank page.
 */
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[agentbl] this region failed to render', error, info?.componentStack);
  }

  retry = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card error-panel" role="alert">
        <strong>{t('error_boundary_title')}</strong>
        <p className="muted">{t('error_boundary_body')}</p>
        <div className="button-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={this.retry}>{t('error_boundary_retry')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>{t('error_boundary_reload')}</button>
        </div>
      </div>
    );
  }
}
