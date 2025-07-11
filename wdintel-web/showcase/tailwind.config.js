import mainConfig from '../tailwind.config.js';

/** @type {import('tailwindcss').Config} */
export default {
  ...mainConfig,
  content: [
    ...mainConfig.content,
    './src/**/*.{js,elm,ts,css,html}',
    './**/*.html',
    './elm.js',
  ],
  theme: {
    extend: {
    },
  },
  plugins: [],
}
