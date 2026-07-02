import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import MessageOutlinedIcon from '@mui/icons-material/MessageOutlined';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';

import type { AnalysisCenterTab } from './types';

export const ANALYSIS_CENTER_TAB_META: Record<
  AnalysisCenterTab,
  { icon: typeof MessageOutlinedIcon; label: string }
> = {
  messages: { icon: MessageOutlinedIcon, label: 'Повідомлення' },
  summary: { icon: TableRowsOutlinedIcon, label: 'Зведена таблиця' },
  map: { icon: MapOutlinedIcon, label: 'Мапа' },
};

export const ANALYSIS_CENTER_TAB_ICONS = {
  DescriptionOutlinedIcon,
};
