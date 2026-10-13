import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { changedDecisions, preserveFocus, scrollBehavior, syncChoiceGroup, wireChoiceGroup, wireMenuNavigation, wireModalFocus } from '../public/accessibility.js';

function choiceGroup(roles = ['tab', 'tab', 'tab']) {
  const events = new Map();
  const group = { querySelectorAll: () => choices, addEventListener: (name, handler) => events.set(name, handler) };
  const choices = roles.map((role, index) => {
    const attrs = new Map([['role', role]]);
    const node = { dataset: { view: String(index) }, attrs, disabled: false,
      getAttribute: (name) => attrs.get(name), setAttribute: (name, value) => attrs.set(name, value), closest: () => node,
      click: () => { group.selected = index; syncChoiceGroup(group, String(index), 'view'); }, focus: () => { group.focused = index; } };
    return node;
  });
  wireChoiceGroup(group);
  return { group, choices, press(key, index, extra = {}) {
    let prevented = false;
    events.get('keydown')({ key, target: choices[index], preventDefault: () => { prevented = true; }, ...extra });
    return prevented;
  } };
}

test('tab keyboard navigation wraps, handles Home/End and skips disabled choices', () => {
  const { group, choices, press } = choiceGroup();
  choices[1].disabled = true;
  assert.equal(press('ArrowRight', 0), true);
  assert.equal(group.selected, 2); assert.equal(group.focused, 2);
  assert.equal(choices[2].attrs.get('aria-selected'), 'true');
  assert.deepEqual(choices.map((item) => item.tabIndex), [-1, -1, 0]);
  press('ArrowRight', 2); assert.equal(group.focused, 0);
  press('End', 0); assert.equal(group.focused, 2);
  press('Home', 2); assert.equal(group.focused, 0);
  assert.equal(press('ArrowRight', 0, { ctrlKey: true }), false);
  assert.equal(press('Tab', 0), false);
});

test('payout radio group exposes checked state separately from navigation selection', () => {
  const { group, choices, press } = choiceGroup(['radio', 'radio', 'radio']);
  syncChoiceGroup(group, '0', 'view');
  press('ArrowLeft', 0);
  assert.equal(group.focused, 2);
  assert.deepEqual(choices.map((item) => item.attrs.get('aria-checked')), ['false', 'false', 'true']);
  assert.equal(choices[2].attrs.has('aria-selected'), false);
});

test('menu arrow keys only move focus and cannot select or connect a wallet', () => {
  let keydown, focused = -1, closed = false;
  const items = [0, 1, 2].map((index) => ({ focus: () => { focused = index; }, closest: (selector) => selector === '[hidden]' ? null : items[index], click: () => assert.fail('menu navigation must not activate an item') }));
  wireMenuNavigation({ addEventListener: (_name, fn) => { keydown = fn; }, querySelectorAll: () => items }, () => { closed = true; });
  keydown({ key: 'ArrowDown', target: items[0], preventDefault() {} });
  assert.equal(focused, 1); assert.equal(closed, false);
  keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(closed, true);
});

test('live rendering restores replaced controls without stealing focus from a connected control', () => {
  let moves = 0;
  const active = { id: 'autonomy', isConnected: true, getAttribute: () => null };
  const replacement = { id: 'autonomy', getAttribute: () => null, focus: (options) => { assert.equal(options.preventScroll, true); moves += 1; } };
  const root = { ownerDocument: { activeElement: active }, contains: () => true, querySelectorAll: () => [replacement] };
  preserveFocus(root, () => {}); assert.equal(moves, 0);
  preserveFocus(root, () => { active.isConnected = false; }); assert.equal(moves, 1);
  replacement.disabled = true;
  preserveFocus(root, () => {}); assert.equal(moves, 1);
});

test('modal Tab and reverse Tab wrap at the edges while ordinary navigation is untouched', () => {
  let keydown, focused = -1, prevented = 0;
  const items = [0, 1, 2].map((index) => ({ tabIndex: 0, getClientRects: () => [1], closest: () => null, focus: () => { focused = index; } }));
  const dialog = { querySelectorAll: () => items, ownerDocument: { activeElement: items[0] } };
  const root = { addEventListener: (_name, fn) => { keydown = fn; } };
  wireModalFocus(root);
  const event = { key: 'Tab', target: { closest: () => dialog }, shiftKey: true, preventDefault: () => { prevented += 1; } };
  keydown(event); assert.equal(focused, 2); assert.equal(prevented, 1);
  dialog.ownerDocument.activeElement = items[2]; event.shiftKey = false;
  keydown(event); assert.equal(focused, 0); assert.equal(prevented, 2);
  dialog.ownerDocument.activeElement = items[1]; keydown(event); assert.equal(prevented, 2);
});

test('timeline announcements exclude initial history, unchanged polls and removed decisions', () => {
  const pending = { decision_id: 'a', action: 'PAUSE', status: 'PENDING_APPROVAL' };
  const done = { ...pending, status: 'COMPLETED', execution: { reference: 'demo:a' } };
  const newDecision = { decision_id: 'b', action: 'RESUME', status: 'COMPLETED' };
  assert.deepEqual(changedDecisions(null, [pending]), []);
  assert.deepEqual(changedDecisions([pending], [{ ...pending }]), []);
  assert.deepEqual(changedDecisions([pending], [done, newDecision]), [done, newDecision]);
  assert.deepEqual(changedDecisions([done, newDecision], [done]), []);
});

test('reduced motion selects immediate programmatic scrolling', () => {
  const saved = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true }); assert.equal(scrollBehavior(), 'instant');
    globalThis.matchMedia = () => ({ matches: false }); assert.equal(scrollBehavior(), 'smooth');
  } finally { globalThis.matchMedia = saved; }
});

test('every dashboard tab owns a named panel and dialogs have accessible names', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const name of ['market', 'mint', 'agent']) {
    assert.match(html, new RegExp(`id="tab-${name}"[^>]+aria-controls="view-${name}"`, 'u'));
    assert.match(html, new RegExp(`id="view-${name}"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-${name}"`, 'u'));
  }
  for (const match of html.matchAll(/<dialog\b([^>]+)>/gu)) assert.match(match[1], /aria-labelledby=|data-i18n-aria=/u);
  assert.match(html, /id="ac-announcement"[^>]+aria-live="polite"/u);
  assert.doesNotMatch(html, /custom-select\.(?:js|css)/u);
});
