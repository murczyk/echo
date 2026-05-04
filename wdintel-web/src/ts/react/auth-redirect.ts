export const AUTH_UNAUTHORIZED_EVENT = 'echo:api-unauthorized';
let unauthorizedRedirectListenerInstalled = false;

export function buildLoginRedirectUrl(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.location.pathname === '/login') return null;

  const redirect = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const loginUrl = new URL('/login', window.location.origin);
  loginUrl.searchParams.set('redirect', redirect);
  return loginUrl.toString();
}

export function redirectToLogin(): void {
  const loginUrl = buildLoginRedirectUrl();
  if (loginUrl === null) return;
  window.location.replace(loginUrl);
}

export function emitUnauthorizedEvent(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
}

function installAuthRedirectListener(): void {
  if (typeof window === 'undefined' || unauthorizedRedirectListenerInstalled) return;

  unauthorizedRedirectListenerInstalled = true;
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, redirectToLogin);
}

installAuthRedirectListener();
