import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { GroupList } from './GroupList';
import type { GroupNavigationItem, GroupScope } from './group-navigation.types';

type Props = {
  id: string;
  open: boolean;
  groups: readonly GroupNavigationItem[];
  scope: GroupScope;
  onSelect: (scope: GroupScope) => void;
  onClose: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  variant?: 'overlay' | 'inline';
  title?: string;
};

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function GroupPanel({
  id,
  open,
  groups,
  scope,
  onSelect,
  onClose,
  triggerRef,
  variant = 'overlay',
  title = 'Групи',
}: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = `${id}-title`;
  const restoreFocus = useCallback(() => {
    queueMicrotask(() => triggerRef?.current?.focus());
  }, [triggerRef]);
  const close = useCallback(() => {
    onClose();
    restoreFocus();
  }, [onClose, restoreFocus]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    queueMicrotask(() => {
      const selected = panelRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
      (selected ?? panelRef.current)?.focus();
    });
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close, open]);

  if (!open) return null;

  return (
    <div className="group-navigation-panel-layer" data-variant={variant}>
      {variant === 'overlay' ? (
        <button
          type="button"
          className="group-navigation-backdrop"
          data-group-panel-backdrop
          aria-label="Закрити список груп"
          tabIndex={-1}
          onClick={close}
        />
      ) : null}
      <aside
        ref={panelRef}
        id={id}
        className="group-navigation-panel"
        data-group-panel
        data-variant={variant}
        role={variant === 'overlay' ? 'dialog' : undefined}
        aria-modal={variant === 'overlay' ? true : undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (variant !== 'overlay' || event.key !== 'Tab' || panelRef.current === null) return;
          const focusable = focusableElements(panelRef.current);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id={titleId} className="group-navigation-panel-title">
          {title}
        </h2>
        <GroupList groups={groups} scope={scope} onSelect={onSelect} labelledBy={titleId} />
      </aside>
    </div>
  );
}
