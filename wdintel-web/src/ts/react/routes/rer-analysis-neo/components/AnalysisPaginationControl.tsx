import ChevronLeftOutlinedIcon from '@mui/icons-material/ChevronLeftOutlined';
import ChevronRightOutlinedIcon from '@mui/icons-material/ChevronRightOutlined';
import FirstPageOutlinedIcon from '@mui/icons-material/FirstPageOutlined';
import LastPageOutlinedIcon from '@mui/icons-material/LastPageOutlined';
import {
  ButtonBase,
  ClickAwayListener,
  IconButton,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Stack,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import type { AnalysisCenterTab } from '../types';

type Props = {
  centerTab: AnalysisCenterTab;
  pageIndex: number;
  rangePageIndex?: number;
  pageSize: number;
  messagesCount: number;
  rangeCount?: number;
  totalCount: number | null;
  totalLoading: boolean;
  loading: boolean;
  preserveRangeWhileLoading?: boolean;
  noMoreToLoad: boolean;
  hasMoreAfterWindow?: boolean;
  rangeUsesPageSize?: boolean;
  busy: boolean;
  jumpDisabled?: boolean;
  onFirstPage: () => void;
  onLastPage: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
};

type PaginationJumpControlProps = {
  disabled: boolean;
  firstDisabled: boolean;
  lastDisabled: boolean;
  rangeText: string;
  stale: boolean;
  onFirstPage: () => void;
  onLastPage: () => void;
};

function PaginationJumpControl({
  disabled,
  firstDisabled,
  lastDisabled,
  rangeText,
  stale,
  onFirstPage,
  onLastPage,
}: PaginationJumpControlProps) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const closeMenu = () => {
    cancelClose();
    setMenuAnchorEl(null);
  };

  const openMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (disabled) return;
    cancelClose();
    setMenuAnchorEl(event.currentTarget);
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(closeMenu, 300);
  };

  const closeOnClickAway = (event: MouseEvent | TouchEvent) => {
    if (menuAnchorEl?.contains(event.target as Node)) return;
    closeMenu();
  };

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  return (
    <>
      <ButtonBase
        onClick={openMenu}
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        disabled={disabled}
        aria-label="Перейти до першої або останньої сторінки"
        aria-controls={menuAnchorEl ? 'analysis-pagination-menu' : undefined}
        aria-expanded={menuAnchorEl ? 'true' : undefined}
        aria-haspopup="menu"
        sx={{
          borderRadius: 1,
          color: stale ? 'text.disabled' : 'inherit',
          px: 0.5,
          py: 0.25,
          '&:hover, &.Mui-focusVisible': { bgcolor: 'action.hover' },
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
          {rangeText}
        </Typography>
      </ButtonBase>
      <Popper
        anchorEl={menuAnchorEl}
        open={menuAnchorEl !== null}
        placement="bottom"
        modifiers={[{ name: 'offset', options: { offset: [0, 4] } }]}
        sx={{ zIndex: (theme) => theme.zIndex.tooltip }}
      >
        <ClickAwayListener onClickAway={closeOnClickAway}>
          <Paper elevation={8} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
            <MenuList id="analysis-pagination-menu" dense>
              <MenuItem
                disabled={firstDisabled}
                onClick={() => {
                  closeMenu();
                  onFirstPage();
                }}
              >
                <FirstPageOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
                Перша сторінка
              </MenuItem>
              <MenuItem
                disabled={lastDisabled}
                onClick={() => {
                  closeMenu();
                  onLastPage();
                }}
              >
                <LastPageOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
                Остання сторінка
              </MenuItem>
            </MenuList>
          </Paper>
        </ClickAwayListener>
      </Popper>
    </>
  );
}

export function AnalysisPaginationControl({
  centerTab,
  pageIndex,
  rangePageIndex = pageIndex,
  pageSize,
  messagesCount,
  rangeCount,
  totalCount,
  totalLoading,
  loading,
  preserveRangeWhileLoading = false,
  noMoreToLoad,
  hasMoreAfterWindow = false,
  rangeUsesPageSize = false,
  busy,
  jumpDisabled = false,
  onFirstPage,
  onLastPage,
  onPrevPage,
  onNextPage,
}: Props) {
  const isMessagesTab = centerTab === 'messages';
  const totalUnknown = loading || totalLoading || totalCount === null;
  const start = rangePageIndex * pageSize + 1;
  const end =
    totalCount === null
      ? rangePageIndex * pageSize + (rangeCount ?? Math.min(messagesCount, pageSize))
      : Math.min(
          rangePageIndex * pageSize +
            (rangeCount ?? (rangeUsesPageSize ? pageSize : Math.min(messagesCount, pageSize))),
          totalCount,
        );
  let currentRangeText = '';
  if (totalUnknown) {
    currentRangeText = '— з —';
  } else if (messagesCount === 0) {
    currentRangeText = `0 з ${totalCount}`;
  } else {
    currentRangeText = `${start}-${end} з ${totalCount}`;
  }
  const [lastKnownRangeText, setLastKnownRangeText] = useState<string | null>(null);
  useEffect(() => {
    if (!totalUnknown) setLastKnownRangeText(currentRangeText);
  }, [currentRangeText, totalUnknown]);
  const showPreservedRange =
    preserveRangeWhileLoading && (loading || totalLoading) && lastKnownRangeText !== null;
  const rangeText = showPreservedRange ? lastKnownRangeText : currentRangeText;

  const lastPageIndex = totalUnknown ? null : Math.max(0, Math.ceil(totalCount / pageSize) - 1);
  const hasLoadedNextPage = rangePageIndex < pageIndex;
  const hasLogicalNextPage = rangeUsesPageSize
    ? lastPageIndex !== null
      ? rangePageIndex < lastPageIndex
      : hasLoadedNextPage || hasMoreAfterWindow || !noMoreToLoad
    : (hasLoadedNextPage || !noMoreToLoad) &&
      (lastPageIndex === null || rangePageIndex < lastPageIndex);
  const prevDisabled = !isMessagesTab || rangePageIndex === 0 || busy;
  const nextDisabled = !isMessagesTab || busy || !hasLogicalNextPage;
  const menuDisabled = !isMessagesTab || busy || jumpDisabled;
  const firstDisabled = menuDisabled || rangePageIndex === 0;
  const lastDisabled =
    menuDisabled || lastPageIndex === null || totalCount === 0 || rangePageIndex === lastPageIndex;

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <PaginationJumpControl
        disabled={menuDisabled}
        firstDisabled={firstDisabled}
        lastDisabled={lastDisabled}
        rangeText={rangeText}
        stale={showPreservedRange}
        onFirstPage={onFirstPage}
        onLastPage={onLastPage}
      />
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
