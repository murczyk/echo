// React 18 warns if the test environment does not explicitly opt into act().
// Vitest does not set this flag for us by default.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Lit dev-mode warnings are expected in tests and add noise to stderr.
// Suppress only the known "dev-mode" warning via Lit's own de-duplication set.
globalThis.litIssuedWarnings ??= new Set();
globalThis.litIssuedWarnings.add('dev-mode');
