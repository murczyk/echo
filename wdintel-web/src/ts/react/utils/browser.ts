import type { MouseEvent } from 'react';

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

export function shouldHandleAsSpaClick(event: MouseEvent<HTMLElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function handleNavigateWithinSpaClick(event: MouseEvent<HTMLElement>, href: string): void {
  if (!shouldHandleAsSpaClick(event)) return;
  event.preventDefault();
  navigateWithinSpa(href);
}
