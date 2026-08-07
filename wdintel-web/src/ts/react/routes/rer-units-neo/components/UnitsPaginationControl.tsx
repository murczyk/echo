import ChevronLeftOutlinedIcon from '@mui/icons-material/ChevronLeftOutlined';
import ChevronRightOutlinedIcon from '@mui/icons-material/ChevronRightOutlined';
import { IconButton, Stack, Typography } from '@mui/material';

type Props = {
  pageIndex: number;
  pageSize: number;
  totalCount: number;
  loading: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
};

export function UnitsPaginationControl({
  pageIndex,
  pageSize,
  totalCount,
  loading,
  onPrevPage,
  onNextPage,
}: Props) {
  const start = totalCount === 0 ? 0 : pageIndex * pageSize + 1;
  const end = Math.min((pageIndex + 1) * pageSize, totalCount);
  const rangeText = loading
    ? '— з —'
    : totalCount === 0
      ? '0 з 0'
      : `${start}-${end} з ${totalCount}`;

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Typography variant="body2" sx={{ px: 0.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {rangeText}
      </Typography>
      <IconButton
        onClick={onPrevPage}
        disabled={loading || pageIndex === 0}
        aria-label="Попередня сторінка"
        size="small"
      >
        <ChevronLeftOutlinedIcon fontSize="small" />
      </IconButton>
      <IconButton
        onClick={onNextPage}
        disabled={loading || end >= totalCount}
        aria-label="Наступна сторінка"
        size="small"
      >
        <ChevronRightOutlinedIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
}
