import ExpandLessOutlinedIcon from '@mui/icons-material/ExpandLessOutlined';
import ExpandMoreOutlinedIcon from '@mui/icons-material/ExpandMoreOutlined';
import FileCopyOutlinedIcon from '@mui/icons-material/FileCopyOutlined';
import { Button, Stack } from '@mui/material';
import type { MouseEvent } from 'react';

type Props = {
  reportsMenuAnchorEl: HTMLElement | null;
  canEdit: boolean;
  canExport: boolean;
  loading: boolean;
  onCreate: () => void;
  onOpenReportsMenu: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function NetworkPageHeaderActions({
  reportsMenuAnchorEl,
  canEdit,
  canExport,
  loading,
  onCreate,
  onOpenReportsMenu,
}: Props) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button variant="contained" disabled={loading || !canEdit} onClick={onCreate}>
        Створити мережу
      </Button>
      <Button
        startIcon={<FileCopyOutlinedIcon />}
        endIcon={reportsMenuAnchorEl ? <ExpandLessOutlinedIcon /> : <ExpandMoreOutlinedIcon />}
        variant="contained"
        onClick={onOpenReportsMenu}
        data-reports-menu-button="true"
        disabled={loading || !canExport}
      >
        Звіти
      </Button>
    </Stack>
  );
}
