export function windowWidth() {
  return window.innerWidth;
}

export function withBackTo(path: string) {
  const backTo = window.location.href.replace(window.location.origin, '');
  const encoded = encodeURIComponent(backTo);
  return `${path}${path.includes('?') ? '&' : '?'}backTo=${encoded}`;
}

export function navigateWithinSpa(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
