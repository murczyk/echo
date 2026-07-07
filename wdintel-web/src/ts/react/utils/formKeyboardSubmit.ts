import type { KeyboardEvent } from 'react';

type CanSubmit = boolean | (() => boolean);

const SINGLE_LINE_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

const UNSUPPORTED_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function resolveCanSubmit(canSubmit: CanSubmit): boolean {
  return typeof canSubmit === 'function' ? canSubmit() : canSubmit;
}

function isSingleLineInput(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false;
  const type = target.type.toLowerCase();
  if (UNSUPPORTED_INPUT_TYPES.has(type)) return false;
  return SINGLE_LINE_INPUT_TYPES.has(type) || !type;
}

function isMultilineInput(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement;
}

function isEligibleKeyboardTarget(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  return isSingleLineInput(target) || isMultilineInput(target);
}

function shouldSubmitSingleLineInput(event: KeyboardEvent<HTMLElement>): boolean {
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

function shouldSubmitMultilineInput(event: KeyboardEvent<HTMLElement>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
}

function isComposingKeyboardEvent(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    (event as KeyboardEvent<HTMLElement> & { isComposing?: boolean }).isComposing === true ||
    (event.nativeEvent as { isComposing?: boolean } | undefined)?.isComposing === true
  );
}

export function shouldSubmitFormFromKeyboard(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || isComposingKeyboardEvent(event) || event.key !== 'Enter')
    return false;
  if (!isEligibleKeyboardTarget(event.target)) return false;

  if (isSingleLineInput(event.target)) {
    return shouldSubmitSingleLineInput(event);
  }

  return shouldSubmitMultilineInput(event);
}

export function submitFormFromKeyboard(
  event: KeyboardEvent<HTMLElement>,
  canSubmit: CanSubmit,
): void {
  if (!shouldSubmitFormFromKeyboard(event)) return;
  event.preventDefault();
  if (!resolveCanSubmit(canSubmit)) return;

  const target = event.target;
  const form =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.form
      : null;
  if (!form) return;

  form.requestSubmit();
}

export function getFormKeyboardSubmitHandler(canSubmit: CanSubmit) {
  return (event: KeyboardEvent<HTMLElement>) => submitFormFromKeyboard(event, canSubmit);
}
