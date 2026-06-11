import React from 'react';
import { View, Text } from 'react-native';

export default function RatingStars({ rating, size = 13 }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text style={{ fontSize: size, color: '#F59E0B' }}>★ </Text>
      <Text style={{ fontSize: size, fontWeight: '700', color: '#1E1B4B' }}>
        {rating.toFixed(1)}
      </Text>
    </View>
  );
}
