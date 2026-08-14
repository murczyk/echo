export const ANALYSIS_TAB_FONT_SIZE = '0.875rem' as const;

export const analysisCompactTabsSx = {
  minHeight: 34,
  '& .MuiTabs-flexContainer': {
    gap: 0.5,
  },
  '& .MuiTabs-scrollButtons': {
    width: 28,
    flexShrink: 0,
  },
  '& .MuiTabs-indicator': {
    height: 2,
  },
  '& .MuiTab-root': {
    minWidth: 0,
    minHeight: 34,
    px: 0.75,
    py: 0.25,
    fontSize: ANALYSIS_TAB_FONT_SIZE,
    fontWeight: 500,
    lineHeight: 1.15,
    whiteSpace: 'nowrap',
  },
  '& .MuiTab-iconWrapper': {
    mr: 0.5,
    mb: 0,
  },
  '& .MuiTab-root svg': {
    fontSize: 18,
  },
} as const;

export const analysisNewestFirstLabelSx = {
  width: 'auto',
  height: 34,
  m: 0,
  flexShrink: 0,
  justifyContent: 'flex-end',
  whiteSpace: 'nowrap',
  '& .MuiFormControlLabel-label': {
    fontSize: ANALYSIS_TAB_FONT_SIZE,
    fontWeight: 500,
    lineHeight: 1.2,
  },
} as const;
