// The three class strings the marketing page is built out of.
//
// They used to be module-private consts inside web/app/page.tsx, which was fine while
// that file was the only thing rendering them. The waitlist form is a client island in
// its own file and cannot import a private const, and retyping the literals is exactly
// how a fourth copy of a design token drifts — the failure `shared/theme.js` exists to
// prevent on the app side.
//
// `display` — Akshar, the display face. The `!` is LOAD-BEARING: globals.css declares
// `h1, h2 { font-family: Sora }` as an UNLAYERED rule, which outranks Tailwind's
// layered utilities, so a heading styled without the bang silently renders in Sora —
// a visibly different typeface, with no error. (The globals rule covers h1 and h2
// only, so an h3 escapes it.)
export const display = "font-[family-name:var(--font-akshar)]!";

// `overline` — JetBrains Mono for eyebrows. Sentence case at near-normal tracking;
// the uppercase 0.2em micro-label treatment was stripped from the product.
export const overline = "font-[family-name:var(--font-mono-brand)]! tracking-[0.02em]";

// `gutter` — the section gutter. The mock is a fixed 1520px canvas at 56px; this steps
// it down so the page is usable on a phone.
export const gutter = "px-5 sm:px-8 lg:px-14";

// Both font variables are loaded by page.tsx and applied on ITS root div — they are not
// global (only Sora and Inter are, from app/layout.tsx). Anything using `display` or
// `overline` must therefore render inside that div; in a portal or a modal mounted at
// <body> level, `var(--font-akshar)` is undefined and the type falls back silently.
