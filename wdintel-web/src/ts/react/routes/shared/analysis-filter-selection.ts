export function toggleExclusiveAnalysisSelection(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [value];
}

export function addAnalysisSelection(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}
