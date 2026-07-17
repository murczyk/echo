import ChevronLeftOutlinedIcon from '@mui/icons-material/ChevronLeftOutlined';
import ChevronRightOutlinedIcon from '@mui/icons-material/ChevronRightOutlined';
import { IconButton, Stack, Typography } from '@mui/material';

import type { AnalysisCenterTab } from '../types';

type Props = {
  centerTab: AnalysisCenterTab;
  pageIndex: number;
  pageSize: number;
  messagesCount: number;
  totalCount: number | null;
  totalLoading: boolean;
  noMoreToLoad: boolean;
  busy: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
};

export function AnalysisPaginationControl({
  centerTab,
  pageIndex,
  pageSize,
  messagesCount,
  totalCount,
  totalLoading,
  noMoreToLoad,
  busy,
  onPrevPage,
  onNextPage,
}: Props) {
  const start = pageIndex * pageSize + 1;
  const end = pageIndex * pageSize + messagesCount;

  const isMessagesTab = centerTab === 'messages';
  const totalUnknown = totalLoading || totalCount === null;
  let rangeText = '';
  if (totalUnknown) {
    rangeText = `— з —`;
  } else if (messagesCount === 0) {
    rangeText = `0 з ${totalCount}`;
  } else {
    rangeText = `${start}-${end} з ${totalCount}`;
  }

  const prevDisabled = !isMessagesTab || pageIndex === 0 || busy;
  const nextDisabled =
    !isMessagesTab || noMoreToLoad || busy || (!totalUnknown && end >= totalCount);

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap', px: 0.5 }}>
        {rangeText}
      </Typography>
      <IconButton
        onClick={onPrevPage}
        disabled={prevDisabled}
        aria-label="Попередня сторінка"
        size="small"
      >
        <ChevronLeftOutlinedIcon fontSize="small" />
      </IconButton>
      <IconButton
        onClick={onNextPage}
        disabled={nextDisabled}
        aria-label="Наступна сторінка"
        size="small"
      >
        <ChevronRightOutlinedIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
}
