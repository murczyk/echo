import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  leftPanelVisible: boolean;
  isCompactLayout?: boolean;
};

export function AnalysisLeftPanel({ page, leftPanelVisible, isCompactLayout = false }: Props) {
  if (!leftPanelVisible) return null;

  return (
    <aside
      aria-label="Панель фільтрів"
      className="flex min-h-0 h-auto flex-col overflow-hidden min-[1200px]:h-full"
    >
      <AnalysisFiltersPanel page={page} isCompactLayout={isCompactLayout} />
    </aside>
  );
}
