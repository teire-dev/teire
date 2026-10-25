// Tailwind CSS v4 through PostCSS, as Next.js documents it (the Turbopack loader rule this replaces
// let a restored build cache serve stale CSS).
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
