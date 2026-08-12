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
    fontSize: '0.75rem',
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
