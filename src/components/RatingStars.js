import React from 'react';
import { View, Text } from 'react-native';

export default function RatingStars({ rating, size = 13 }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text style={{ fontSize: size, color: '#FFBC45' }}>★ </Text>
      <Text style={{ fontSize: size, fontWeight: '700', color: '#181231' }}>
        {rating.toFixed(1)}
      </Text>
    </View>
  );
}
