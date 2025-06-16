/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,elm,ts,css,html}",
    "./.elm-land/**/*.{js,elm,ts,css,html}",
  ],
  theme: {
    extend: {
      spacing: {
        '0': '0px',
        '0.5': '4px',     // half unit (4px)
        '1': '8px',       // base unit (8px)
        '1.5': '12px',    // 1.5 units (12px)
        '2': '16px',      // 2 units (16px)
        '2.5': '20px',    // 2.5 units (20px)
        '3': '24px',      // 3 units (24px)
        '3.5': '28px',    // 3.5 units (28px)
        '4': '32px',      // 4 units (32px)
        '5': '40px',      // 5 units (40px)
        '6': '48px',      // 6 units (48px)
        '7': '56px',      // 7 units (56px)
        '8': '64px',      // 8 units (64px)
        '9': '72px',      // 9 units (72px)
        '10': '80px',     // 10 units (80px)
        '11': '88px',     // 11 units (88px)
        '12': '96px',     // 12 units (96px)
        '14': '112px',    // 14 units (112px)
        '16': '128px',    // 16 units (128px)
        '20': '160px',    // 20 units (160px)
        '24': '192px',    // 24 units (192px)
        '28': '224px',    // 28 units (224px)
        '32': '256px',    // 32 units (256px)
        '36': '288px',    // 36 units (288px)
        '40': '320px',    // 40 units (320px)
        '44': '352px',    // 44 units (352px)
        '48': '384px',    // 48 units (384px)
        '52': '416px',    // 52 units (416px)
        '56': '448px',    // 56 units (448px)
        '60': '480px',    // 60 units (480px)
        '64': '512px',    // 64 units (512px)
        '72': '576px',    // 72 units (576px)
        '80': '640px',    // 80 units (640px)
        '96': '768px',    // 96 units (768px)
      },
    },
  },
  plugins: [],
  prefix: 'tw-',
}
