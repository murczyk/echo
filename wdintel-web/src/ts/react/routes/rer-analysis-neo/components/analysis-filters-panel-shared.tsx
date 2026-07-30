import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { isNullOrUndefined } from '../../../utils/misc';

import type { AnalysisPageActions, AnalysisPageState } from '../types';

export type AnalysisFiltersPanelPage = Pick<
  AnalysisPageState,
  | 'isDirty'
  | 'counts'
  | 'canResetFilters'
  | 'includeOnlyNewFreqs'
  | 'loadedSavedFilter'
  | 'messagesOverallCount'
  | 'messagesTotalCount'
  | 'messagesTotalLoading'
  | 'options'
  | 'filtersLoading'
  | 'countsLoading'
  | 'aorEntries'
  | 'filterSectionLoadStates'
  | 'isFilterSectionLoading'
  | 'isFilterSectionEmptyLoading'
  | 'isFilterSectionStale'
  | 'groupInfos'
  | 'networkDisplayMap'
  | 'networks'
  | 'queryState'
  | 'unitsExactMatchOnlyDefault'
  | 'saveInFlight'
  | 'savedFilterName'
  | 'savedFilters'
  | 'tagsMap'
  | 'tagsOrder'
> &
  Pick<
    AnalysisPageActions,
    | 'applySavedFilter'
    | 'deleteLoadedSavedFilter'
    | 'renameExistingSavedFilter'
    | 'resetFilters'
    | 'saveAsNew'
    | 'setIncludeOnlyNewFreqs'
    | 'setSavedFilterName'
    | 'updateExisting'
    | 'updateQueryState'
    | 'loadFilterSection'
  >;

export type AnalysisFiltersPanelProps = {
  page: AnalysisFiltersPanelPage;
  isCompactLayout?: boolean;
  fullHeight?: boolean;
};

export type FilterSectionId =
  | 'important'
  | 'tags'
  | 'networks'
  | 'aors'
  | 'groups'
  | 'senders'
  | 'freqs'
  | 'callsigns'
  | 'units'
  | 'locations'
  | 'posts'
  | 'metadata';

const defaultExpandedSections: Record<FilterSectionId, boolean> = {
  important: false,
  tags: false,
  networks: false,
  aors: false,
  groups: false,
  senders: false,
  freqs: false,
  callsigns: false,
  units: false,
  locations: false,
  posts: false,
  metadata: false,
};

export const compactCheckboxLabelSx = {
  m: 0,
  minHeight: 32,
  alignItems: 'center',
  '& .MuiFormControlLabel-label': {
    lineHeight: 1.3,
  },
};

export type FilterSectionProps = {
  sectionId?: FilterSectionId;
  title: string;
  countLabel?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  onLoad?: () => void;
  children: ReactNode;
};

export function getInitialExpandedSections(): Record<FilterSectionId, boolean> {
  return { ...defaultExpandedSections };
}

export function sectionCountLabel(
  selectedCount: number,
  overallCount: number | null | undefined,
): string | null {
  if (isNullOrUndefined(overallCount)) {
    return selectedCount > 0 ? String(selectedCount) : null;
  }
  return selectedCount > 0 ? `${selectedCount} з ${overallCount}` : String(overallCount);
}

export function FilterSection({
  sectionId,
  title,
  countLabel,
  expanded,
  onToggle,
  onLoad,
  children,
}: FilterSectionProps) {
  return (
    <Accordion
      data-section-id={sectionId ?? title}
      expanded={expanded}
      onChange={(_event, nextExpanded) => {
        onToggle();
        if (nextExpanded) {
          onLoad?.();
        }
      }}
      disableGutters
      elevation={0}
      square
      sx={{
        // Divider-only: sections read as a list, separated by a single hairline
        // instead of nested boxes. No per-section border/radius/background.
        border: 'none',
        borderRadius: 0,
        backgroundColor: 'transparent',
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-of-type': {
          borderBottom: 'none',
        },
        '&:before': {
          display: 'none',
        },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{
          minHeight: 46,
          px: 0.5,
          py: 0.25,
          borderRadius: (theme) => `${theme.shape.borderRadius}px`,
          transition: (theme) => theme.transitions.create('background-color'),
          '&:hover': {
            backgroundColor: 'action.hover',
          },
          '& .MuiAccordionSummary-content': {
            my: 0.75,
          },
          '&.Mui-expanded': {
            minHeight: 46,
          },
          '&.Mui-expanded .MuiAccordionSummary-content': {
            my: 0.75,
          },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            width: '100%',
            minWidth: 0,
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 700, minWidth: 0 }} noWrap>
            {title}
          </Typography>
          {countLabel ? (
            <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, mr: 0.75 }}>
              {countLabel}
            </Box>
          ) : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0.5, pb: 1.5, pt: 0 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</Box>
      </AccordionDetails>
    </Accordion>
  );
}
