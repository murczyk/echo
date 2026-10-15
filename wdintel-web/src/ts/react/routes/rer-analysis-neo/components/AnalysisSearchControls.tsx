import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, IconButton, Popover, Tooltip } from '@mui/material';
import { useState } from 'react';

import type { AnalysisSearchMode } from '../../../../../Bindings';
import { ANALYSIS_SEARCH_DOC_URL } from '../config';

type Props = {
  searchMode: AnalysisSearchMode | null | undefined;
  onChange: (searchMode: AnalysisSearchMode) => void;
};

export function AnalysisSearchControls({ searchMode, onChange }: Props) {
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
      <Box
        sx={{
          '& select': {
            height: 40,
            maxWidth: 175,
            px: 1,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            color: 'text.primary',
            backgroundColor: 'background.paper',
            font: 'inherit',
            fontSize: 14,
          },
        }}
      >
        <select
          aria-label="Режим пошуку"
          value={searchMode ?? 'Fuzzy'}
          onChange={(event) => {
            const mode = event.target.value;
            onChange(mode === 'Exact' || mode === 'Substring' ? mode : 'Fuzzy');
          }}
        >
          <option value="Fuzzy">Гнучкий пошук</option>
          <option value="Exact">Точний збіг</option>
          <option value="Substring">Збіг за входженням</option>
        </select>
      </Box>
      <Tooltip title="Режими пошуку" arrow>
        <IconButton
          aria-label="Довідка про пошук"
          aria-expanded={Boolean(helpAnchor)}
          aria-controls={helpAnchor ? 'analysis-search-help' : undefined}
          size="small"
          onClick={(event) => setHelpAnchor(event.currentTarget)}
        >
          <InfoOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Popover
        id="analysis-search-help"
        open={Boolean(helpAnchor)}
        anchorEl={helpAnchor}
        onClose={() => setHelpAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ p: 2, maxWidth: 360 }}>
          <p>Усі режими не враховують регістр. Для запиту «нора»:</p>
          <ul>
            <li>Гнучкий пошук: також «норма», «нормальний».</li>
            <li>Точний збіг: лише слово «нора», також «НОРА!».</li>
            <li>Збіг за входженням: також «панорама».</li>
          </ul>
          <a href={ANALYSIS_SEARCH_DOC_URL} target="_blank" rel="noopener noreferrer">
            Докладніше про пошук
          </a>
        </Box>
      </Popover>
    </Box>
  );
}
