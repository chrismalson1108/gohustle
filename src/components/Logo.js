import React from 'react';
import { Image } from 'react-native';

// Hustlr logo — from the single source of truth in shared/assets/brand, distributed
// by `npm run brand:sync`. Mirror of web/components/Logo.tsx, which renders the same
// artwork as inline SVG; mobile uses PNG because react-native-svg isn't installed.
//
// `light` swaps to the Cream colourway for dark / Blue surfaces. `mark` renders the
// H-monogram alone. `lockup` is kept for call-site clarity but is the default form.
//
// The v3 "wordmark" art IS the horizontal lockup — the H-mark and "HUSTLR" are drawn
// together in one file with the designer's spacing and their 50-weight stroke baked
// in. The old art was text-only, so this component used to compose mark + text itself
// at guideline ratios; doing that now would draw the mark TWICE and get the gap wrong.
//
// Ratios are the INTRINSIC dimensions of the source art. RE-MEASURE THEM whenever the
// art is replaced — a stale ratio silently stretches every logo in the app, which
// happened three times during the v3 rollout.
const WORDMARK = {
  blue: require('../../shared/assets/brand/wordmark-blue.png'),
  cream: require('../../shared/assets/brand/wordmark-cream.png'),
  ratio: 11818 / 2401,
};
const MONOGRAM = {
  blue: require('../../shared/assets/brand/monogram-blue.png'),
  cream: require('../../shared/assets/brand/monogram-cream.png'),
  ratio: 2934 / 1914,
};

export default function Logo({ light = false, height = 32, mark = false, lockup = false, style }) {
  void lockup; // the lockup IS the default rendering; kept so call sites read clearly
  const asset = mark ? MONOGRAM : WORDMARK;
  return (
    <Image
      source={asset[light ? 'cream' : 'blue']}
      style={[{ height, width: height * asset.ratio }, style]}
      resizeMode="contain"
    />
  );
}
