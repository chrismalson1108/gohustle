import React, { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { getSignedUrl, objectPath } from '../lib/uploadImage';

// Renders an image stored in a PRIVATE bucket. `value` is a bare object path
// ("<uid>/<file>", new rows) or a legacy full public URL ("…/<bucket>/<uid>/<file>");
// both resolve to an object path rendered via a short-lived signed URL, which
// storage only issues to a caller the bucket's party-scoped read policy allows.
// A freshly-picked local file:// / data: URI renders directly. Shows a neutral
// placeholder until the signed URL resolves.
export default function SignedImage({ value, bucket, style }) {
  const [uri, setUri] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!value) { if (active) setUri(null); return; }
      if (value.startsWith('file:') || value.startsWith('data:') || value.startsWith('blob:')) {
        if (active) setUri(value);
        return;
      }
      const path = objectPath(value, bucket);
      const signed = path ? await getSignedUrl(bucket, path) : null;
      if (active) setUri(signed);
    })();
    return () => { active = false; };
  }, [value, bucket]);

  if (!uri) return <View style={[style, { backgroundColor: 'rgba(0,0,0,0.06)' }]} />;
  return <Image source={{ uri }} style={style} />;
}
