import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/hooks.js';
import { t } from '../lib/i18n.js';
import * as web3 from '../lib/web3.js';
import * as f from '../lib/format.js';
import { nextMenuIndex } from '../lib/accessibility.js';
import { toast } from '../lib/toast.js';
import { agentLog, chooseWallet, copyWalletAddress, disconnectWallet, walletExplorerUrl, WALLET_LABELS } from '../state/controller.js';
import { Icon } from '../components/Icon.jsx';

const CHOICES = [
  { type: 'metamask', hintKey: 'wallet_evm' },
  { type: 'keplr', hintKey: 'wallet_native' },
  { type: 'leap', hintKey: 'wallet_native' }
];

export function WalletMenu() {
  const wallet = useApp((state) => state.wallet);
  const networkName = useApp((state) => state.networkName);
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState({});
  const [explorer, setExplorer] = useState(null);
  const [verify, setVerify] = useState({ busy: false, text: '', link: null });
  const wrap = useRef(null);
  const button = useRef(null);
  const address = wallet?.address ?? null;

  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) button.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return undefined;
    setAvailability(web3.walletAvailability());
    if (address) walletExplorerUrl(address).then(setExplorer);
    const onClick = (event) => { if (!wrap.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('click', onClick);
    // Focus the first item once the menu is in the document.
    requestAnimationFrame(() => wrap.current?.querySelector('[role="menuitem"]')?.focus());
    return () => document.removeEventListener('click', onClick);
  }, [open, address]);

  const onKeyDown = (event) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      close(event.key === 'Escape');
      return;
    }
    const items = [...wrap.current.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled);
    const next = nextMenuIndex(event.key, items.indexOf(event.target.closest('[role="menuitem"]')), items.length);
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  };

  const onVerify = async () => {
    setVerify({ busy: true, text: t('wallet_waiting_signature'), link: null });
    try {
      const result = await web3.verifyWalletOnChain();
      setVerify({ busy: false, text: t('wallet_verified', { wallet: result.walletType, hash: f.shortHash(result.txHash, 10, 8) }), link: result.explorerUrl });
      agentLog(`${result.walletType} wallet verification tx confirmed: ${result.txHash}`, 'ok');
    } catch (error) {
      const text = error.code === 'REJECTED' ? t('wallet_signature_rejected') : t('wallet_verification_failed', { msg: error.message });
      setVerify({ busy: false, text, link: null });
      toast(text, true);
    }
  };

  const label = WALLET_LABELS[wallet?.walletType] ?? 'MetaMask';
  return (
    <div className="wallet" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={`btn ${address ? 'btn-secondary' : 'btn-primary'} btn-sm wallet-btn`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('wallet_title', { network: networkName })}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <Icon name="wallet" size={15} />
        {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : t('wallet_connect')}
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <div className="menu wallet-menu" role="menu" aria-label={t('wallet_choose')} onKeyDown={onKeyDown}>
          {address ? (
            <>
              <div className="menu-section">
                <span className="menu-label">{label} · {wallet?.kind === 'cosmos' ? 'Injective native' : 'EVM'}</span>
                <code className="menu-address">{`${address.slice(0, 10)}…${address.slice(-6)}`}</code>
              </div>
              <button type="button" role="menuitem" className="menu-item" disabled={verify.busy} onClick={onVerify}>{t('wallet_verify')}</button>
              {verify.text ? (
                <p className="menu-status" role="status">
                  {verify.link ? <a href={verify.link} target="_blank" rel="noopener noreferrer">{verify.text}</a> : verify.text}
                </p>
              ) : null}
              <button type="button" role="menuitem" className="menu-item" onClick={() => { copyWalletAddress(); close(true); }}>{t('wallet_copy')}</button>
              {explorer ? <a role="menuitem" className="menu-item" href={explorer} target="_blank" rel="noopener noreferrer">{t('wallet_view_explorer')}</a> : null}
              <button type="button" role="menuitem" className="menu-item is-danger" onClick={() => { close(true); disconnectWallet(); }}>{t('wallet_disconnect')}</button>
            </>
          ) : (
            <>
              <span className="menu-label">{t('wallet_choose')}</span>
              {CHOICES.map((choice) => {
                const available = availability[choice.type];
                return (
                  <button
                    key={choice.type}
                    type="button"
                    role="menuitem"
                    className={`menu-item wallet-choice${available ? '' : ' is-unavailable'}`}
                    title={available ? undefined : t('wallet_missing_toast', { wallet: WALLET_LABELS[choice.type] })}
                    onClick={async () => { if (await chooseWallet(choice.type)) close(true); }}
                  >
                    <strong>{WALLET_LABELS[choice.type]}</strong>
                    <small>{t(choice.hintKey)}{available ? '' : ` · ${t('wallet_not_installed')}`}</small>
                  </button>
                );
              })}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
