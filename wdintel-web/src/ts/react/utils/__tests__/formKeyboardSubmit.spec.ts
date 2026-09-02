/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getFormKeyboardSubmitHandler,
  shouldSubmitFormFromKeyboard,
  submitFormFromKeyboard,
} from '../formKeyboardSubmit';

function buildKeyboardEvent(
  target: EventTarget | null,
  init: {
    ctrlKey?: boolean;
    isComposing?: boolean;
    key?: string;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: init.key ?? 'Enter',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  });

  Object.defineProperty(event, 'target', { configurable: true, value: target });
  Object.defineProperty(event, 'isComposing', {
    configurable: true,
    value: init.isComposing ?? false,
  });

  return event;
}

function buildFormWithTarget(targetTag: 'input' | 'textarea', inputType?: string) {
  const form = document.createElement('form');
  const target = document.createElement(targetTag);
  if (targetTag === 'input' && inputType) {
    target.type = inputType;
  }
  form.appendChild(target);
  document.body.appendChild(form);
  const requestSubmit = vi.fn();
  Object.defineProperty(form, 'requestSubmit', { configurable: true, value: requestSubmit });
  return { form, target, requestSubmit };
}

// @test-scope regression: https://github.com/echoua/echo/issues/2746
describe('formKeyboardSubmit', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('submits a single-line input on enter when valid', () => {
    const { target, requestSubmit } = buildFormWithTarget('input');
    const event = buildKeyboardEvent(target);

    expect(shouldSubmitFormFromKeyboard(event)).toBe(true);

    submitFormFromKeyboard(event, true);

    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a single-line input when invalid', () => {
    const { target, requestSubmit } = buildFormWithTarget('input');
    const event = buildKeyboardEvent(target);

    submitFormFromKeyboard(event, false);

    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('submits a textarea on cmd+enter and ctrl+enter when valid', () => {
    const { target, requestSubmit } = buildFormWithTarget('textarea');

    const cmdEvent = buildKeyboardEvent(target, { metaKey: true });
    const ctrlEvent = buildKeyboardEvent(target, { ctrlKey: true });

    expect(shouldSubmitFormFromKeyboard(cmdEvent)).toBe(true);
    expect(shouldSubmitFormFromKeyboard(ctrlEvent)).toBe(true);

    submitFormFromKeyboard(cmdEvent, true);
    submitFormFromKeyboard(ctrlEvent, true);

    expect(requestSubmit).toHaveBeenCalledTimes(2);
    expect(cmdEvent.defaultPrevented).toBe(true);
    expect(ctrlEvent.defaultPrevented).toBe(true);
  });

  it('does not submit a textarea on plain enter', () => {
    const { target, requestSubmit } = buildFormWithTarget('textarea');
    const event = buildKeyboardEvent(target);

    submitFormFromKeyboard(event, true);

    expect(shouldSubmitFormFromKeyboard(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('does not submit a textarea on shift+enter', () => {
    const { target, requestSubmit } = buildFormWithTarget('textarea');
    const event = buildKeyboardEvent(target, { shiftKey: true });

    submitFormFromKeyboard(event, true);

    expect(shouldSubmitFormFromKeyboard(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('prevents a textarea cmd+enter when invalid', () => {
    const { target, requestSubmit } = buildFormWithTarget('textarea');
    const event = buildKeyboardEvent(target, { metaKey: true });

    expect(shouldSubmitFormFromKeyboard(event)).toBe(true);
    submitFormFromKeyboard(event, false);

    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('prevents a textarea ctrl+enter when invalid', () => {
    const { target, requestSubmit } = buildFormWithTarget('textarea');
    const event = buildKeyboardEvent(target, { ctrlKey: true });

    expect(shouldSubmitFormFromKeyboard(event)).toBe(true);
    submitFormFromKeyboard(event, false);

    expect(event.defaultPrevented).toBe(true);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('does not submit a textarea on alt+enter', () => {
    const { target, requestSubmit } = buildFormWithTarget('textarea');
    const event = buildKeyboardEvent(target, { altKey: true });

    submitFormFromKeyboard(event, true);

    expect(shouldSubmitFormFromKeyboard(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('ignores composing input', () => {
    const { target, requestSubmit } = buildFormWithTarget('input');
    const event = buildKeyboardEvent(target, { isComposing: true });

    submitFormFromKeyboard(event, true);

    expect(shouldSubmitFormFromKeyboard(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('ignores unsupported input types', () => {
    const { target, requestSubmit } = buildFormWithTarget('input', 'checkbox');
    const event = buildKeyboardEvent(target);

    submitFormFromKeyboard(event, true);

    expect(shouldSubmitFormFromKeyboard(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('does not throw when the target is not inside a form', () => {
    const target = document.createElement('input');
    const event = buildKeyboardEvent(target);

    expect(() => submitFormFromKeyboard(event, true)).not.toThrow();
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores already prevented events', () => {
    const { target, requestSubmit } = buildFormWithTarget('input');
    const event = buildKeyboardEvent(target);

    event.preventDefault();

    submitFormFromKeyboard(event, true);

    expect(shouldSubmitFormFromKeyboard(event)).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('can be wrapped in a handler', () => {
    const { target, requestSubmit } = buildFormWithTarget('input');
    const handler = getFormKeyboardSubmitHandler(true);
    const event = buildKeyboardEvent(target);

    handler(event);

    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});
