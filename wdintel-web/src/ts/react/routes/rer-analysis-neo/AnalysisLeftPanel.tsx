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
    page.groupNavigation.select(scope);
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
        <GroupList
          groups={page.groupNavigation.groups}
          scope={page.groupNavigation.scope}
          onSelect={selectGroup}
          title={fullHeight ? undefined : 'Групи'}
          titleId={fullHeight ? undefined : 'analysis-groups-title'}
        />
      </section>
    </aside>
  );
}
