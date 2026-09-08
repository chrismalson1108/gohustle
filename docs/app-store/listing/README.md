# Paste-ready listing copy

One plain file per App Store Connect field. Open the file, select all, paste — nothing
else can come along with it.

This exists because pasting out of `../SUBMISSION.md` means selecting inside a fenced
code block, and it is easy to catch a fence or a line of surrounding prose. App Store
Connect then rejects the field with a length error that names the limit but not the cause,
which sends you looking at copy that was never the problem.

| File | Field | Length |
|---|---|---|
| `description.txt` | Description | 2692 / 4000 |
| `promotional-text.txt` | Promotional Text | 163 / 170 |
| `keywords.txt` | Keywords | 99 / 100 |
| `review-notes.txt` | App Review Information → Notes | 2114 / 4000 |
| `subtitle.txt` | App Information → Subtitle | 28 / 30 |
| `copyright.txt` | Copyright | 13 / 200 |
| `support-url.txt` | Support URL | — |
| `marketing-url.txt` | Marketing URL | — |
| `privacy-policy-url.txt` | App Information → Privacy Policy URL | — |

`__tests__/appStoreListingLimits.test.js` holds every file to its limit, and also fails
on beta framing in the description (Guideline 2.2) and on a Stripe test card in the review
notes (Guideline 2.1). Edit the copy here, not in `SUBMISSION.md` — that document quotes
these files and explains the reasoning behind them.

## Two fields need editing before you paste

- **`review-notes.txt`** — the `DEMO PAYMENT PATH` paragraph is in square brackets.
  Replace it with what you actually seeded on the demo accounts.
- **Keywords** — if your App Store Connect field already has these, leave it alone. It is
  at 99/100 and correct.

Files carry **no trailing newline** on purpose. App Store Connect counts it, and at 99/100
one byte is the difference between accepted and rejected.
