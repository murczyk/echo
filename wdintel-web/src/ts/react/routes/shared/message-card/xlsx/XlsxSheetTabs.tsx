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
    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', px: 2, py: 1 }}>
      {sheetNames.map((name, index) => (
        <Button
          key={name}
          size="small"
          variant={index === selectedIndex ? 'contained' : 'outlined'}
          onClick={() => onSelectIndex(index)}
          sx={{
            textTransform: 'none',
            minWidth: 0,
            px: 1,
            py: 0.25,
            fontSize: '0.75rem',
            lineHeight: 1.25,
          }}
        >
          {name}
        </Button>
      ))}
    </Box>
  );
}
