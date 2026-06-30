import React from 'react';
import { Image } from 'react-native';

// Hustlr logo — the brand wordmark (or compact H monogram), from the single source
// of truth in shared/assets/brand. Mirror of web/components/Logo.tsx.
// `light` swaps to the orange variant for dark / Electric-Blue surfaces; `mark`
// renders the monogram instead of the full wordmark.
const WORDMARK = {
  blue: require('../../shared/assets/brand/wordmark-blue.png'),
  orange: require('../../shared/assets/brand/wordmark-orange.png'),
  ratio: 1584 / 749,
};
const MONOGRAM = {
  blue: require('../../shared/assets/brand/monogram-blue.png'),
  orange: require('../../shared/assets/brand/monogram-orange.png'),
  ratio: 542 / 741,
};

export default function Logo({ light = false, height = 32, mark = false, style }) {
  const asset = mark ? MONOGRAM : WORDMARK;
  return (
    <Image
      source={light ? asset.orange : asset.blue}
      style={[{ height, width: Math.round(height * asset.ratio) }, style]}
      resizeMode="contain"
    />
  );
}
