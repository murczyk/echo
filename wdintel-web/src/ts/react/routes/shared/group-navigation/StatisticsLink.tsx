import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import { hasRerOrCyber } from '../../../utils/roles';

export function StatisticsLink() {
  const roles =
    document.querySelector('.app-shell')?.getAttribute('data-auth-user-roles')?.split(',') ?? [];
  if (!hasRerOrCyber(roles)) return null;
  const active = window.location.pathname === '/message-statistics';
  return (
    <a
      className="group-navigation-statistics-link"
      href="/message-statistics"
      aria-current={active ? 'page' : undefined}
      onClick={(event) => handleNavigateWithinSpaClick(event, '/message-statistics')}
    >
      <BarChartOutlinedIcon />
      <span>Статистика</span>
    </a>
  );
}
