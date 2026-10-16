import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import { useTheme } from '@mui/material/styles';

type Props = {
  kind?: 'all' | 'group';
  name?: string;
  size?: 'small' | 'context' | 'medium';
};

export function firstVisibleGrapheme(name?: string): string {
  const visibleName = name?.trim() ?? '';
  if (visibleName === '') return '—';
  if (typeof Intl.Segmenter === 'function') {
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      visibleName,
    );
    return segments[Symbol.iterator]().next().value?.segment ?? '—';
  }
  return Array.from(visibleName)[0] ?? '—';
}

export function GroupAvatar({ kind = 'group', name, size = 'medium' }: Props) {
  const theme = useTheme();
  const allGroupsStyle =
    kind === 'all'
      ? {
          backgroundColor: theme.palette.background.default,
          color: theme.palette.text.primary,
        }
      : undefined;

  return (
    <span
      className="group-navigation-avatar"
      data-group-avatar
      data-size={size}
      aria-hidden="true"
      style={allGroupsStyle}
    >
      {kind === 'all' ? (
        <GroupOutlinedIcon className="group-navigation-avatar-icon" />
      ) : (
        firstVisibleGrapheme(name)
      )}
    </span>
  );
}
