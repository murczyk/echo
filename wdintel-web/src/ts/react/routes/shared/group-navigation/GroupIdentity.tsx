import { GroupAvatar } from './GroupAvatar';
import type { GroupNavigationItem } from './group-navigation.types';

type Props = {
  group: GroupNavigationItem;
  className?: string;
  avatarSize?: 'small' | 'context' | 'medium';
};

export function GroupIdentity({ group, className, avatarSize = 'small' }: Props) {
  return (
    <span
      className={`group-navigation-identity${className ? ` ${className}` : ''}`}
      data-group-identity
    >
      <GroupAvatar kind={group.kind} name={group.name} size={avatarSize} />
      <span className="group-navigation-name" data-group-name title={group.name}>
        {group.name}
      </span>
    </span>
  );
}
