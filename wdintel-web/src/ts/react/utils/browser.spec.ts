/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import { navigateWithinSpa, withBackTo } from './browser';

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
});
