import { GroupAvatar } from './GroupAvatar';

type Props = {
  group: {
    kind: 'all' | 'group';
    name: string;
    colorKey?: string | null;
  };
  className?: string;
  avatarSize?: 'small' | 'context' | 'medium';
};

export function GroupIdentity({ group, className, avatarSize = 'small' }: Props) {
  return (
    <span
      className={`group-navigation-identity${className ? ` ${className}` : ''}`}
      data-group-identity
    >
      <GroupAvatar
        kind={group.kind}
        name={group.name}
        colorKey={group.kind === 'group' ? group.colorKey : undefined}
        size={avatarSize}
      />
      <span className="group-navigation-name" data-group-name title={group.name}>
        {group.name}
      </span>
    </span>
  );
}
