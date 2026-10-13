// Tiny dependency-free DOM helpers shared by the router (app.js) and the
// voyage view (voyage.js). Extracted verbatim from the original app.js so both
// views build DOM the same way.

export const $ = (sel, root = document) => root.querySelector(sel);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape a value for safe interpolation into an HTML string (element content and
 * quoted attribute values). Use it for every dynamic value placed in innerHTML:
 * server responses, error messages and user input are all untrusted. Prefer
 * el()/textContent where building DOM is practical.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Create an element. attrs supports: class, html, text, on<Event> handlers,
 * and any other attribute (true => boolean attribute). Children are flattened;
 * null/false are skipped; strings become text nodes.
 */
export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') {
      // 直接设置 style.cssText 而不是用 setAttribute，更可靠
      node.style.cssText = v;
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

let toastTimer;
export function toast(msg, isError = false) {
  const t = $('#toast');
  if (!t) return;
  const dialog = document.activeElement?.closest('dialog[open]') ?? [...document.querySelectorAll('dialog[open]')].at(-1);
  const host = dialog ?? document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = msg;
  t.className = `toast show${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3800);
}

export function setBusy(busy) {
  $('#live-pill')?.classList.toggle('busy', busy);
  $('.page')?.classList.toggle('busy', busy);
}
