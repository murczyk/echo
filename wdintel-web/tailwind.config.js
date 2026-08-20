/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,elm,ts,css,html}', './.elm-land/**/*.{js,elm,ts,css,html}'],
  // Tailwind v4 design tokens live in src/design-system/tokens.json and are
  // exposed by src/styles/_design-tokens.generated.css.
  plugins: [],
};
