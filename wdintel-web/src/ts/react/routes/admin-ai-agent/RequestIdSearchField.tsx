import ClearIcon from '@mui/icons-material/Clear';
import { InputAdornment, TextField } from '@mui/material';
import { useEffect, useState } from 'react';

import { PowerIconButton } from '../../components/PowerIconButton';
import { extractAiAgentRequestSearchId } from './url-state';

type Props = {
  value: string | null;
  onSearch: (searchId: string | null) => void;
};

/** Server-side lookup by request or conversation ID; accepts a pasted chat URL. */
export function RequestIdSearchField({ value, onSearch }: Props) {
  const [draft, setDraft] = useState(value ?? '');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(value ?? '');
    setInvalid(false);
  }, [value]);

  function apply(text: string) {
    const searchId = text.trim() ? extractAiAgentRequestSearchId(text) : null;
    setInvalid(Boolean(text.trim()) && !searchId);
    if (text.trim() && !searchId) return;
    setDraft(searchId ?? '');
    if (searchId !== value) onSearch(searchId);
  }

  return (
    <TextField
      className="w-full min-w-56 max-w-[360px] flex-1"
      size="small"
      placeholder="ID запиту або розмови"
      value={draft}
      error={invalid}
      helperText={invalid ? 'Вставте ID запиту, розмови або посилання на чат' : undefined}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => apply(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') apply(draft);
      }}
      slotProps={{
        htmlInput: { 'aria-label': 'ID запиту або розмови' },
        input: {
          endAdornment: draft ? (
            <InputAdornment position="end">
              <PowerIconButton aria-label="Очистити ID" size="small" onClick={() => apply('')}>
                <ClearIcon fontSize="small" />
              </PowerIconButton>
            </InputAdornment>
          ) : undefined,
        },
      }}
    />
  );
}
