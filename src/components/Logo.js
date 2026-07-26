import React from 'react';
import { Image, View } from 'react-native';

// Hustlr logo — from the single source of truth in shared/assets/brand, redrawn
// from the v1.0 vector pack. Mirror of web/components/brand/BrandShell.tsx.
//
// `light` swaps to the Cream colourway for dark / Blue surfaces (this replaced the
// old Orange variant, which Brand Guidelines v1.0 retired). `mark` renders the
// H-monogram alone; `lockup` renders the approved horizontal lockup.
const WORDMARK = {
  blue: require('../../shared/assets/brand/wordmark-blue.png'),
  cream: require('../../shared/assets/brand/wordmark-cream.png'),
  ratio: 2600 / 588,
};
const MONOGRAM = {
  blue: require('../../shared/assets/brand/monogram-blue.png'),
  cream: require('../../shared/assets/brand/monogram-cream.png'),
  ratio: 1210 / 1400,
};

// Construction ratios from the guidelines: the wordmark's cap-height is 0.639x the
// mark height and the gap between them is 0.336x. Scale the lockup as one group —
// sizing the two parts independently is the fastest way to break the identity.
const CAP = 0.639;
const GAP = 0.336;

export default function Logo({ light = false, height = 32, mark = false, lockup = false, style }) {
  const tone = light ? 'cream' : 'blue';

  if (lockup) {
    const wordHeight = height * CAP;
    return (
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: height * GAP }, style]}>
        <Image
          source={MONOGRAM[tone]}
          style={{ height, width: height * MONOGRAM.ratio }}
          resizeMode="contain"
        />
        <Image
          source={WORDMARK[tone]}
          style={{ height: wordHeight, width: wordHeight * WORDMARK.ratio }}
          resizeMode="contain"
        />
      </View>
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
