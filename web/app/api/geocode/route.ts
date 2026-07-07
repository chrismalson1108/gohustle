// Server-side proxy to the Photon geocoder (photon.komoot.io). Running the geocode
// request on the server (not the browser) keeps the external dependency off the
// client: no CORS/ad-blocker/network-policy surprises, one place to cache/rate-limit.
//   Forward search:  /api/geocode?q=austin
//   Reverse geocode: /api/geocode?lat=30.27&lon=-97.74
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  // Validate/bound input before forwarding. The host+path are hardcoded and all
  // values are encodeURIComponent'd (no SSRF/host injection), but we still reject
  // out-of-range coordinates and over-long queries so garbage isn't relayed to the
  // upstream geocoder. NOTE: this route is unauthenticated and has no rate limit —
  // add a per-IP limiter (edge middleware / Upstash) before high-traffic launch.
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
