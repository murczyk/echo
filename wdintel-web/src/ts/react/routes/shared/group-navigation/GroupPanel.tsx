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

  useEffect(() => {
    if (!open || variant !== 'overlay') return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target) || triggerRef?.current?.contains(event.target)) {
        return;
      }
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose, open, triggerRef, variant]);

  if (!open) return null;

  return (
    <div className="group-navigation-panel-layer" data-variant={variant}>
      <aside
        ref={panelRef}
        id={id}
        className="group-navigation-panel"
        data-group-panel
        data-variant={variant}
        role={variant === 'overlay' ? 'dialog' : undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <GroupList
          groups={groups}
          scope={scope}
          onSelect={onSelect}
          title={title}
          titleId={titleId}
        />
      </aside>
    </div>
  );
}
