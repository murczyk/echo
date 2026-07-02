export function getPreviewShellSx() {
  return {
    position: 'relative',
    width: '100%',
    height: 'min(72vh, 760px)',
    minHeight: { xs: 360, sm: 480 },
    overflow: 'hidden',
    border: '1px solid',
    borderColor: 'divider',
    borderRadius: 2,
    bgcolor: 'background.paper',
    '& .leaflet-container': {
      background: 'transparent',
    },
  };
}
