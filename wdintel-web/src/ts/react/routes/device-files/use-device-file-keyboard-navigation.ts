import { dialogClasses } from '@mui/material/Dialog';
import { useEffect, type RefObject } from 'react';

import type { MessageCardPreviewNavigation } from '../shared/message-card/attachment-preview/message-card-preview.types';
import { shouldIgnoreArrowNavigation } from '../shared/message-card/document-preview-utils';

function isVisible(element: HTMLElement) {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function ignoresNavigation(target: EventTarget | null) {
  return (
    shouldIgnoreArrowNavigation(target) ||
    (target instanceof HTMLElement &&
      target.closest('audio, video, [role="combobox"], [role="spinbutton"], [role="separator"]') !==
        null)
  );
}

function belongsToPreview(target: EventTarget | null, scope: HTMLElement) {
  return (
    target === window ||
    target === document ||
    target === document.body ||
    target === document.documentElement ||
    (target instanceof Node && scope.contains(target))
  );
}

export function useDeviceFileKeyboardNavigation({
  paneRef,
  fullscreenContentRef,
  fullscreen,
  navigation,
  enabled,
}: {
  paneRef: RefObject<HTMLElement>;
  fullscreenContentRef: RefObject<HTMLDivElement>;
  fullscreen: boolean;
  navigation?: MessageCardPreviewNavigation;
  enabled: boolean;
}) {
  useEffect(() => {
    if (!enabled || !navigation || navigation.disabled || navigation.count <= 1) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !['ArrowLeft', 'ArrowRight'].includes(event.key) ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.composedPath().some(ignoresNavigation) ||
        ignoresNavigation(document.activeElement)
      )
        return;
      const scope = fullscreen
        ? fullscreenContentRef.current?.closest<HTMLElement>('[role="dialog"]')
        : paneRef.current;
      const focusScope = fullscreen
        ? (scope?.closest<HTMLElement>(`.${dialogClasses.container}`) ?? scope)
        : (scope?.closest<HTMLElement>('device-details-page') ?? scope);
      if (
        !scope ||
        !focusScope ||
        !isVisible(scope) ||
        !belongsToPreview(event.target, focusScope) ||
        !belongsToPreview(document.activeElement, focusScope)
      )
        return;
      const owner = scope.closest('[role="dialog"], [role="alertdialog"]');
      const overlays = document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
      );
      if ([...overlays].some((overlay) => overlay !== owner && isVisible(overlay))) return;
      const previous = event.key === 'ArrowLeft';
      if (previous ? navigation.previousDisabled : navigation.nextDisabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (previous) navigation.onPrevious();
      else navigation.onNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, fullscreen, fullscreenContentRef, navigation, paneRef]);
}
