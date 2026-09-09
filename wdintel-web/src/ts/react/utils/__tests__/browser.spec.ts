/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import {
  handleNavigateWithinSpaClick,
  navigateWithinSpa,
  shouldHandleAsSpaClick,
  withBackTo,
} from '.././browser';

// @test-scope safeguard: preserves SPA navigation semantics and encoded return paths.
describe('browser utils', () => {
  it('adds encoded backTo to paths without query params', () => {
    window.history.replaceState({}, '', '/admin/users?page=2');

    expect(withBackTo('/admin/edit')).toBe('/admin/edit?backTo=%2Fadmin%2Fusers%3Fpage%3D2');
  });

  it('adds encoded backTo to paths with query params', () => {
    window.history.replaceState({}, '', '/admin/users?page=2');

    expect(withBackTo('/admin/edit?id=5')).toBe(
      '/admin/edit?id=5&backTo=%2Fadmin%2Fusers%3Fpage%3D2',
    );
  });

  it('pushes state and dispatches popstate when navigating within spa', () => {
    const listener = vi.fn();
    window.addEventListener('popstate', listener);

    navigateWithinSpa('/next-route');

    expect(window.location.pathname).toBe('/next-route');
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener('popstate', listener);
  });

  it('handles plain left clicks as spa clicks', () => {
    expect(
      shouldHandleAsSpaClick({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      } as never),
    ).toBe(true);
  });

  it('does not handle modified clicks as spa clicks', () => {
    expect(
      shouldHandleAsSpaClick({
        defaultPrevented: false,
        button: 1,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      } as never),
    ).toBe(false);
    expect(
      shouldHandleAsSpaClick({
        defaultPrevented: false,
        button: 0,
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      } as never),
    ).toBe(false);
    expect(
      shouldHandleAsSpaClick({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
      } as never),
    ).toBe(false);
    expect(
      shouldHandleAsSpaClick({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      } as never),
    ).toBe(false);
    expect(
      shouldHandleAsSpaClick({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
      } as never),
    ).toBe(false);
  });

  it('navigates within spa for plain left clicks', () => {
    const preventDefault = vi.fn();

    handleNavigateWithinSpaClick(
      {
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault,
      } as never,
      '/next-route',
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/next-route');
  });
});
