const BASE_COLORS = [
  '#d59a57',
  '#60b8ea',
  '#66c87e',
  '#b073d9',
  '#f08a73',
  '#efd16d',
  '#5fd0c8',
  '#f29cc1',
];

function buildGeneratedColor(index: number, usedColors: Set<string>): string {
  let attempt = index;
  while (attempt < index + 720) {
    const hue = Math.round((attempt * 137.508) % 360);
    const saturation = 68 + (attempt % 3) * 4;
    const lightness = 58 + (attempt % 2) * 4;
    const color = `hsl(${hue} ${saturation}% ${lightness}%)`;
    if (!usedColors.has(color)) return color;
    attempt += 1;
  }

  return `hsl(${(index * 37) % 360} 68% 60%)`;
}

export function buildDistinctColorPalette(count: number): string[] {
  const safeCount = Math.max(0, Math.floor(count));
  const colors: string[] = [];
  const usedColors = new Set<string>();

  for (let index = 0; index < safeCount; index += 1) {
    const baseColor = BASE_COLORS[index];
    const color = baseColor ?? buildGeneratedColor(index - BASE_COLORS.length, usedColors);
    colors.push(color);
    usedColors.add(color);
  }

  return colors;
}
