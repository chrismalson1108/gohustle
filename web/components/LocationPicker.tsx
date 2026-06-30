"use client";

import { useRef, useState } from "react";
import { MapPin, LocateFixed, Globe, X, Loader2 } from "lucide-react";
import { classNames } from "@/lib/format";

// Web mirror of the mobile LocationPicker (src/components/LocationPicker.js):
// debounced city autocomplete over the free Photon geocoder + "Remote" options +
// an optional "use my location" button. onChange(label, coords) reports both the
// human label and {lat,lng} so callers can store coordinates (gig map pins / distance).

export type Coords = { lat: number; lng: number };

const REMOTE_OPTIONS = ["Remote", "Zoom / Remote", "Work from Home"];

const US_STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO",
  Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV",
  Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC",
};

type Suggestion = { label: string; lat: number | null; lng: number | null };

type PhotonFeature = {
  properties?: { name?: string; state?: string; country?: string; countrycode?: string };
  geometry?: { coordinates?: [number, number] };
};

function labelFor(p: NonNullable<PhotonFeature["properties"]>): string {
  const { name, state, country, countrycode } = p;
  if (countrycode === "US" && state) return `${name}, ${US_STATE_ABBR[state] || state}`;
  if (state) return `${name}, ${state}`;
  return `${name}, ${country}`;
}

async function searchCities(query: string): Promise<Suggestion[]> {
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    const json = await res.json();
    return ((json.features || []) as PhotonFeature[])
      .filter((f) => f.properties?.name && (f.properties?.state || f.properties?.country))
      .map((f) => {
        const coords = f.geometry?.coordinates; // [lng, lat]
        return { label: labelFor(f.properties!), lat: coords?.[1] ?? null, lng: coords?.[0] ?? null };
      })
      .filter((v, i, a) => a.findIndex((x) => x.label === v.label) === i); // dedupe by label
  } catch {
    return [];
  }
}

export default function LocationPicker({
  value,
  onChange,
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange: (label: string, coords: Coords | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  // Fully controlled: the input shows `value` and every change flows up through
  // onChange — no internal mirror of the text, so parent-driven updates (async
  // profile load, edit prefill) stay in sync for free.
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (text: string) => {
    onChange(text, null);
    setOpen(true);
    setResults([]);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 2) return;
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      const cities = await searchCities(text);
      setResults(cities);
      setSearching(false);
    }, 350);
  };

  const select = (item: string | Suggestion) => {
    const label = typeof item === "string" ? item : item.label;
    const coords = typeof item === "object" && item.lat != null && item.lng != null ? { lat: item.lat, lng: item.lng } : null;
    onChange(label, coords);
    setOpen(false);
    setResults([]);
  };

  const useDeviceLocation = async () => {
    if (!("geolocation" in navigator)) {
      setLocError("Location isn't available in this browser. Please type your city.");
      return;
    }
    setLocating(true);
    setLocError("");
    setOpen(false);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const res = await fetch(`/api/geocode?lat=${latitude}&lon=${longitude}`);
          const json = await res.json();
          const f = (json.features || [])[0] as PhotonFeature | undefined;
          const label = f?.properties?.name ? labelFor(f.properties) : "Current location";
          onChange(label, { lat: latitude, lng: longitude });
        } catch {
          onChange("Current location", { lat: latitude, lng: longitude });
        }
        setLocating(false);
      },
      () => {
        setLocError("Location permission denied. Please type your city.");
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000 },
    );
  };

  const remoteFiltered =
    value.trim().length > 0 ? REMOTE_OPTIONS.filter((r) => r.toLowerCase().includes(value.toLowerCase())) : REMOTE_OPTIONS;
  const showDropdown = open && !disabled && (results.length > 0 || remoteFiltered.length > 0 || searching);

  return (
    <div className="relative">
      <div
        className={classNames(
          "flex items-center gap-2 rounded-2xl border border-line bg-white px-3.5 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15",
          disabled && "opacity-60",
        )}
      >
        <MapPin className="size-4 shrink-0 text-ink-muted" />
        <input
          value={value}
          disabled={disabled}
          placeholder={placeholder || 'City, State or "Remote"'}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          autoCapitalize="words"
          autoCorrect="off"
          className="h-12 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed"
        />
        {locating ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
        ) : (
          !disabled && (
            <button
              type="button"
              onClick={useDeviceLocation}
              aria-label="Use my current location"
              className="shrink-0 rounded-full p-1 text-primary transition hover:bg-primary-light/60"
            >
              <LocateFixed className="size-4" />
            </button>
          )
        )}
        {value.length > 0 && !locating && !disabled && (
          <button
            type="button"
            onClick={() => { onChange("", null); setResults([]); }}
            aria-label="Clear location"
            className="shrink-0 rounded-full p-1 text-ink-muted transition hover:bg-line/60"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {locError && <p className="mt-1.5 text-sm font-medium text-urgent">{locError}</p>}

      {showDropdown && (
        <div className="absolute inset-x-0 top-[calc(100%+0.375rem)] z-50 max-h-60 overflow-y-auto rounded-2xl bg-white py-1 shadow-[var(--shadow-pop)] ring-1 ring-line/70">
          {remoteFiltered.map((loc) => (
            <button
              key={loc}
              type="button"
              // onMouseDown (not onClick) fires before the input's onBlur closes the dropdown.
              onMouseDown={(e) => { e.preventDefault(); select(loc); }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-primary-light/40"
            >
              <Globe className="size-4 shrink-0 text-ink-muted" />
              {loc}
            </button>
          ))}
          {searching && (
            <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin text-primary" /> Searching cities…
            </div>
          )}
          {results.map((loc) => (
            <button
              key={loc.label}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); select(loc); }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-primary-light/40"
            >
              <MapPin className="size-4 shrink-0 text-ink-muted" />
              {loc.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
