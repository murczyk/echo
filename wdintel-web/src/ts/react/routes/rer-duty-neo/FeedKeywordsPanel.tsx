import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import {
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useMemo } from 'react';
import type { OrganismKeywordSetDto, RerDutyQueryStateWf as RerDutyFeedFilterState } from '../../../../Bindings';
import { keywordSetDisplayName, resolveKeywordSetId } from '../../services/api/organism-keyword-sets';

export type FeedKeywordsPanelProps = {
  feedId: string;
  filter: RerDutyFeedFilterState;
  keywordSets: OrganismKeywordSetDto[];
  onFilterChange: (feedId: string, nextFilter: RerDutyFeedFilterState) => void;
};

export function FeedKeywordsPanel({
  feedId,
  filter,
  keywordSets,
  onFilterChange,
}: FeedKeywordsPanelProps) {
  const enabled = filter.highlightKeywordsEnabled ?? true;
  const resolvedSetId = useMemo(
    () => resolveKeywordSetId(keywordSets, filter.highlightKeywordSetId),
    [keywordSets, filter.highlightKeywordSetId],
  );
  const selectedSet = useMemo(
    () => keywordSets.find((s) => s.id === resolvedSetId) ?? null,
    [keywordSets, resolvedSetId],
  );
  const words = selectedSet?.words ?? [];
  const canEdit = selectedSet?.canEdit ?? false;
  const editHref =
    selectedSet != null ? `/settings-neo?section=keywords&setId=${selectedSet.id}` : undefined;

  const setFilter = (patch: Partial<RerDutyFeedFilterState>) => {
    onFilterChange(feedId, { ...filter, ...patch });
  };

  return (
    <Box
      sx={{
        borderTop: '1px solid rgba(148, 163, 184, 0.28)',
        bgcolor: 'background.paper',
        px: { xs: 1.5, sm: 2 },
        py: { xs: 1.25, sm: 1.5 },
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <Stack spacing={1.25} sx={{ minHeight: 0 }}>

        <FormControlLabel
          sx={{ alignItems: 'center', m: 0, gap: 1, '& .MuiTypography-root': { typography: 'body2' } }}
          control={
            <Switch
              size="small"
              checked={enabled}
              onChange={(_, checked) => setFilter({ highlightKeywordsEnabled: checked })}
            />
          }
          label="Підсвічувати ключові слова"
        />

        <Stack direction="row" spacing={1} alignItems="stretch" sx={{ minWidth: 0, flexWrap: 'nowrap' }}>
          <FormControl
            size="small"
            disabled={!enabled || keywordSets.length === 0}
            sx={{
              flex: 1,
              minWidth: 0,
              '& .MuiInputBase-root': { height: 40 },
            }}
          >
            <InputLabel id={`duty-kw-set-${feedId}`}>Набір</InputLabel>
            <Select
              labelId={`duty-kw-set-${feedId}`}
              label="Набір"
              value={resolvedSetId ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setFilter({
                  highlightKeywordSetId: v === '' ? null : Number(v),
                });
              }}
            >
              {keywordSets.map((set) => (
                <MenuItem key={set.id} value={set.id}>
                  {keywordSetDisplayName(set)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {canEdit && editHref ? (
            <Button
              size="small"
              variant="text"
              component="a"
              href={editHref}
              target="_blank"
              rel="noopener noreferrer"
              endIcon={<OpenInNewOutlinedIcon sx={{ fontSize: 16 }} />}
              sx={{
                flexShrink: 0,
                alignSelf: 'stretch',
                height: 40,
                minHeight: 40,
                whiteSpace: 'nowrap',
                px: { xs: 0.75, sm: 1 },
                border: 'none',
                boxShadow: 'none',
              }}
            >
              Редагувати набір
            </Button>
          ) : null}
        </Stack>

        {enabled && selectedSet ? (
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
              {words.length === 0
                ? 'Набір порожній — додайте слова в налаштуваннях'
                : `Слів у наборі: ${words.length}`}
            </Typography>
            {words.length > 0 ? (
              <Box
                sx={{
                  alignSelf: 'flex-start',
                  width: '100%',
                  maxHeight: '65vh',
                  overflowY: 'auto',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignContent: 'flex-start',
                  gap: 0.75,
                  pr: 0.5,
                  py: 0.25,
                }}
              >
                {words.map((word) => (
                  <Chip key={word} label={word} size="small" variant="outlined" />
                ))}
              </Box>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
}
