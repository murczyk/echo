// Up to 999 as is, then thousands with one decimal: 1234 -> "1.2k", 12000 -> "12k".
export function formatCompactCount(value: number): string {
  if (value <= 999) return String(value);

  const thousands = value / 1000;
  const rounded = Math.round(thousands * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, '');

  return `${text}k`;
}
