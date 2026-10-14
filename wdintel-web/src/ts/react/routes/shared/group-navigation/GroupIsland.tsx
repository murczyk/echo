import type { Ref } from 'react';

import { GroupAvatar } from './GroupAvatar';
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
      <GroupAvatar name={group.name} size="small" />
      <span className="group-navigation-name" data-group-name title={group.name}>
        {group.name}
      </span>
    </button>
  );
}
