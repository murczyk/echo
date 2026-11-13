import { GroupAvatar } from './GroupAvatar';
import '../../../components/selectable-list.css';
import type { GroupNavigationItem, GroupScope } from './group-navigation.types';

type Props = {
  groups: readonly GroupNavigationItem[];
  scope: GroupScope;
  onSelect: (scope: GroupScope) => void;
  labelledBy?: string;
  title?: string;
  titleId?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

function isSelected(group: GroupNavigationItem, scope: GroupScope): boolean {
  return group.kind === 'all'
    ? scope.kind === 'all'
    : scope.kind === 'group' && group.masterKey === scope.masterKey;
}

export function GroupList({
  groups,
  scope,
  onSelect,
  labelledBy,
  title,
  titleId,
  loading,
  error,
  onRetry,
}: Props) {
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
                  className="group-navigation-list-item echo-selectable-list-item"
                  data-group-list-item
                  data-selected={selected ? 'true' : 'false'}
                  aria-current={selected ? 'true' : undefined}
                  aria-label={group.name}
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
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {loading ? (
        <p className="px-3 py-2" role="status">
          Завантажуємо групи…
        </p>
      ) : null}
      {error ? (
        <div className="px-3 py-2" role="alert">
          <p>{error}</p>
          {onRetry ? (
            <button
              type="button"
              className="group-navigation-list-item echo-selectable-list-item"
              onClick={onRetry}
            >
              Повторити
            </button>
          ) : null}
        </div>
      ) : null}
      {!loading && !error && !groups.some((group) => group.kind === 'group') ? (
        <p className="px-3 py-2" role="status">
          Груп не знайдено.
        </p>
      ) : null}
    </>
  );
}
