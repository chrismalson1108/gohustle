// The gig map's frame — height + radius + clipping — in ONE place.
//
// `components/JobsMap.tsx` uses it, and so does every `next/dynamic` skeleton
// that stands in for the map while its chunk loads (browse, insights). Sharing
// the string is what stops the page reflowing the moment the map arrives; it
// used to be three hand-synced copies of `h-[70vh] rounded-3xl`.
//
// It lives here rather than in JobsMap.tsx because JobsMap imports Leaflet at
// module scope, and Leaflet touches `window` on import — statically importing
// anything from that file would drag it into the server render and crash it.
// (That is exactly why the map is loaded with `ssr: false` in the first place.)
//
// clamp() rather than a bare `70vh`: a raw viewport fraction collapses to ~350px
// in a short window and swells past 1000px on a tall display. The 20rem floor
// and 47.5rem ceiling keep it legible as a map at both ends.
export const MAP_FRAME = "h-[clamp(20rem,60vh,47.5rem)] w-full overflow-hidden rounded-2xl";
