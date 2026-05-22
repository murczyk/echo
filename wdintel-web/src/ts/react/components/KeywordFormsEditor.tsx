import { Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import type { SystemCssProperties } from '@mui/system';
import type { Theme } from '@mui/material/styles';
import { useState } from 'react';

import { inflectOrganismKeywordForms } from '../services/api/organism-keyword-sets';

export type KeywordFormsEditorProps = {
  words: string[];
  onWordsChange: (words: string[]) => void;
  disabled?: boolean;
  inflectDisabled?: boolean;
  /** Cap chip list height; grows with content until this limit. */
  tagsMaxHeight?: SystemCssProperties<Theme>['maxHeight'];
};

function mergeWords(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map((w) => w.trim().toLowerCase()).filter(Boolean));
  const out = [...existing];
  for (const raw of added) {
    const w = raw.trim().toLowerCase();
    if (w === '' || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export function KeywordFormsEditor({
  words,
  onWordsChange,
  disabled = false,
  inflectDisabled = false,
  tagsMaxHeight = '65vh',
}: KeywordFormsEditorProps) {
  const [lemmaInput, setLemmaInput] = useState('');
  const [inflectLoading, setInflectLoading] = useState(false);
  const [inflectError, setInflectError] = useState<string | null>(null);

  const handleInflect = async () => {
    const lemmas = lemmaInput
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lemmas.length === 0) return;
    setInflectLoading(true);
    setInflectError(null);
    try {
      const rsp = await inflectOrganismKeywordForms({ lemmas });
      onWordsChange(mergeWords(words, rsp.words));
      setLemmaInput('');
    } catch (e) {
      setInflectError(e instanceof Error ? e.message : String(e));
    } finally {
      setInflectLoading(false);
    }
  };

  const removeWord = (word: string) => {
    onWordsChange(words.filter((w) => w !== word));
  };

  const addLemmasFromInput = () => {
    const lemmas = lemmaInput
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lemmas.length === 0) return;
    onWordsChange(mergeWords(words, lemmas));
    setLemmaInput('');
  };

  const actionButtonSx = {
    height: 40,
    minHeight: 40,
    flexShrink: 0,
    border: 'none',
    boxShadow: 'none',
    whiteSpace: 'nowrap' as const,
  };

  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="stretch"
          sx={{ minWidth: 0, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}
        >
          <TextField
            size="small"
            label="Слово"
            placeholder="птичка, летать"
            value={lemmaInput}
            onChange={(e) => setLemmaInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLemmasFromInput();
              }
            }}
            disabled={disabled || inflectLoading}
            sx={{
              flex: { xs: '1 1 100%', sm: '1 1 200px' },
              minWidth: 0,
              '& .MuiInputBase-root': { height: 40 },
            }}
          />
          <Stack direction="row" spacing={1} alignItems="stretch" sx={{ flexShrink: 0 }}>
            <Button
              size="small"
              variant="text"
              onClick={addLemmasFromInput}
              disabled={disabled || inflectLoading || lemmaInput.trim() === ''}
              sx={actionButtonSx}
            >
              Додати
            </Button>
            <Button
              size="small"
              variant="text"
              onClick={() => void handleInflect()}
              disabled={disabled || inflectDisabled || inflectLoading || lemmaInput.trim() === ''}
              sx={actionButtonSx}
            >
              Згенерувати форми
            </Button>
          </Stack>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.35, px: 0.25 }}>
          Enter — додати слово; «Згенерувати форми» — додати граматичні форми слова
        </Typography>
      </Stack>
      {inflectError ? (
        <Box component="span" sx={{ color: 'error.main', typography: 'caption' }}>
          {inflectError}
        </Box>
      ) : null}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignContent: 'flex-start',
          alignSelf: 'flex-start',
          width: '100%',
          gap: 0.75,
          maxHeight: tagsMaxHeight,
          overflowY: 'auto',
          pr: 0.5,
          py: 0.25,
        }}
      >
        {words.map((word) => (
          <Chip
            key={word}
            label={word}
            size="small"
            onDelete={disabled ? undefined : () => removeWord(word)}
          />
        ))}
      </Box>
    </Stack>
  );
}
