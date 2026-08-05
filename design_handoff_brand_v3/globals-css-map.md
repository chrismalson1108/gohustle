# `web/app/globals.css` — value map

Do a **value-level find/replace**. Do not rewrite the file or rename any Tailwind
`@theme` variable — only the hex values change, so class names and component code
stay valid.

| Find | Replace | Token this backs |
|---|---|---|
| `#3F25FE` | `#5038FF` | primary / brand |
| `#2B17C2` | `#2E1BC7` | primary-dark |
| `#E9E6FF` | `#EAE6FF` | primary-light / wash |
| `#5538FF` | `#6B54FF` | secondary |
| `#F21A06` | `#EA4637` | urgent |
| `#F7F3EC` | `#F7F4EC` | background / canvas |
| `#181231` | `#363636` | text-primary / ink |
| `#5B5570` | `#6B6482` | text-secondary |
| `#E8E2D5` | `#E4DFD3` | border |
| `#F0EBDF` | `#EFEBE1` | divider |
| `#FFBC45` | `#E0A44A` | accent — **deprecated**, see below |
| `#FFF1D6` | `#FDF0DA` | accent-light — **deprecated** |
| `#9A5B00` | `#8A5A12` | accent-deep — **deprecated** |

Case-insensitive; some values may appear lowercase.

## After the swap

Add these two groups alongside the existing tokens so web can follow the same
Stage 3 migration as mobile:

```css
--color-wash: #EAE6FF;
--color-wash-deep: #5038FF;
--color-warning: #E0A44A;
--color-warning-light: #FDF0DA;
--color-warning-deep: #8A5A12;
```

## Gradients

```
primary  linear-gradient(135deg, #6B54FF, #5038FF)
earn     linear-gradient(135deg, #5038FF, #2E1BC7)
gold     linear-gradient(160deg, #6B54FF, #3A24D6)
profile  linear-gradient(135deg, #6B54FF, #2E1BC7)
```

## Fonts

No change. The site's display face is unchanged by v3.0 — this rebrand is color +
logo only.

## Verify

```bash
rg -n "3F25FE|F21A06|FFBC45|F7F3EC|181231|E9E6FF|5538FF" web/
```
Should return nothing.
