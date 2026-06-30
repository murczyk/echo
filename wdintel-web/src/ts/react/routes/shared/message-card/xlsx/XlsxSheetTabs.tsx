import { Box, Button } from '@mui/material';

export function XlsxSheetTabs({
  sheetNames,
  selectedIndex,
  onSelectIndex,
}: {
  sheetNames: string[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', px: 2, py: 1, borderBottom: '1px solid rgba(244, 247, 251, 0.08)' }}>
      {sheetNames.map((name, index) => (
        <Button
          key={name}
          size="small"
          variant={index === selectedIndex ? 'contained' : 'outlined'}
          onClick={() => onSelectIndex(index)}
          sx={{ textTransform: 'none' }}
        >
          {name}
        </Button>
      ))}
    </Box>
  );
}

