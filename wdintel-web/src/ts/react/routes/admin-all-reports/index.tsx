import { listAllReportHistory } from '../../services/api/report-history';
import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';
import { ReportHistoryTableSection } from '../settings-neo/SettingsMyReportsSection';

export function AdminAllReportsPage() {
  return (
    <ReportHistoryTableSection
      active
      title="Всі звіти"
      tableId="admin-all-reports-v2"
      includeAuthor
      fullHeight
      compactFullHeight
      loadingRowCount={FULL_HEIGHT_LOADING_ROW_COUNT}
      loadReportHistoryBatch={listAllReportHistory}
    />
  );
}
