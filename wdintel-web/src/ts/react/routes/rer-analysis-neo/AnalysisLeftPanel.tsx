import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  leftPanelVisible: boolean;
};

// Column separation uses a flat 1px divider instead of a boxed card. The
// grid stacks below MUI's `lg` (1200px), so the right border is gated to
// `min-[1200px]` to avoid a stray line on the mobile stacked layout.
export function AnalysisLeftPanel({ page, leftPanelVisible }: Props) {
  if (!leftPanelVisible) return null;

  return (
    <aside
      aria-label="Панель фільтрів"
      className="flex min-h-0 h-auto flex-col overflow-hidden min-[1200px]:h-full min-[1200px]:border-r min-[1200px]:border-solid min-[1200px]:border-black/12 dark:min-[1200px]:border-white/12"
    >
      <AnalysisFiltersPanel page={page} />
    </aside>
  );
}
