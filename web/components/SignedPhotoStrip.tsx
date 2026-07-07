"use client";

import { useEffect, useState } from "react";
import { getSignedUrl, objectPath } from "@/lib/uploadImage";

// Renders a horizontal strip of photos stored in a PRIVATE bucket. Each stored
// value is a bare object path ("<uid>/<file>", new rows) or a legacy full public
// URL ("…/<bucket>/<uid>/<file>"); both resolve to an object path and are rendered
// via short-lived signed URLs, which storage only issues to a caller the bucket's
// party-scoped read policy allows. A shimmer shows until each URL resolves.
export default function SignedPhotoStrip({
  label,
  values,
  bucket,
  thumbClass = "size-16 ring-1 ring-line",
}: {
  label?: string;
  values: string[] | null | undefined;
  bucket: string;
  thumbClass?: string;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = (values || []).join("|");

  useEffect(() => {
    let active = true;
    (async () => {
      const list = key ? key.split("|") : [];
      const entries = await Promise.all(
        list.map(async (v) => {
          const path = objectPath(v, bucket);
          const signed = path ? await getSignedUrl(bucket, path) : null;
          return signed ? ([v, signed] as const) : null;
        }),
      );
      if (active) {
        setUrls(Object.fromEntries(entries.filter(Boolean) as [string, string][]));
      }
    })();
    return () => {
      active = false;
    };
  }, [key, bucket]);

  if (!values?.length) return null;
  return (
    <div>
      {label && (
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-muted">{label}</p>
      )}
      <div className="flex gap-2 overflow-x-auto">
        {values.map((v, i) =>
          urls[v] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={urls[v]} alt="" className={`shrink-0 rounded-xl object-cover ${thumbClass}`} />
          ) : (
            <div key={i} className={`shrink-0 animate-pulse rounded-xl bg-line/40 ${thumbClass}`} />
          ),
        )}
      </div>
    </div>
  );
}
