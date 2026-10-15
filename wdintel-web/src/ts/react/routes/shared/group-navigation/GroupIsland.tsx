import type { Ref } from 'react';

import { GroupIdentity } from './GroupIdentity';
import type { GroupNavigationItem } from './group-navigation.types';

type Props = {
  group: GroupNavigationItem;
  expanded: boolean;
  onOpen: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  panelId?: string;
  className?: string;
};

export function GroupIsland({ group, expanded, onOpen, buttonRef, panelId, className }: Props) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`group-navigation-island${className ? ` ${className}` : ''}`}
      onClick={onOpen}
      aria-label={`Відкрити список груп. Поточна група: ${group.name}`}
      aria-expanded={expanded}
      aria-controls={panelId}
      data-group-island
    >
      <GroupIdentity group={group} />
    </button>
  );
}
