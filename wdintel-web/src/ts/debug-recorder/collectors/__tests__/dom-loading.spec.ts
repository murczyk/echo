/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachDomLoadingCollector } from '../dom-loading';
import type { DebugEventInput } from '../../types';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const mutationTick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('DOM and loading collector', () => {
  it('reports a skeleton that is already visible when recording starts', () => {
    const skeleton = document.createElement('div');
    skeleton.dataset.debugSkeleton = '';
    document.body.append(skeleton);
    const events: DebugEventInput[] = [];

    const cleanup = attachDomLoadingCollector((input) => events.push(input));

    expect(events).toContainEqual({
      kind: 'skeleton.visibility',
      source: 'collector',
      details: { visible: true, count: 1 },
    });
    cleanup();
  });

  it('coalesces structural replacement, custom-element and allowlisted loading signals', async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const events: DebugEventInput[] = [];
    const cleanup = attachDomLoadingCollector((input) => events.push(input));

    const subtree = document.createElement('section');
    subtree.dataset.secret = 'ECHO_SECRET_SENTINEL';
    for (let index = 0; index < 50; index += 1) subtree.append(document.createElement('span'));
    const custom = document.createElement('echo-card');
    const skeleton = document.createElement('div');
    skeleton.dataset.debugSkeleton = '';
    skeleton.textContent = 'ECHO_SECRET_SENTINEL';
    document.body.append(subtree, custom, skeleton);
    await mutationTick();
    callbacks.splice(0).forEach((callback) => callback(16));

    custom.remove();
    skeleton.remove();
    await mutationTick();
    callbacks.splice(0).forEach((callback) => callback(32));

    expect(events.map((event) => event.kind)).toEqual([
      'dom.mutations',
      'dom.replacement',
      'dom.custom-elements',
      'skeleton.visibility',
      'dom.mutations',
      'dom.custom-elements',
      'skeleton.visibility',
    ]);
    expect(events[1]?.details).toMatchObject({ count: 1, itemCount: 51 });
    expect(events[2]?.details).toMatchObject({ outcome: 'connected', count: 1 });
    expect(events[3]?.details).toMatchObject({ visible: true, count: 1 });
    expect(events[5]?.details).toMatchObject({ outcome: 'disconnected', count: 1 });
    expect(events[6]?.details).toMatchObject({ visible: false, count: 0 });
    expect(JSON.stringify(events)).not.toContain('ECHO_SECRET_SENTINEL');
    cleanup();
  });

  it('ignores recorder roots and non-allowlisted loading classes', async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const events: DebugEventInput[] = [];
    const cleanup = attachDomLoadingCollector((input) => events.push(input));
    const root = document.createElement('div');
    root.dataset.debugRecorderRoot = '';
    document.body.append(root);
    await mutationTick();
    callbacks.splice(0).forEach((callback) => callback(1));
    events.splice(0);

    const large = document.createElement('section');
    for (let index = 0; index < 60; index += 1) large.append(document.createElement('i'));
    root.append(large);
    const fakeLoading = document.createElement('div');
    fakeLoading.className = 'loading';
    document.body.append(fakeLoading);
    await mutationTick();
    callbacks.splice(0).forEach((callback) => callback(2));

    expect(events.filter((event) => event.kind === 'dom.replacement')).toEqual([]);
    expect(events.filter((event) => event.kind === 'skeleton.visibility')).toEqual([]);
    cleanup();
  });

  it('bounds ten thousand mutations to one frame summary and disconnects exactly once', async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const events: DebugEventInput[] = [];
    const cleanup = attachDomLoadingCollector((input) => events.push(input));

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 10_000; index += 1) fragment.append(document.createElement('i'));
    document.body.append(fragment);
    await mutationTick();
    expect(callbacks).toHaveLength(1);
    callbacks.splice(0).forEach((callback) => callback(16));
    expect(events.filter((event) => event.kind === 'dom.mutations')).toHaveLength(1);

    cleanup();
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('bounds descendant inspection inside one large added subtree', async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const events: DebugEventInput[] = [];
    const cleanup = attachDomLoadingCollector((input) => events.push(input));
    const subtree = document.createElement('section');
    for (let index = 0; index < 2_000; index += 1) {
      subtree.append(document.createElement('span'));
    }

    document.body.append(subtree);
    await mutationTick();
    callbacks.splice(0).forEach((callback) => callback(16));

    expect(events.find((event) => event.kind === 'dom.replacement')?.details?.itemCount).toBe(
      1_000,
    );
    cleanup();
  });
});
