"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import Link from "next/link";
import type { LatLngExpression } from "leaflet";
import { categoryColor } from "@gohustlr/shared";
import { payLabel, classNames } from "@/lib/format";
import { maskLocation } from "@/lib/address";
import { MAP_FRAME } from "@/lib/mapFrame";
import type { Job } from "@/lib/types";

interface Props {
  jobs: Job[];
  userCoords?: { lat: number; lng: number } | null;
  /** Extra frame classes (e.g. a shorter height). Callers that override the
      height must pass the same class to their skeleton. */
  className?: string;
}

// Web map of nearby gigs (OpenStreetMap tiles — no API key). One colored pin per
// gig with coordinates; click a pin to open the gig. Replaces react-native-maps.
//
// Pin color comes from categoryColor(): pins are grouped by category GROUP, so
// related gigs read as related. The old CATEGORY_COLORS lookup only held the
// legacy seven labels and fell through to brand purple, which meant every gig
// outside them — i.e. most of the catalog — was the same indistinguishable dot.
export default function JobsMap({ jobs, userCoords, className = "" }: Props) {
  const pins = jobs.filter((j) => j.lat != null && j.lng != null);
  const center: LatLngExpression = userCoords
    ? [userCoords.lat, userCoords.lng]
    : pins[0]
      ? [pins[0].lat as number, pins[0].lng as number]
      : [39.5, -98.35];
  const zoom = userCoords ? 11 : pins[0] ? 11 : 4;

  return (
    // rounded-2xl (20px) is the card/panel radius — 28px is reserved for sheets
    // and modals. No ring: the map is its own surface, it doesn't need a hairline.
    <div className={classNames("relative", MAP_FRAME, className)}>
      <MapContainer center={center} zoom={zoom} scrollWheelZoom className="size-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {pins.map((j) => (
          <CircleMarker
            key={j.id}
            center={[j.lat as number, j.lng as number]}
            radius={9}
            pathOptions={{ color: "#fff", weight: 2, fillColor: categoryColor(j.categorySlug), fillOpacity: 1 }}
          >
            <Popup>
              <Link href={`/jobs/${j.id}`} className="font-bold text-primary">
                {j.title}
              </Link>
              <div className="text-xs text-ink-soft">
                {payLabel(j)} · {maskLocation(j.location)}
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      {pins.length === 0 && (
        // z-[500] clears Leaflet's own panes (z-index 400), which otherwise paint
        // over a plain sibling and hide this notice.
        <div className="pointer-events-none absolute inset-x-4 top-3 z-[500] mx-auto w-fit max-w-full truncate rounded-lg bg-black/60 px-3 py-1.5 text-center text-xs text-white">
          No gigs with a location to map yet.
        </div>
      )}
    </div>
  );
}
