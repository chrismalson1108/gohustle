// Server-side proxy to the Photon geocoder (photon.komoot.io). Running the geocode
// request on the server (not the browser) keeps the external dependency off the
// client: no CORS/ad-blocker/network-policy surprises, one place to cache/rate-limit.
//   Forward search:  /api/geocode?q=austin
//   Reverse geocode: /api/geocode?lat=30.27&lon=-97.74
export const runtime = "nodejs";

// Per-IP throttle. This route is unauthenticated by necessity (the location picker
// runs before sign-in), and it relays to photon.komoot.io — a free community
// geocoder with a usage policy. Unmetered, it is abusable as a free geocoding proxy,
// and the likely consequence is upstream banning our egress IPs, which breaks
// location search for real users.
//
// HONEST LIMITATION: this counter lives in module memory, so on serverless it is
// per-instance and resets on cold start — it bounds a single client hammering one
// warm instance, it is NOT a global quota. The durable fix is a shared store
// (Upstash) or an edge limiter, as KNOWN_RISKS.md §1.4 records. This is the
// zero-dependency floor, not the ceiling.
//
// The limit is deliberately generous: the picker debounces keystrokes, so real
// usage is a handful of requests per minute. 30/min/IP does not touch a human but
// does cap a script. Shared egress (office/campus NAT) is why it is not tighter.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(request: Request): boolean {
  // Vercel sets x-forwarded-for; first entry is the client. Unknown IPs share one
  // bucket, which is the safe direction (throttled together rather than unlimited).
  const ip =
    (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();

  // Bound memory: drop expired buckets before inserting a new one. The map only
  // ever holds IPs seen within the current window.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  const bucket = hits.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

export async function GET(request: Request) {
  // Shape matches the empty-result contract below, so all three callers
  // (LocationPicker search + reverse geocode, browse page) degrade to "no
  // suggestions" rather than throwing — none of them checks res.ok.
  if (rateLimited(request)) {
    return Response.json(
      { features: [] },
      { status: 429, headers: { "Retry-After": String(RATE_WINDOW_MS / 1000) } },
    );
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  // Validate/bound input before forwarding. The host+path are hardcoded and all
  // values are encodeURIComponent'd (no SSRF/host injection), but we still reject
  // out-of-range coordinates and over-long queries so garbage isn't relayed to the
  // upstream geocoder.
  let url: string;
  if (lat && lon) {
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN) || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
      return Response.json({ features: [] });
    }
    url = `https://photon.komoot.io/reverse/?lat=${encodeURIComponent(latN)}&lon=${encodeURIComponent(lonN)}&lang=en`;
  } else if (q && q.trim().length >= 2) {
    const term = q.trim().slice(0, 120);
    url = `https://photon.komoot.io/api/?q=${encodeURIComponent(term)}&limit=7&layer=city&layer=locality&lang=en`;
  } else {
    return Response.json({ features: [] });
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return Response.json({ features: [] });
    return Response.json(await res.json());
  } catch {
    // Network/timeout — degrade gracefully to "no suggestions" (caller still lets
    // the user type a free-form location).
    return Response.json({ features: [] });
  }
}
