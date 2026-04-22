import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import type { AnalysisPageActions, AnalysisPageState } from '../types';

export type AnalysisFiltersPanelProps = Pick<
  AnalysisPageState,
  | 'isDirty'
  | 'counts'
  | 'canResetFilters'
  | 'includeOnlyNewFreqs'
  | 'loadedSavedFilter'
  | 'options'
  | 'filtersLoading'
  | 'aorEntries'
  | 'groupInfos'
  | 'networkDisplayMap'
  | 'networks'
  | 'queryState'
  | 'saveInFlight'
  | 'savedFilterName'
  | 'savedFilters'
  | 'tagsMap'
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
  important: true,
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

export type UnitsExactMatchMode = 'default' | 'exact' | 'non-exact';

export function unitsExactMatchModeFromState(value: boolean | null): UnitsExactMatchMode {
  if (value === true) return 'exact';
  if (value === false) return 'non-exact';
  return 'default';
}

export function unitsExactMatchStateFromMode(value: UnitsExactMatchMode): boolean | null {
  if (value === 'exact') return true;
  if (value === 'non-exact') return false;
  return null;
}

export function getInitialExpandedSections(): Record<FilterSectionId, boolean> {
  return { ...defaultExpandedSections };
}

export function sectionCountLabel(selectedCount: number, overallCount: number | null | undefined): string | null {
  if (overallCount == null) {
    return selectedCount > 0 ? String(selectedCount) : null;
  }
  return selectedCount > 0 ? `${selectedCount} з ${overallCount}` : String(overallCount);
}

export function FilterSection({ sectionId, title, countLabel, expanded, onToggle, onLoad, children }: FilterSectionProps) {
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
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: (theme) => `${theme.shape.borderRadius}px`,
        overflow: 'hidden',
        backgroundColor: 'background.paper',
        '&:before': {
          display: 'none',
        },
        '& + &': {
          mt: 1,
        },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{
          minHeight: 46,
          px: 1.5,
          py: 0.25,
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
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, width: '100%', minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, minWidth: 0 }} noWrap>
            {title}
          </Typography>
          {countLabel ? <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, mr: 0.75 }}>{countLabel}</Box> : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, pb: 1.25, pt: 0 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</Box>
      </AccordionDetails>
    </Accordion>
  );
}
