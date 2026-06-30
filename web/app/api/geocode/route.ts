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

  let url: string;
  if (lat && lon) {
    url = `https://photon.komoot.io/reverse/?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&lang=en`;
  } else if (q && q.trim().length >= 2) {
    url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&layer=city&layer=locality&lang=en`;
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
