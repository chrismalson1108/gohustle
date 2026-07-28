import React from 'react';
import { Image, View } from 'react-native';

// Hustlr logo — from the single source of truth in shared/assets/brand, redrawn
// from the v1.0 vector pack. Mirror of web/components/brand/BrandShell.tsx.
//
// `light` swaps to the Cream colourway for dark / Blue surfaces (this replaced the
// old Orange variant, which Brand Guidelines v1.0 retired). `mark` renders the
// H-monogram alone; `lockup` renders the approved horizontal lockup.
// Ratios are the INTRINSIC dimensions of the PNGs — they must be re-measured
// whenever the art is replaced, or every logo renders stretched.
const WORDMARK = {
  blue: require('../../shared/assets/brand/wordmark-blue.png'),
  cream: require('../../shared/assets/brand/wordmark-cream.png'),
  ratio: 1560 / 379,
};
const MONOGRAM = {
  blue: require('../../shared/assets/brand/monogram-blue.png'),
  cream: require('../../shared/assets/brand/monogram-cream.png'),
  ratio: 620 / 404,
};

export default function Logo({ light = false, height = 32, mark = false, lockup = false, style }) {
  const tone = light ? 'cream' : 'blue';

  // The v3 wordmark art IS the horizontal lockup — the H-mark and "HUSTLR" are drawn
  // together in one file, with the spacing baked in by the designer. The old art was
  // text-only, so this component used to compose mark + text itself at guideline
  // ratios; doing that now would draw the mark TWICE. Render the single asset and let
  // the artwork own its own construction.
  if (lockup) {
    return (
      <Image
        source={WORDMARK[tone]}
        style={[{ height, width: height * WORDMARK.ratio }, style]}
        resizeMode="contain"
      />
    );
  }

  const asset = mark ? MONOGRAM : WORDMARK;
  return (
    <Image
      source={asset[tone]}
      style={[{ height, width: height * asset.ratio }, style]}
      resizeMode="contain"
    />
  );
}
