import { GroupIdentity } from './GroupIdentity';
import type { GroupNavigationItem } from './group-navigation.types';

type Props = {
  group: GroupNavigationItem;
  className?: string;
};

export function GroupIsland({ group, className }: Props) {
  return (
    <div className={`group-navigation-island${className ? ` ${className}` : ''}`} data-group-island>
      <GroupIdentity group={group} />
    </div>
  );
}
