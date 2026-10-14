type Props = {
  name?: string;
  size?: 'small' | 'medium';
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

export function GroupAvatar({ name, size = 'medium' }: Props) {
  return (
    <span className="group-navigation-avatar" data-group-avatar data-size={size} aria-hidden="true">
      {firstVisibleGrapheme(name)}
    </span>
  );
}
