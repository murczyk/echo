/** @vitest-environment happy-dom */
import { act, createElement, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageCardPreviewNavigation } from '../../shared/message-card/attachment-preview/message-card-preview.types';
import { useDeviceFileKeyboardNavigation } from '../use-device-file-keyboard-navigation';

let root: Root;
let container: HTMLDivElement;
let navigation: MessageCardPreviewNavigation;

function Preview({ fullscreen = false, enabled = true }) {
  const paneRef = useRef<HTMLElement>(null);
  const fullscreenContentRef = useRef<HTMLDivElement>(null);
  useDeviceFileKeyboardNavigation({
    paneRef,
    fullscreenContentRef,
    fullscreen,
    navigation,
    enabled,
  });
  return createElement(
    'device-details-page',
    null,
    <button id="tree-file">File in tree</button>,
    <section ref={paneRef} tabIndex={-1}>
      <button id="preview-file">File preview</button>
      <input />
      <video controls tabIndex={0} />
      <div role="separator" tabIndex={0} />
      <div role="slider" tabIndex={0} />
      <div data-audio-player-host tabIndex={0} />
      <div className="leaflet-container" tabIndex={0} />
    </section>,
    fullscreen
      ? createPortal(
          <div className="MuiDialog-container" tabIndex={-1}>
            <div role="dialog" tabIndex={-1}>
              <div ref={fullscreenContentRef}>
                <button id="fullscreen-file">Fullscreen preview</button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null,
  );
}

async function show(props: { fullscreen?: boolean; enabled?: boolean } = {}) {
  await act(async () => root.render(<Preview {...props} />));
}

async function press(key: string, target: HTMLElement = document.body, options = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  navigation = { index: 1, count: 3, onPrevious: vi.fn(), onNext: vi.fn() };
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('#3930 device file keyboard navigation', () => {
  it('navigates from the fullscreen focus container at both disabled edges', async () => {
    navigation = { ...navigation, index: 0, count: 2, previousDisabled: true };
    await show({ fullscreen: true });
    const focusContainer = document.querySelector<HTMLElement>('.MuiDialog-container')!;
    focusContainer.focus();
    expect((await press('ArrowLeft', focusContainer)).defaultPrevented).toBe(false);
    expect((await press('ArrowRight', focusContainer)).defaultPrevented).toBe(true);
    expect(navigation.onNext).toHaveBeenCalledTimes(1);
    navigation = { ...navigation, index: 1, previousDisabled: false, nextDisabled: true };
    await show({ fullscreen: true });
    focusContainer.focus();
    expect((await press('ArrowRight', focusContainer)).defaultPrevented).toBe(false);
    expect((await press('ArrowLeft', focusContainer)).defaultPrevented).toBe(true);
    expect(navigation.onPrevious).toHaveBeenCalledTimes(1);
  });
  it('navigates once from body, the persistent tree and fullscreen without losing native keys', async () => {
    await show();
    expect((await press('ArrowRight')).defaultPrevented).toBe(true);
    const tree = document.querySelector<HTMLButtonElement>('#tree-file')!;
    tree.focus();
    await press('ArrowLeft', tree);
    expect(navigation.onNext).toHaveBeenCalledTimes(1);
    expect(navigation.onPrevious).toHaveBeenCalledTimes(1);
    await show({ fullscreen: true });
    const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen-file')!;
    fullscreen.focus();
    await press('ArrowRight', fullscreen);
    expect(navigation.onNext).toHaveBeenCalledTimes(2);
    expect((await press('ArrowUp', fullscreen)).defaultPrevented).toBe(false);
    expect((await press(' ', fullscreen)).defaultPrevented).toBe(false);
    expect(navigation.onNext).toHaveBeenCalledTimes(2);
  });

  it('preserves editing, player, map, resize and modified keyboard controls', async () => {
    await show();
    for (const selector of [
      'input',
      'video',
      '[role="separator"]',
      '[role="slider"]',
      '[data-audio-player-host]',
      '.leaflet-container',
    ]) {
      const control = container.querySelector<HTMLElement>(selector)!;
      control.focus();
      expect((await press('ArrowRight', control)).defaultPrevented).toBe(false);
    }
    document.querySelector<HTMLButtonElement>('#preview-file')!.focus();
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'])
      expect(
        (await press('ArrowRight', document.body, { [modifier]: true })).defaultPrevented,
      ).toBe(false);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await press('ArrowRight', outside);
    expect(navigation.onNext).not.toHaveBeenCalled();
  });

  it('does not switch the underlying file while another dialog, menu or information popover is open', async () => {
    await show({ fullscreen: true });
    document.querySelector<HTMLButtonElement>('#fullscreen-file')!.focus();
    for (const role of ['dialog', 'alertdialog', 'menu', 'listbox']) {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', role);
      document.body.append(overlay);
      await press('ArrowRight');
      overlay.remove();
    }
    expect(navigation.onNext).not.toHaveBeenCalled();
    await press('ArrowRight');
    expect(navigation.onNext).toHaveBeenCalledTimes(1);
  });

  it('respects disabled edges, denied previews and default-prevented controls', async () => {
    navigation.previousDisabled = true;
    navigation.nextDisabled = true;
    await show();
    await press('ArrowLeft');
    await press('ArrowRight');
    navigation = { ...navigation, previousDisabled: false, nextDisabled: false, disabled: true };
    await show();
    await press('ArrowRight');
    navigation = { ...navigation, disabled: false };
    await show({ enabled: false });
    await press('ArrowRight');
    await show();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    await act(async () => document.body.dispatchEvent(event));
    expect(navigation.onNext).not.toHaveBeenCalled();
    expect(navigation.onPrevious).not.toHaveBeenCalled();
  });
});
