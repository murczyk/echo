import React from 'react';
import { TextField } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import type { MessageFormData } from '../manage-message-drawer.schema';

type Props = {
  busy: boolean;
};

export function CommentSection({ busy }: Props) {
  const { control } = useFormContext<MessageFormData>();

  return (
    <FormSectionWrapper title="Коментар">
      <Controller
        name="comment"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            label="Коментар"
            size="small"
            fullWidth
            multiline
            minRows={2}
            disabled={busy}
          />
        )}
      />
    </FormSectionWrapper>
  );
}
