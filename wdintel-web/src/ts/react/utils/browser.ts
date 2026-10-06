import type { MouseEvent } from 'react';
import { requestNavigation } from '../../browser/navigation-guard';

export function windowWidth() {
  return window.innerWidth;
}

export function withBackTo(path: string) {
  const backTo = window.location.href.replace(window.location.origin, '');
  const encoded = encodeURIComponent(backTo);
  return `${path}${path.includes('?') ? '&' : '?'}backTo=${encoded}`;
}

export function navigateWithinSpa(path: string) {
  void requestNavigation(path);
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
