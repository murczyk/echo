import { alpha } from '@mui/material/styles';
import { Box, Button } from '@mui/material';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ParserFeedback, ParserFieldName } from './message-parser-ownership';
import { MESSAGE_PARSE_FEEDBACK_MS } from './useMessageParser';

type FeedbackContextValue = {
  feedback: ParserFeedback | null;
  onAccept: (field: ParserFieldName) => void;
};

const FeedbackContext = createContext<FeedbackContextValue>({
  feedback: null,
  onAccept: () => {},
});

export function MessageParserFeedbackProvider({
  feedback,
  onAccept,
  children,
}: {
  feedback: ParserFeedback | null;
  onAccept: (field: ParserFieldName) => void;
  children: ReactNode;
}) {
  const [visibleFeedback, setVisibleFeedback] = useState(feedback);

  useEffect(() => {
    setVisibleFeedback(feedback);
    if (!feedback || feedback.changedFields.length === 0) return;
    const timer = window.setTimeout(
      () =>
        setVisibleFeedback((current) =>
          current?.sequence === feedback.sequence ? { ...current, changedFields: [] } : current,
        ),
      MESSAGE_PARSE_FEEDBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [feedback?.sequence]);

  const value = useMemo(
    () => ({ feedback: visibleFeedback, onAccept }),
    [onAccept, visibleFeedback],
  );

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

export function ParserFieldFeedback({
  field,
  label,
  children,
}: {
  field: ParserFieldName;
  label: string;
  children: ReactNode;
}) {
  const { feedback, onAccept } = useContext(FeedbackContext);
  const state = feedback?.conflictFields.includes(field)
    ? 'conflict'
    : feedback?.changedFields.includes(field)
      ? 'updated'
      : 'idle';
  const removesValue = feedback?.emptyCandidateFields?.includes(field) ?? false;

  return (
    <Box
      data-testid={`parser-feedback-${field}`}
      data-state={state}
      sx={(theme) => ({
        minWidth: 0,
        borderRadius: 1,
        '& .MuiInputBase-root, & .MuiPickersOutlinedInput-root': {
          bgcolor:
            state === 'conflict'
              ? alpha(theme.palette.warning.main, 0.16)
              : state === 'updated'
                ? alpha(theme.palette.info.main, 0.14)
                : undefined,
          transition: theme.transitions.create('background-color', {
            duration: theme.transitions.duration.short,
          }),
        },
        '@media (prefers-reduced-motion: reduce)': {
          '& .MuiInputBase-root, & .MuiPickersOutlinedInput-root': { transition: 'none' },
        },
      })}
    >
      {children}
      {state === 'conflict' ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.25 }}>
          <Button
            size="small"
            color="warning"
            aria-label={
              removesValue
                ? `Прибрати ${label}: у тексті значення немає`
                : `Взяти ${label} із тексту`
            }
            onClick={() => onAccept(field)}
            sx={{ minHeight: 28, py: 0, px: 0.75, textTransform: 'none' }}
          >
            {removesValue ? 'Прибрати значення' : 'Взяти з тексту'}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
