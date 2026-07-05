// Instant skeleton shown while a console page's server component loads (covers
// serverless cold starts + the auth chain, so navigation feels immediate).
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6 h-8 w-48 rounded bg-[var(--line)]" />
      <div className="mb-4 h-10 w-full max-w-xl rounded bg-[var(--line)]" />
      <div className="space-y-2 rounded-xl border border-[var(--line)] bg-white p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 w-full rounded bg-[var(--surface)]" />
        ))}
      </div>
    </div>
  );
}
