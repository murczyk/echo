import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';
import { ReportHistoryTableSection } from '../settings-neo/SettingsMyReportsSection';

export function MyReportsPage() {
  return (
    <ReportHistoryTableSection
      active
      title="Мої звіти"
      tableId="my-reports-v1"
      fullHeight
      compactFullHeight
      showReportCount
      loadingRowCount={FULL_HEIGHT_LOADING_ROW_COUNT}
    />
  );
}
