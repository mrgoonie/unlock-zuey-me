/** @type {import('tailwindcss').Config} */
// Colours are CSS variables (src/styles/global.css) so light/dark and future themes switch in one place.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        line: token('line'),
        ink: { DEFAULT: token('ink'), muted: token('ink-muted') },
        accent: { DEFAULT: token('accent'), ink: token('accent-ink') },
        calm: { DEFAULT: token('calm'), ink: token('calm-ink') },
        warn: token('warn'),
        danger: token('danger'),
      },
      fontFamily: {
        sans: ['"Be Vietnam Pro"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
      },
      borderRadius: { card: '1rem' },
      boxShadow: { card: '0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px -6px rgb(0 0 0 / 0.08)' },
    },
  },
  plugins: [],
};
