import { GroupList, type GroupScope } from '../shared/group-navigation';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  leftPanelVisible: boolean;
  fullHeight?: boolean;
};

export function AnalysisLeftPanel({ page, leftPanelVisible, fullHeight = false }: Props) {
  if (!leftPanelVisible) return null;

  const selectGroup = (scope: GroupScope) => {
    const selected = page.groupNavigation.groups.find((group) =>
      scope.kind === 'all'
        ? group.kind === 'all'
        : group.kind === 'group' && group.masterKey === scope.masterKey,
    );
    page.selectGroupScope(
      scope,
      selected?.kind === 'group' ? selected.oldestUnreadMessageRef : null,
    );
    if (fullHeight) page.toggleLeftPanel();
  };

  return (
    <aside
      aria-label="Навігація груп"
      className={
        'flex h-full min-h-0 flex-col overflow-hidden' +
        (fullHeight
          ? ''
          : ' min-[1200px]:border-r min-[1200px]:border-solid min-[1200px]:border-black/12 dark:min-[1200px]:border-white/12')
      }
    >
      <section
        data-analysis-group-list
        aria-labelledby={fullHeight ? undefined : 'analysis-groups-title'}
        className="flex min-h-0 flex-1 flex-col px-3 py-2"
      >
        {!fullHeight ? (
          <h2
            id="analysis-groups-title"
            className="m-0 px-2 pb-1 !text-sm !leading-5 font-medium text-black/60 dark:text-white/60"
          >
            Групи
          </h2>
        ) : null}
        <GroupList
          groups={page.groupNavigation.groups}
          scope={page.groupNavigation.scope}
          onSelect={selectGroup}
          labelledBy={fullHeight ? undefined : 'analysis-groups-title'}
        />
      </section>
    </aside>
  );
}
