import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Collapse,
  IconButton,
  InputBase,
  List,
  ListItem,
  Paper,
  Skeleton,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useEffect, useId, useLayoutEffect, useMemo, useState } from 'react';
import { isNullOrUndefined } from '../../../utils/misc';

import type { AnalysisCountItem } from '../types';
import { CompactText, CompactTitle } from '../../../components/CompactTypography';

type Props = {
  title: string;
  items: AnalysisCountItem[];
  loading?: boolean;
  onItemAction?: (key: string) => void;
  itemActionLabel?: string;
  onItemAdd?: (key: string) => void;
  onItemToggle?: (key: string) => void;
  onClearSelection?: () => void;
  selectedItemKeys?: readonly string[];
};

export const analysisCountStatusSx = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minWidth: 104,
} as const;

export const analysisCountHeaderSx = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 2,
  flexWrap: 'wrap',
} as const;

export function AnalysisCountBlock({
  title,
  items,
  loading = false,
  onItemAction,
  itemActionLabel,
  onItemAdd,
  onItemToggle,
  onClearSelection,
  selectedItemKeys = [],
}: Props) {
  const theme = useTheme();
  const headingId = useId().replace(/:/g, '-');
  const contentId = `${headingId}-content`;
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const summaryItem = items.find((item) => item.key.trim().length === 0) ?? null;
  const detailItems = useMemo(() => items.filter((item) => item.key.trim().length > 0), [items]);
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase('uk-UA');
  const filteredDetailItems = useMemo(
    () =>
      normalizedSearchQuery.length === 0
        ? detailItems
        : detailItems.filter((item) =>
            item.key.toLocaleLowerCase('uk-UA').includes(normalizedSearchQuery),
          ),
    [detailItems, normalizedSearchQuery],
  );
  const showLoadingSkeletons =
    loading && detailItems.length === 0 && isNullOrUndefined(summaryItem);
  const hasHiddenItems = filteredDetailItems.length > 12;
  const visibleItems =
    expanded || !hasHiddenItems ? filteredDetailItems : filteredDetailItems.slice(0, 12);
  const hiddenItemsCount = filteredDetailItems.length - visibleItems.length;
  const hasSelectedItems = selectedItemKeys.length > 0 && onClearSelection != null;

  useEffect(() => {
    if (!hasHiddenItems && expanded) {
      setExpanded(false);
    }
  }, [expanded, hasHiddenItems]);

  useLayoutEffect(() => {
    const contentRoot = document.getElementById(contentId);
    const content = contentRoot?.firstElementChild;
    if (collapsed || contentRoot == null || !(content instanceof HTMLElement)) return;

    let previousHeight = content.getBoundingClientRect().height;
    const resizeObserver = new ResizeObserver(() => {
      const nextHeight = content.getBoundingClientRect().height;
      if (Math.abs(nextHeight - previousHeight) < 1) return;
      contentRoot.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], {
        duration: theme.transitions.duration.shortest,
        easing: theme.transitions.easing.easeInOut,
      });
      previousHeight = nextHeight;
    });
    resizeObserver.observe(content);
    return () => resizeObserver.disconnect();
  }, [
    collapsed,
    contentId,
    theme.transitions.duration.shortest,
    theme.transitions.easing.easeInOut,
  ]);

  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false);
      setSearchQuery('');
      return;
    }
    setCollapsed(false);
    setSearchOpen(true);
  };

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Box
        sx={{
          ...analysisCountHeaderSx,
          mb: collapsed ? 0 : 1.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <CompactTitle id={headingId} component="h2">
            {title}
          </CompactTitle>
          {hasSelectedItems ? (
            <Box
              component="span"
              sx={(theme) => ({
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 24,
                pl: 1,
                pr: 0.25,
                border: '1px solid',
                borderColor: alpha(theme.palette.primary.main, 0.45),
                borderRadius: 999,
                backgroundColor: alpha(theme.palette.primary.main, 0.08),
                color: theme.palette.primary.main,
              })}
            >
              <CompactText
                component="span"
                color="inherit"
                sx={{ fontSize: '0.75rem', fontWeight: 600, lineHeight: 1 }}
              >
                {selectedItemKeys.length}
              </CompactText>
              <IconButton
                size="small"
                aria-label={`Скинути фільтр ${title}`}
                title={`Скинути фільтр ${title}`}
                onClick={onClearSelection}
                sx={{ p: 0.25, ml: 0.25, color: 'inherit' }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ) : null}
          {detailItems.length > 0 || searchOpen ? (
            <Box
              sx={(theme) => ({
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                width: searchOpen ? { xs: 140, sm: 180 } : 32,
                height: 32,
                overflow: 'hidden',
                border: '1px solid',
                borderColor: searchOpen ? theme.palette.divider : 'transparent',
                borderRadius: 1,
                transition: theme.transitions.create(['width', 'border-color'], {
                  duration: theme.transitions.duration.short,
                }),
              })}
            >
              {searchOpen ? (
                <InputBase
                  autoFocus
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Пошук"
                  inputProps={{ 'aria-label': `Пошук у ${title}` }}
                  sx={{
                    minWidth: 0,
                    flex: 1,
                    pl: 1,
                    fontSize: '0.875rem',
                    '& input': { p: 0 },
                  }}
                />
              ) : null}
              <IconButton
                size="small"
                aria-label={searchOpen ? `Закрити пошук у ${title}` : `Пошук у ${title}`}
                aria-pressed={searchOpen}
                onClick={toggleSearch}
                color={searchOpen ? 'primary' : 'default'}
                sx={{ p: 0.5, ml: 'auto', flexShrink: 0 }}
              >
                {searchOpen ? <CloseIcon fontSize="small" /> : <SearchIcon fontSize="small" />}
              </IconButton>
            </Box>
          ) : null}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={analysisCountStatusSx}>
            {summaryItem ? (
              <CompactText color="text.secondary">{`Повідомлень: ${summaryItem.count}`}</CompactText>
            ) : null}
            {loading && !showLoadingSkeletons ? (
              <CircularProgress
                size={16}
                sx={summaryItem ? { position: 'absolute', left: -20 } : undefined}
              />
            ) : null}
          </Box>
          <IconButton
            size="small"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Розгорнути ${title}` : `Згорнути ${title}`}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
          </IconButton>
        </Box>
      </Box>
      <Collapse id={contentId} in={!collapsed} unmountOnExit>
        <List
          dense
          disablePadding
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
            columnGap: 2,
          }}
        >
          {showLoadingSkeletons ? (
            Array.from({ length: 4 }).map((_, index) => (
              <ListItem
                key={`loading-${index}`}
                disablePadding
                sx={{ py: 0.5, minWidth: 0, alignItems: 'flex-start' }}
              >
                <Box sx={{ width: '100%' }}>
                  <Skeleton variant="text" width={index % 2 === 0 ? '58%' : '72%'} height={34} />
                  <Skeleton variant="text" width={120} height={26} />
                </Box>
              </ListItem>
            ))
          ) : visibleItems.length === 0 ? (
            <ListItem disablePadding>
              {normalizedSearchQuery.length > 0 ? (
                <CompactText color="text.secondary">Нічого не знайдено</CompactText>
              ) : summaryItem ? null : (
                <CompactText color="text.secondary">Немає даних</CompactText>
              )}
            </ListItem>
          ) : (
            visibleItems.map((item, index) => {
              const itemValue = item.value ?? item.key;
              const isSelected = selectedItemKeys.includes(itemValue);
              if (onItemToggle) {
                const canAdd = Boolean(onItemAdd && selectedItemKeys.length > 0 && !isSelected);
                return (
                  <ListItem
                    key={`${itemValue}-${index}`}
                    disablePadding
                    sx={{ py: 0.25, minWidth: 0 }}
                  >
                    <Box
                      sx={{
                        width: '100%',
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'flex-start',
                        borderRadius: 1,
                        backgroundColor: (theme) =>
                          isSelected
                            ? alpha(
                                theme.palette.primary.main,
                                theme.palette.mode === 'light' ? 0.12 : 0.24,
                              )
                            : 'transparent',
                        color: (theme) =>
                          isSelected
                            ? theme.palette.mode === 'light'
                              ? theme.palette.primary.dark
                              : theme.palette.primary.light
                            : theme.palette.text.primary,
                        '&:hover': {
                          backgroundColor: (theme) =>
                            isSelected
                              ? alpha(
                                  theme.palette.primary.main,
                                  theme.palette.mode === 'light' ? 0.18 : 0.32,
                                )
                              : theme.palette.action.hover,
                        },
                        '&:hover .analysis-count-add, &:focus-within .analysis-count-add': {
                          opacity: 1,
                        },
                      }}
                    >
                      <ButtonBase
                        aria-label={
                          isSelected ? `Прибрати ${item.key} з фільтра` : `Вибрати лише ${item.key}`
                        }
                        aria-pressed={isSelected}
                        onClick={() => onItemToggle(itemValue)}
                        sx={{
                          minWidth: 0,
                          flex: canAdd ? '0 1 auto' : 1,
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) auto',
                          columnGap: 1,
                          alignItems: 'center',
                          justifyContent: 'stretch',
                          px: 1,
                          py: 0.5,
                          color: 'inherit',
                          textAlign: 'left',
                        }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <CompactText
                            component="div"
                            sx={{
                              fontWeight: 500,
                              textDecoration: 'underline',
                              textUnderlineOffset: '2px',
                            }}
                            color="inherit"
                          >
                            {item.key}
                          </CompactText>
                          <CompactText color={isSelected ? 'inherit' : 'text.secondary'}>
                            {`Повідомлень: ${item.count}`}
                          </CompactText>
                        </Box>
                        {isSelected ? (
                          <Box
                            component="span"
                            aria-hidden
                            sx={{ fontSize: 22, lineHeight: 1, alignSelf: 'center' }}
                          >
                            ×
                          </Box>
                        ) : null}
                      </ButtonBase>
                      {canAdd ? (
                        <IconButton
                          className="analysis-count-add"
                          aria-label={`Додати ${item.key} до поточного фільтра`}
                          size="small"
                          onClick={() => onItemAdd?.(itemValue)}
                          sx={{
                            opacity: 0,
                            mt: 0.25,
                            p: 0.25,
                            color: 'text.secondary',
                            transition: (theme) =>
                              theme.transitions.create('opacity', {
                                duration: theme.transitions.duration.shortest,
                              }),
                          }}
                        >
                          <Box component="span" aria-hidden sx={{ fontSize: 18, lineHeight: 1 }}>
                            +
                          </Box>
                        </IconButton>
                      ) : null}
                    </Box>
                  </ListItem>
                );
              }
              const hasAction = onItemAction && itemActionLabel;
              return (
                <ListItem
                  key={`${itemValue}-${index}`}
                  disablePadding
                  sx={{
                    py: 0.5,
                    minWidth: 0,
                    display: 'grid',
                    gridTemplateColumns: hasAction ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)',
                    columnGap: 1,
                    alignItems: 'center',
                  }}
                >
                  <Box sx={{ minWidth: 0, width: '100%' }}>
                    <CompactText component="div" sx={{ fontWeight: 500 }}>
                      {item.key}
                    </CompactText>
                    <CompactText color="text.secondary">{`Повідомлень: ${item.count}`}</CompactText>
                  </Box>
                  {hasAction ? (
                    <Button
                      size="small"
                      onClick={() => onItemAction(item.key)}
                      sx={{ minWidth: 'auto', px: 1, alignSelf: 'center', justifySelf: 'end' }}
                    >
                      {itemActionLabel}
                    </Button>
                  ) : null}
                </ListItem>
              );
            })
          )}
        </List>
        {hasHiddenItems ? (
          <Button sx={{ mt: 1.5 }} size="small" onClick={() => setExpanded((current) => !current)}>
            {expanded ? 'Згорнути' : `Показати ще (${hiddenItemsCount})`}
          </Button>
        ) : null}
      </Collapse>
    </Paper>
  );
}
