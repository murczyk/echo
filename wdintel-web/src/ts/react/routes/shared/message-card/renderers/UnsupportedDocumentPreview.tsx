import { Box, Typography } from '@mui/material';

export function UnsupportedDocumentPreview({ fileName }: { fileName: string }) {
  return (
    <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Перегляд недоступний
      </Typography>
      <Typography variant="body2">{fileName}</Typography>
    </Box>
  );
}
