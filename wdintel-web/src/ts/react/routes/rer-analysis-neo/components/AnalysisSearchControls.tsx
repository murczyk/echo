import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Popover, Tooltip } from '@mui/material';
import { useState } from 'react';

import type { AnalysisSearchMode } from '../../../../../Bindings';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { ANALYSIS_SEARCH_DOC_URL } from '../config';

type Props = {
  searchMode: AnalysisSearchMode | null | undefined;
  onChange: (searchMode: AnalysisSearchMode) => void;
};

export function AnalysisSearchControls({ searchMode, onChange }: Props) {
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);

  return (
    <div className="flex shrink-0 items-center gap-echo-xs">
      <select
        className="h-echo-control-md max-w-[175px] rounded-echo-sm border border-echo-border bg-echo-surface-raised px-echo-sm font-[inherit] text-echo-base text-echo-text"
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
      <Tooltip title="Режими пошуку" arrow>
        <PowerIconButton
          aria-label="Довідка про пошук"
          aria-expanded={Boolean(helpAnchor)}
          aria-controls={helpAnchor ? 'analysis-search-help' : undefined}
          size="small"
          onClick={(event) => setHelpAnchor(event.currentTarget)}
        >
          <InfoOutlinedIcon fontSize="small" />
        </PowerIconButton>
      </Tooltip>
      <Popover
        id="analysis-search-help"
        open={Boolean(helpAnchor)}
        anchorEl={helpAnchor}
        onClose={() => setHelpAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <div className="max-w-[360px] p-echo-lg">
          <p>Усі режими не враховують регістр. Для запиту «нора»:</p>
          <ul>
            <li>Гнучкий пошук: також «норма», «нормальний».</li>
            <li>Точний збіг: лише слово «нора», також «НОРА!».</li>
            <li>Збіг за входженням: також «панорама».</li>
          </ul>
          <a href={ANALYSIS_SEARCH_DOC_URL} target="_blank" rel="noopener noreferrer">
            Докладніше про пошук
          </a>
        </div>
      </Popover>
    </div>
  );
}
