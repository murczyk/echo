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
  pageSize: number;
  messagesCount: number;
  totalCount: number | null;
  totalLoading: boolean;
  noMoreToLoad: boolean;
  busy: boolean;
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
  onFirstPage: () => void;
  onLastPage: () => void;
};

function PaginationJumpControl({
  disabled,
  firstDisabled,
  lastDisabled,
  rangeText,
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
  pageSize,
  messagesCount,
  totalCount,
  totalLoading,
  noMoreToLoad,
  busy,
  onFirstPage,
  onLastPage,
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
  const lastPageIndex = totalUnknown ? null : Math.max(0, Math.ceil(totalCount / pageSize) - 1);
  const menuDisabled = !isMessagesTab || busy;
  const firstDisabled = menuDisabled || pageIndex === 0;
  const lastDisabled =
    menuDisabled || lastPageIndex === null || totalCount === 0 || pageIndex === lastPageIndex;

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <PaginationJumpControl
        disabled={menuDisabled}
        firstDisabled={firstDisabled}
        lastDisabled={lastDisabled}
        rangeText={rangeText}
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
