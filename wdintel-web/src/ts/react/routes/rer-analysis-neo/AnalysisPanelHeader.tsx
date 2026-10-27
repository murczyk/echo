import CloseIcon from '@mui/icons-material/Close';
import { Box, IconButton, Typography } from '@mui/material';

type Props = {
  title: string;
  subtitle?: string;
  closeLabel: string;
  onClose: () => void;
};

export function AnalysisPanelHeader({ title, subtitle, closeLabel, onClose }: Props) {
  return (
    <Box
      sx={{
        minHeight: subtitle ? 64 : 56,
        px: 1.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        flexShrink: 0,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6" component="h2" sx={{ fontWeight: 600, lineHeight: 1.25 }}>
          {title}
        </Typography>
        {subtitle ? (
          <Typography
            variant="caption"
            color="text.secondary"
            title={subtitle}
            sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {subtitle}
          </Typography>
        ) : null}
      </Box>
      <IconButton aria-label={closeLabel} onClick={onClose}>
        <CloseIcon />
      </IconButton>
    </Box>
  );
}
