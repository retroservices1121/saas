import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // The worker form is thumb-driven on cheap Android hardware. Tap targets
      // are sized against this, not against desktop defaults.
      minHeight: { tap: '3rem' },
      screens: {
        // Spec section 12: every screen is tested at 360px in Spanish.
        xs: '360px',
      },
    },
  },
  plugins: [],
} satisfies Config;
