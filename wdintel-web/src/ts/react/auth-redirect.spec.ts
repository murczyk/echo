/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { AUTH_UNAUTHORIZED_EVENT } from './auth-redirect';

// @test-scope safeguard: prevents unauthorized responses from either leaving a user on a protected route or creating a redirect loop on login.
describe('auth redirect', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('redirects when the unauthorized event is emitted outside login', () => {
    window.history.replaceState({}, '', '/reports?page=2#summary');

    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));

    expect(window.location.href).toBe(
      `${window.location.origin}/login?redirect=%2Freports%3Fpage%3D2%23summary`,
    );
  });

  it('does not redirect when the unauthorized event is emitted on login', () => {
    window.history.replaceState({}, '', '/login?foo=1#summary');

    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));

    expect(window.location.href).toBe(`${window.location.origin}/login?foo=1#summary`);
  });
});
