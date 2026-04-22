import { styled } from '@mui/material/styles';
import Typography from '@mui/material/Typography';

const CompactTextBase = styled(Typography)({
  '&&': {
    fontSize: '0.875rem',
    lineHeight: 1.35,
  },
});

const CompactTitleBase = styled(Typography)({
  '&&': {
    fontSize: '0.875rem',
    lineHeight: 1.25,
    fontWeight: 600,
  },
});

const CompactLinkTextBase = styled(Typography)({
  '&&': {
    fontSize: '0.875rem',
    lineHeight: 1.35,
    textDecoration: 'none',
    '&:hover': {
      textDecoration: 'underline',
    },
  },
});

export const CompactText = CompactTextBase as typeof Typography;
export const CompactTitle = CompactTitleBase as typeof Typography;
export const CompactLinkText = CompactLinkTextBase as typeof Typography;
