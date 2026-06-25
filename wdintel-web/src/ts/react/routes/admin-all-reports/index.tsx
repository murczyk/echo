import { listAllReportHistory } from '../../services/api/report-history';
import { ReportHistoryTableSection } from '../settings-neo/SettingsMyReportsSection';

export function AdminAllReportsPage() {
  return (
    <ReportHistoryTableSection
      active
      title="Всі Звіти"
      tableId="admin-all-reports-v1"
      includeAuthor
      fullHeight
      showReportCount
      loadReportHistoryBatch={listAllReportHistory}
    />
  );
}
