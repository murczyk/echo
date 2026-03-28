import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import PeopleOutlineOutlinedIcon from '@mui/icons-material/PeopleOutlineOutlined';
import { Box, Button, Stack, Tooltip } from '@mui/material';

import type { AnalysisSidebarSections } from '../types';

type Props = {
  onOpenReport: () => void;
  onReset: () => void;
  onToggleRightSidebarSection: (section: keyof AnalysisSidebarSections) => void;
  rightSidebarSections: AnalysisSidebarSections;
};

type SectionButtonProps = {
  icon: JSX.Element;
  pressed: boolean;
  label: string;
  onClick: () => void;
};

function SectionButton({ icon, pressed, label, onClick }: SectionButtonProps) {
  return (
    <Tooltip title={label}>
      <Button
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        sx={{
          minWidth: 44,
          width: 44,
          height: 44,
          p: 0,
          border: '1px solid',
          color: pressed ? 'primary.main' : 'text.secondary',
          backgroundColor: pressed ? 'action.selected' : 'transparent',
          borderColor: 'divider',
          borderRadius: 0,
          '&:first-of-type': {
            borderTopLeftRadius: (theme) => `${theme.shape.borderRadius}px`,
            borderBottomLeftRadius: (theme) => `${theme.shape.borderRadius}px`,
          },
          '&:last-of-type': {
            borderTopRightRadius: (theme) => `${theme.shape.borderRadius}px`,
            borderBottomRightRadius: (theme) => `${theme.shape.borderRadius}px`,
          },
          '&:not(:first-of-type)': {
            ml: '-1px',
          },
          '&:hover': {
            backgroundColor: pressed ? 'action.selected' : 'action.hover',
            borderColor: 'divider',
          },
        }}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}

export function AnalysisToolbar({
  onOpenReport,
  onReset,
  onToggleRightSidebarSection,
  rightSidebarSections,
}: Props) {
  return (
    <Stack direction="row" spacing={1.5} flexWrap="wrap">
      <Box
        role="group"
        aria-label="Секції правої панелі аналізу"
        sx={{ display: 'inline-flex', borderRadius: (theme) => `${theme.shape.borderRadius}px` }}
      >
        <SectionButton
          icon={<BarChartOutlinedIcon sx={{ fontSize: 20 }} />}
          label="Показати або сховати зведення і графіки"
          pressed={rightSidebarSections.stats}
          onClick={() => onToggleRightSidebarSection('stats')}
        />
        <SectionButton
          icon={<PeopleOutlineOutlinedIcon sx={{ fontSize: 20 }} />}
          label="Показати або сховати блок позивних"
          pressed={rightSidebarSections.callsigns}
          onClick={() => onToggleRightSidebarSection('callsigns')}
        />
        <SectionButton
          icon={<AccountCircleOutlinedIcon sx={{ fontSize: 20 }} />}
          label="Показати або сховати нові позивні"
          pressed={rightSidebarSections.newCallsigns}
          onClick={() => onToggleRightSidebarSection('newCallsigns')}
        />
      </Box>
      <Button variant="outlined" onClick={onOpenReport} title="Відкрити конструктор звітів" sx={{ height: 44, px: 2 }}>
        Конструктор звітів
      </Button>
      <Button variant="outlined" color="inherit" onClick={onReset} title="Скинути всі фільтри" sx={{ height: 44, px: 2 }}>
        Скинути фільтри
      </Button>
    </Stack>
  );
}
