import { classNames } from "@/lib/format";

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
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  return (
    <div
      className={classNames(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold leading-none text-white",
        url ? "bg-divider" : "bg-primary",
        ring && "ring-2 ring-white",
        className,
      )}
      style={style}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name || "avatar"} className="size-full object-cover" />
      ) : (
        letter
      )}
    </div>
  );
}
