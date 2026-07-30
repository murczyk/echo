import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
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

  return (
    <aside
      aria-label="Панель фільтрів"
      className={
        fullHeight
          ? 'flex h-full min-h-0 flex-col overflow-hidden'
          : 'flex h-auto min-h-0 flex-col overflow-hidden min-[1200px]:h-full'
      }
    >
      <AnalysisFiltersPanel page={page} isCompactLayout={isCompactLayout} fullHeight={fullHeight} />
    </aside>
  );
}
