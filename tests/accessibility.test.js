import assert from 'node:assert/strict';
import test from 'node:test';
import { changedDecisions, modalFocusWrap, nextChoiceIndex, nextMenuIndex, scrollBehavior } from '../web/src/lib/accessibility.js';

test('tab keyboard navigation wraps, handles Home/End and skips disabled choices', () => {
  const disabled = [false, true, false];
  assert.equal(nextChoiceIndex({ key: 'ArrowRight' }, 0, disabled), 2);
  assert.equal(nextChoiceIndex({ key: 'ArrowRight' }, 2, disabled), 0);
  assert.equal(nextChoiceIndex({ key: 'ArrowLeft' }, 0, disabled), 2);
  assert.equal(nextChoiceIndex({ key: 'ArrowDown' }, 0, disabled), 2, 'vertical arrows move like horizontal ones');
  assert.equal(nextChoiceIndex({ key: 'End' }, 0, disabled), 2);
  assert.equal(nextChoiceIndex({ key: 'Home' }, 2, disabled), 0);
});

test('modifier keys, Tab and keys outside the group are left to the browser', () => {
  const none = [false, false, false];
  assert.equal(nextChoiceIndex({ key: 'ArrowRight', ctrlKey: true }, 0, none), -1);
  assert.equal(nextChoiceIndex({ key: 'ArrowRight', altKey: true }, 0, none), -1);
  assert.equal(nextChoiceIndex({ key: 'ArrowRight', metaKey: true }, 0, none), -1);
  assert.equal(nextChoiceIndex({ key: 'Tab' }, 0, none), -1);
  assert.equal(nextChoiceIndex({ key: 'ArrowRight' }, -1, none), -1, 'focus outside the choices');
  assert.equal(nextChoiceIndex({ key: 'ArrowRight' }, 0, [true, true, true]), -1);
});

test('menu arrow keys only move focus, wrap, and ignore other keys', () => {
  assert.equal(nextMenuIndex('ArrowDown', 0, 3), 1);
  assert.equal(nextMenuIndex('ArrowDown', 2, 3), 0);
  assert.equal(nextMenuIndex('ArrowUp', 0, 3), 2);
  assert.equal(nextMenuIndex('Home', 2, 3), 0);
  assert.equal(nextMenuIndex('End', 0, 3), 2);
  assert.equal(nextMenuIndex('ArrowDown', -1, 3), 0, 'from outside the menu, down goes to the first item');
  assert.equal(nextMenuIndex('Enter', 0, 3), -1, 'activation is the item\'s own click');
  assert.equal(nextMenuIndex('ArrowDown', 0, 0), -1);
});

test('modal Tab and reverse Tab wrap at the edges while ordinary navigation is untouched', () => {
  const items = ['a', 'b', 'c'];
  assert.equal(modalFocusWrap(items, 'a', true), 'c');
  assert.equal(modalFocusWrap(items, 'c', false), 'a');
  assert.equal(modalFocusWrap(items, 'b', false), null);
  assert.equal(modalFocusWrap(items, 'b', true), null);
  assert.equal(modalFocusWrap(items, 'outside', false), 'a', 'focus that escaped comes back in');
  assert.equal(modalFocusWrap([], 'a', false), null);
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
