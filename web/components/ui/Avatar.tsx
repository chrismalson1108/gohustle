import { classNames } from "@/lib/format";
import { safeStorageUrl } from "@gohustlr/shared";

interface AvatarProps {
  name?: string | null;
  initial?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
  ring?: boolean;
}

// Circular avatar: photo when available, otherwise a flat initial bubble.
// Mirrors src/components/Avatar.js — solid primary fill at weight 700, letter
// sized at 42% of the box. The old gradient fill was a leftover from the
// gradient-hero era and read as a different visual system from the app.
export default function Avatar({ name, initial, url, size = 44, className = "", ring = false }: AvatarProps) {
  const letter = (initial || name?.trim()?.charAt(0) || "?").toUpperCase();
  // Never render a URL that is not an object in our own avatars bucket. avatar_url is
  // owner-writable free text, so a direct API write could point this at any host —
  // unmoderated (moderate-image only ever sees bucket objects) and a beacon that logs
  // every viewer's IP. The CSP in next.config.ts already blocks the FETCH on
  // gohustlr.com; this stops the broken image and matches the mobile client, where
  // there is no CSP. 20260906014100 refuses the writes; this covers older rows.
  const safe = safeStorageUrl(url, "avatars");
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  return (
    <div
      className={classNames(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold leading-none text-white",
        safe ? "bg-divider" : "bg-primary",
        ring && "ring-2 ring-white",
        className,
      )}
      style={style}
    >
      {safe ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={safe} alt={name || "avatar"} className="size-full object-cover" />
      ) : (
        letter
      )}
    </div>
  );
}
