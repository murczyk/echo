import { Box, Button, CircularProgress, List, ListItem, Paper, Skeleton } from '@mui/material';
import { useEffect, useId, useState } from 'react';
import { isNullOrUndefined } from '../../../utils/misc';

import type { AnalysisCountItem } from '../types';
import { CompactText, CompactTitle } from '../../../components/CompactTypography';

type Props = {
  title: string;
  items: AnalysisCountItem[];
  loading?: boolean;
  onItemAction?: (key: string) => void;
  itemActionLabel?: string;
};

export function AnalysisCountBlock({
  title,
  items,
  loading = false,
  onItemAction,
  itemActionLabel,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const [expanded, setExpanded] = useState(false);
  const summaryItem = items.find((item) => item.key.trim().length === 0) ?? null;
  const detailItems = items.filter((item) => item.key.trim().length > 0);
  const showLoadingSkeletons =
    loading && detailItems.length === 0 && isNullOrUndefined(summaryItem);
  const hasHiddenItems = detailItems.length > 12;
  const visibleItems = expanded || !hasHiddenItems ? detailItems : detailItems.slice(0, 12);
  const hiddenItemsCount = detailItems.length - visibleItems.length;

  useEffect(() => {
    if (!hasHiddenItems && expanded) {
      setExpanded(false);
    }
  }, [expanded, hasHiddenItems]);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 2,
          mb: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <CompactTitle id={headingId} component="h2">
          {title}
        </CompactTitle>
        {loading && !showLoadingSkeletons ? (
          <CircularProgress size={16} />
        ) : summaryItem ? (
          <CompactText color="text.secondary">{`Повідомлень: ${summaryItem.count}`}</CompactText>
        ) : null}
      </Box>
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
            {summaryItem ? null : <CompactText color="text.secondary">Немає даних</CompactText>}
          </ListItem>
        ) : (
          visibleItems.map((item, index) => {
            const hasAction = onItemAction && itemActionLabel;
            return (
              <ListItem
                key={`${item.key}-${index}`}
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
    </Paper>
  );
}
