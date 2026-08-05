"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Check, Loader2, Plus, Search, X } from "lucide-react";
import {
  categoriesByGroup,
  categoryLabel,
  findProhibited,
  resolveCategorySlug,
  searchCategories,
  validateCategoryLabel,
} from "@gohustlr/shared";
import { ensureCategory, fetchCategories, type Category, type CategoryIndex } from "@/lib/categories";
import { FieldError } from "@/components/ui/Field";
import { classNames } from "@/lib/format";

// Type-ahead over the whole taxonomy, with the viewer's own recent categories as
// quick chips. This is the control that keeps the vocabulary from fragmenting:
// people mint near-duplicates because retyping is easier than finding what already
// exists, so finding has to be easier than typing. Creating is still possible —
// last, and only when nothing matched.
//
// Mirrors src/components/CategoryPicker.js on mobile (same props, same behaviour).

interface Props {
  /** Selected label(s): one label, or an array when `multiple`. */
  value: string | string[];
  /**
   * The category the user just acted on, as (canonical label, slug).
   *   single   — the new selection; ("", "") when the selection is cleared.
   *   multiple — a TOGGLE: add it when absent from `value`, remove it when present.
   *              Compare with sameCategory(), never string equality.
   */
  onChange: (label: string, slug: string) => void;
  /** profiles.recent_category_slugs — the viewer's last 8, most recent first. */
  recentSlugs?: string[];
  multiple?: boolean;
  max?: number;
  allowCreate?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

interface Section {
  key: string;
  label: string | null;
  /** Index of this section's first item in the flattened keyboard order. */
  start: number;
  items: Category[];
}

export default function CategoryPicker({
  value,
  onChange,
  recentSlugs = [],
  multiple = false,
  max,
  allowCreate = true,
  disabled = false,
  placeholder,
}: Props) {
  const [index, setIndex] = useState<CategoryIndex | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const refresh = useCallback(async () => {
    setIndex(await fetchCategories());
  }, []);

  // Loaded on mount rather than on focus, so the list is ready before the field is
  // touched. fetchCategories memoizes and shares in-flight requests, so several
  // pickers on one page (and StrictMode's double mount) cost one round trip.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Deduped by resolved slug: a profile saved before the taxonomy landed can hold
  // both "Cleaning" and "cleaning" in skills, and rendering both would show two
  // tokens for one category — while removing either removes both, since the parent
  // compares with sameCategory.
  const selected = useMemo(() => {
    const raw = Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
    const seen = new Set<string>();
    return raw.filter((v) => {
      const slug = resolveCategorySlug(v, index?.aliases);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  }, [value, index]);
  const selectedSlugs = useMemo(
    () => new Set(selected.map((v) => resolveCategorySlug(v, index?.aliases))),
    [selected, index],
  );
  const atMax = multiple && !!max && selected.length >= max;

  const { sections, flat } = useMemo(() => {
    if (!index) return { sections: [] as Section[], flat: [] as Category[] };
    const q = query.trim();
    const raw: Array<{ key: string; label: string | null; items: Array<{ slug: string }> }> = q
      ? [{ key: "results", label: null, items: searchCategories(q, { extra: index.list, limit: 24 }) }]
      : categoriesByGroup(index.list).map((g: { key: string; label: string; items: Array<{ slug: string }> }) => ({
          key: g.key,
          label: g.label,
          items: g.items,
        }));

    const out: Section[] = [];
    const flatItems: Category[] = [];
    const seen = new Set<string>();
    for (const s of raw) {
      // Both shared helpers pool CATEGORY_CATALOG with whatever is passed as `extra`,
      // and our list already contains the catalog — so entries arrive twice. bySlug is
      // also the authority on what is selectable: merged and reserved rows aren't in it.
      const items: Category[] = [];
      for (const c of s.items) {
        const hit = index.bySlug[c.slug];
        if (!hit || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        items.push(hit);
      }
      if (!items.length) continue;
      out.push({ key: s.key, label: s.label, start: flatItems.length, items });
      flatItems.push(...items);
    }
    return { sections: out, flat: flatItems };
  }, [index, query]);

  const recents = useMemo(() => {
    if (!index) return [] as Category[];
    const out: Category[] = [];
    const seen = new Set<string>();
    for (const s of recentSlugs) {
      const hit = index.bySlug[resolveCategorySlug(s, index.aliases)];
      if (!hit || seen.has(hit.slug) || selectedSlugs.has(hit.slug)) continue;
      seen.add(hit.slug);
      out.push(hit);
      if (out.length === 6) break;
    }
    return out;
  }, [index, recentSlugs, selectedSlugs]);

  const typed = query.trim();
  const typedSlug = typed ? resolveCategorySlug(typed, index?.aliases) : "";
  const matchedExactly = !!typedSlug && !!index?.bySlug[typedSlug];
  const canCreate = allowCreate && !!index && typed.length > 0 && !matchedExactly && !atMax;
  const rowCount = flat.length + (canCreate ? 1 : 0);
  const showDropdown = open && !disabled;

  useEffect(() => {
    setHighlight(0);
  }, [query, index]);

  useEffect(() => {
    if (!showDropdown) return;
    // getElementById, not querySelector: useId ids contain characters that are not
    // valid in a CSS selector.
    document.getElementById(`${baseId}-opt-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [showDropdown, highlight, baseId]);

  const pick = (cat: Category) => {
    if (atMax && !selectedSlugs.has(cat.slug)) return;
    setError("");
    setQuery("");
    onChange(cat.label, cat.slug);
    if (!multiple) setOpen(false);
  };

  const remove = (label: string, slug: string) => {
    setError("");
    // Single mode has no toggle to report — an empty pair is how it says "cleared".
    if (multiple) onChange(label, slug);
    else onChange("", "");
  };

  const create = async () => {
    if (creating) return;
    const message = validateCategoryLabel(typed, findProhibited);
    if (message) {
      setError(message);
      return;
    }
    setCreating(true);
    try {
      const cat = await ensureCategory(typed);
      setQuery("");
      setError("");
      onChange(cat.label, cat.slug);
      if (!multiple) setOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that category.");
    } finally {
      setCreating(false);
    }
  };

  const activate = (i: number) => {
    if (i < flat.length) pick(flat[i]);
    else if (canCreate) void create();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!showDropdown) {
        setOpen(true);
        return;
      }
      if (rowCount === 0) return;
      setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + rowCount) % rowCount);
      return;
    }
    if (e.key === "Enter") {
      if (!showDropdown || rowCount === 0) return;
      e.preventDefault();
      activate(highlight);
      return;
    }
    if (e.key === "Escape") {
      if (!showDropdown) return;
      // Modal listens for Escape on `document`; stop the native event here so
      // dismissing this dropdown doesn't also close the sheet around it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "Backspace" && !query && selected.length > 0) {
      const last = selected[selected.length - 1];
      remove(categoryLabel(last, index?.list), resolveCategorySlug(last, index?.aliases));
    }
  };

  return (
    <div className="relative">
      {recents.length > 0 && !disabled && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink-muted">Recent</span>
          {recents.map((c) => (
            <button
              key={c.slug}
              type="button"
              onClick={() => pick(c)}
              className="inline-flex min-h-11 max-w-full items-center rounded-full border border-line bg-white px-3.5 text-[13px] font-semibold text-ink-soft transition hover:border-primary"
            >
              <span className="min-w-0 truncate">{c.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Same box as ui/Field's Input — rounded-xl (the 14px control step), border-line,
          focus ring on the wrapper. Selections live inside it as tokens, so the control
          wraps to as many rows as `multiple` needs instead of growing a second list. */}
      <div
        className={classNames(
          "flex min-h-12 flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-3.5 py-2 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15",
          disabled && "opacity-60",
        )}
      >
        <Search className="size-4 shrink-0 text-ink-muted" />
        {selected.map((v) => {
          const label = categoryLabel(v, index?.list);
          return (
            <span
              key={v}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-ink py-1.5 pl-3 pr-2 text-[13px] font-semibold text-white"
            >
              <span className="min-w-0 truncate">{label}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(label, resolveCategorySlug(v, index?.aliases))}
                  aria-label={`Remove ${label}`}
                  // The glyph stays small; the invisible `after` box is what the finger
                  // hits, so the token doesn't have to be 44px tall to be tappable.
                  className="relative shrink-0 rounded-full p-0.5 transition after:absolute after:-inset-3 hover:opacity-70"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </span>
          );
        })}
        {/* min-w-0 on the flex child: without it a long query pushes the clear button
            out of the box (a flex item's min-width defaults to auto). */}
        <input
          value={query}
          disabled={disabled}
          placeholder={selected.length > 0 && !multiple ? "" : placeholder || "Search categories…"}
          onChange={(e) => {
            setQuery(e.target.value);
            setError("");
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showDropdown && rowCount > 0 ? `${baseId}-opt-${highlight}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          className="min-w-[7rem] flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed sm:text-[15px]"
        />
        {query.length > 0 && !disabled && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setError("");
            }}
            aria-label="Clear search"
            className="relative shrink-0 rounded-full p-1.5 text-ink-muted transition after:absolute after:-inset-2.5 hover:bg-line/60"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <FieldError>{error}</FieldError>
      {atMax && !error && (
        <p className="mt-1.5 text-sm text-ink-muted">
          That&apos;s {max} — remove one to add another.
        </p>
      )}

      {showDropdown && (
        // One elevation mechanism: the shadow carries the float, so no ring on top of it.
        <div
          id={listId}
          role="listbox"
          aria-label="Categories"
          className="absolute inset-x-0 top-[calc(100%+0.375rem)] z-50 max-h-72 overflow-y-auto rounded-2xl bg-white py-1 shadow-[var(--shadow-pop)]"
        >
          {!index && (
            <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin text-primary" /> Loading categories…
            </div>
          )}

          {sections.map((s) => (
            <div key={s.key} role="group" aria-label={s.label || "Results"}>
              {s.label && <p className="px-4 pb-1 pt-2 text-[13px] font-semibold text-ink-muted">{s.label}</p>}
              {s.items.map((cat, j) => {
                const i = s.start + j;
                const picked = selectedSlugs.has(cat.slug);
                const blocked = atMax && !picked;
                return (
                  <button
                    key={cat.slug}
                    id={`${baseId}-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={picked}
                    aria-disabled={blocked || undefined}
                    // onMouseDown (not onClick) fires before the input's onBlur closes this.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(cat);
                    }}
                    onMouseMove={() => setHighlight(i)}
                    className={classNames(
                      "flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left text-[15px] text-ink transition",
                      i === highlight && "bg-primary-light/40",
                      blocked && "opacity-45",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{cat.label}</span>
                    {picked ? (
                      <Check className="size-4 shrink-0 text-primary" />
                    ) : (
                      typed.length > 0 && <span className="shrink-0 text-xs text-ink-muted">{cat.groupLabel}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {index && flat.length === 0 && !canCreate && (
            <p className="px-4 py-2.5 text-sm text-ink-muted">
              {atMax ? `You've picked ${max}.` : "No categories match."}
            </p>
          )}

          {canCreate && (
            <button
              id={`${baseId}-opt-${flat.length}`}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                void create();
              }}
              onMouseMove={() => setHighlight(flat.length)}
              className={classNames(
                "flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left text-[15px] text-ink transition",
                highlight === flat.length && "bg-primary-light/40",
              )}
            >
              {creating ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
              ) : (
                <Plus className="size-4 shrink-0 text-primary" />
              )}
              <span className="min-w-0 truncate">
                Create <span className="font-semibold">“{typed}”</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
