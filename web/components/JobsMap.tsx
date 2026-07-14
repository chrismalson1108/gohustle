"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import Link from "next/link";
import type { LatLngExpression } from "leaflet";
import { CATEGORY_COLORS } from "@gohustlr/shared";
import { payLabel } from "@/lib/format";
import { maskLocation } from "@/lib/address";
import type { Job } from "@/lib/types";

interface Props {
  jobs: Job[];
  userCoords?: { lat: number; lng: number } | null;
}

// Web map of nearby gigs (OpenStreetMap tiles — no API key). One colored pin per
// gig with coordinates; click a pin to open the gig. Replaces react-native-maps.
export default function JobsMap({ jobs, userCoords }: Props) {
  const pins = jobs.filter((j) => j.lat != null && j.lng != null);
  const center: LatLngExpression = userCoords
    ? [userCoords.lat, userCoords.lng]
    : pins[0]
      ? [pins[0].lat as number, pins[0].lng as number]
      : [39.5, -98.35];
  const zoom = userCoords ? 11 : pins[0] ? 11 : 4;

  return (
    <div className="relative h-[70vh] w-full overflow-hidden rounded-3xl ring-1 ring-line">
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
            pathOptions={{ color: "#fff", weight: 2, fillColor: CATEGORY_COLORS[j.category] || "#3F25FE", fillOpacity: 1 }}
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
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white">
          No gigs with a location to map yet.
        </div>
      )}
    </div>
  );
}
