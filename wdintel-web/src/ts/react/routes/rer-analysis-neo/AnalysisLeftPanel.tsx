import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import { GroupList, type GroupScope } from '../shared/group-navigation';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  leftPanelVisible: boolean;
  isCompactLayout?: boolean;
  fullHeight?: boolean;
};

export function AnalysisLeftPanel({
  page,
  leftPanelVisible,
  isCompactLayout = false,
  fullHeight = false,
}: Props) {
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
      aria-label="Панель фільтрів"
      className={
        fullHeight
          ? 'flex h-full min-h-0 flex-col overflow-hidden'
          : 'flex h-auto min-h-0 flex-col overflow-hidden min-[1200px]:h-full'
      }
    >
      <section
        data-analysis-group-list
        aria-labelledby="analysis-groups-title"
        className="flex min-h-0 max-h-[42%] shrink-0 flex-col border-0 border-b border-solid border-black/12 px-3 py-2 dark:border-white/12"
      >
        <h2
          id="analysis-groups-title"
          className="m-0 px-2 pb-1 text-sm font-medium text-black/60 dark:text-white/60"
        >
          Групи
        </h2>
        <GroupList
          groups={page.groupNavigation.groups}
          scope={page.groupNavigation.scope}
          onSelect={selectGroup}
          labelledBy="analysis-groups-title"
        />
      </section>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AnalysisFiltersPanel
          page={page}
          isCompactLayout={isCompactLayout}
          fullHeight
          hideGroupSelection={page.groupNavigation.scope.kind === 'group'}
        />
      </div>
    </aside>
  );
}
