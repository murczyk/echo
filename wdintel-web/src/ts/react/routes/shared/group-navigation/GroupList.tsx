import { GroupAvatar } from './GroupAvatar';
import type { GroupNavigationItem, GroupScope } from './group-navigation.types';

type Props = {
  groups: readonly GroupNavigationItem[];
  scope: GroupScope;
  onSelect: (scope: GroupScope) => void;
  labelledBy?: string;
  title?: string;
  titleId?: string;
};

function isSelected(group: GroupNavigationItem, scope: GroupScope): boolean {
  return group.kind === 'all'
    ? scope.kind === 'all'
    : scope.kind === 'group' && group.masterKey === scope.masterKey;
}

function unreadLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function itemLabel(group: GroupNavigationItem): string {
  if (group.unreadCount <= 0) return group.name;
  return `${group.name}, ${group.unreadCount} непрочитаних повідомлень`;
}

export function GroupList({ groups, scope, onSelect, labelledBy, title, titleId }: Props) {
  const orderedGroups = [
    ...groups.filter((group) => group.kind === 'all'),
    ...groups.filter((group) => group.kind === 'group'),
  ];
  const accessibleTitleId = title == null ? labelledBy : titleId;

  return (
    <>
      {title == null ? null : (
        <h2 id={titleId} className="group-navigation-list-title" data-group-list-title>
          {title}
        </h2>
      )}
      <nav
        className="group-navigation-list"
        aria-labelledby={accessibleTitleId}
        aria-label={accessibleTitleId == null ? 'Групи' : undefined}
      >
        <ul>
          {orderedGroups.map((group) => {
            const selected = isSelected(group, scope);
            const key = group.kind === 'all' ? 'all-groups' : group.masterKey;
            const nextScope: GroupScope =
              group.kind === 'all'
                ? { kind: 'all' }
                : { kind: 'group', masterKey: group.masterKey };
            return (
              <li key={key}>
                <button
                  type="button"
                  className="group-navigation-list-item"
                  data-group-list-item
                  data-selected={selected ? 'true' : 'false'}
                  aria-current={selected ? 'true' : undefined}
                  aria-label={itemLabel(group)}
                  onClick={() => onSelect(nextScope)}
                >
                  <GroupAvatar
                    kind={group.kind}
                    name={group.name}
                    colorKey={group.kind === 'group' ? group.colorKey : undefined}
                  />
                  <span className="group-navigation-name" data-group-name title={group.name}>
                    {group.name}
                  </span>
                  {group.unreadCount > 0 ? (
                    <span className="group-navigation-unread" aria-hidden="true" data-group-unread>
                      {unreadLabel(group.unreadCount)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
