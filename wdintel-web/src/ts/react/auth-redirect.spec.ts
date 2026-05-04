/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { AUTH_UNAUTHORIZED_EVENT, buildLoginRedirectUrl } from './auth-redirect';

describe('auth redirect', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('builds a login redirect url from the current relative url', () => {
    window.history.replaceState({}, '', '/reports?page=2#summary');

    expect(buildLoginRedirectUrl()).toBe(
      `${window.location.origin}/login?redirect=%2Freports%3Fpage%3D2%23summary`,
    );
  });

  it('does not build a redirect url on the login page', () => {
    window.history.replaceState({}, '', '/login?foo=1#summary');

    expect(buildLoginRedirectUrl()).toBeNull();
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
