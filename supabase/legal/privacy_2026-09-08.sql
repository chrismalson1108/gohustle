-- ─────────────────────────────────────────────────────────────────────────────
-- Privacy Policy 2026-09-08: the waitlist (2026-09-08).
--
-- The live policy (2026-08-12) describes a service you have an ACCOUNT with. Every
-- clause a waitlist signer needs is either absent or false as applied to them:
--
--   §2  enumerates account, gig and payment data. It does not mention collecting an
--       email address from somebody who is not a user.
--   §3  lists purposes that are all marketplace operation plus transactional and push
--       notification. "Email you when we launch" is a MARKETING purpose and is not
--       among them.
--   §10 keys retention to "while your account is active" — which says nothing at all
--       about a person who has no account and never will.
--   §11 gives one deletion route: "Profile > Settings > Delete account". A waitlist
--       signer cannot reach it, because reaching it requires the account they do not
--       have.
--
-- Published BEFORE the form ships, deliberately. legal_documents drives ConsentScreen,
-- so a new (slug, version) row prompts every existing user to re-accept — that is 16
-- profiles today and one interstitial per acquired user forever after. The cheapest
-- day to do this is the day before the first row exists.
--
-- The 'Last updated:' line is changed in the SAME statement. A version row whose body
-- still says August while describing September behaviour is worse than no amendment,
-- because it looks like it was reviewed.
--
-- Idempotent: re-running inserts nothing, because (slug, version) already exists.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.legal_documents (slug, version, title, body)
select 'privacy', '2026-09-08', 'Privacy Policy', $doc$Last updated: September 8, 2026

This Privacy Policy explains what information GoHustlr ("we," "us") collects, how we use and share it, and the choices and rights you have. It applies to the GoHustlr mobile app and website (the "Service"). By using the Service you agree to this Policy.

1. Who we are. GoHustlr operates a marketplace connecting Posters (who hire help) and Earners (who perform work). We are the controller of the personal information described here, except where a service provider acts as an independent controller (for example, Stripe for payments and identity — see Section 6).

2. Information we collect.
 (a) Information you provide: name, email, username, password (stored hashed by our auth provider), profile photo, bio, city, school, skills and rates; gigs, bookings, messages, reviews, and photos you upload (profile, gig, chat, and proof-of-work images); expense and cash-income records you enter in the Tax Center; and support communications.
 (b) Payment and verification information: handled directly by Stripe (card, bank/payout, and government-ID/selfie data). We receive limited results and status (for example, the last four digits of a card, verification success/failure), not full card or ID document data.
 (c) Information collected automatically: device and app information, log and usage data, push-notification tokens, and — only with your permission — your device's precise location (GPS).
 (d) Information from third parties: if you sign in with Google or Apple, we receive basic profile information (name, email) from that provider; and verification outcomes from Stripe.
 (e) Waitlist information (from people who do not have an account): if you join our launch waitlist on gohustlr.com we collect your email address, whether you told us you want to work, hire, or both, and — only if you enter a ZIP code — whether that ZIP is inside the area we are opening in. The ZIP code itself is checked in your browser and is never sent to us or stored. We also record which version of this Policy was in effect when you joined, and, for a short period, a one-way hash of the network address the form was submitted from, which we use only to stop automated abuse and delete within 48 hours. We do not collect your name, phone number, or any other detail on the waitlist.

3. How we use information. To send waitlist subscribers a small number of emails about our launch (see Section 8a); to create and operate your account; run the marketplace and match Posters and Earners; sort and map gigs by distance; process payments, payouts, tips, refunds, and fees; provide the AI assistant; send transactional and push notifications; verify student status and identity; power the Tax Center; prevent, detect, and investigate fraud, abuse, and safety issues; provide support; comply with law; and improve the Service. Where the GDPR applies, our legal bases are: performance of a contract (operating the Service), our legitimate interests (security, fraud prevention, product improvement), your consent (precise location, push notifications, waitlist emails), and legal obligation (tax and payment records).

4. The AI assistant and Anthropic. If you use the in-app AI assistant, the messages you send it — and relevant account context needed to answer — are processed by Anthropic (our model provider) to generate responses. This processing happens on our servers using Anthropic's API. We do not sell this data, and per Anthropic's API terms this content is not used to train their models. Do not share information with the assistant you would not want processed for this purpose.

5. How we share information.
 (a) Between users: we share the information needed to coordinate a Booking between its Poster and Earner (for example, names, ratings, messages, and relevant photos), and public profile fields are visible to other users.
 (b) Service providers (sub-processors) who process data on our behalf under contract: Stripe (payments, payouts, identity), Supabase (database, authentication, file storage, hosting), Expo (push-notification delivery), Anthropic (AI assistant), Resend (transactional email), and a map/geocoding provider.
 (c) Legal and safety: to comply with law, enforce our Terms, or protect the rights, property, or safety of users or the public.
 (d) Business transfer: in a merger, acquisition, or sale of assets, subject to this Policy.
 We do NOT sell your personal information and do NOT use it for cross-context behavioral advertising.

6. Payments and identity. Card, payout, and identity-verification data is collected and processed by Stripe under Stripe's own terms and privacy policy. We do not store full card numbers or government-ID images.

7. Location. With your permission we collect precise (GPS) location while you are using the app, to show and sort nearby gigs and to display them on a map. Precise location is optional; you can decline it or turn it off anytime in your device settings, and core features still work without it. Separately, an Earner working a Booking may create a temporary "share my gig" link so that someone they choose — typically a friend or family member — can see where they are working. Anyone holding that link can see the Gig's address, both parties' first names, the expected finish time, and the current status, without needing a GoHustlr account. The link expires automatically, the Earner can revoke it at any time, and it never discloses surnames, email addresses, phone numbers, profiles, or payment information. We provide this because knowing where someone is working is a meaningful safety protection for the person doing the work.

8. Push notifications. If you enable notifications, we store a device push token to deliver booking, message, and account alerts. You can disable notifications in your device settings.

8a. The launch waitlist and marketing email. If you join the waitlist we send you a confirmation email asking you to verify the address, and one email when the Service opens in your area. We do not sell, rent, or share waitlist addresses with anyone other than the email provider that delivers the message (Resend). Every email we send you includes a working unsubscribe link and our contact details, and unsubscribing takes effect immediately — it does not depend on any other system running. When you unsubscribe we erase everything on your waitlist record except the email address itself and the date you opted out; we keep that much, and only that much, so that a future send cannot reach you by accident. You can also write to us at the address in Section 16 and ask us to delete the record entirely. If you never confirm your address, we delete your waitlist record automatically after 180 days. If you later create an account and then delete it, we delete your waitlist record at the same time.

9. Analytics and cookies. We use minimal, privacy-preserving analytics to understand app performance and errors. The website uses only cookies/local storage necessary to sign you in and remember your session. We do not use third-party advertising trackers.

10. Data retention. We keep your information while your account is active. If you are on the waitlist and have no account, we keep your waitlist record until you unsubscribe, until you ask us to delete it, or — if you never confirmed your email — for 180 days, whichever comes first; an unsubscribed record is reduced to your email address and the opt-out date and kept only as a do-not-contact entry. When you delete your account, we delete your personal data and de-identify reviews you wrote about other people (so ratings history for others remains accurate). Some records must be retained by us or by our processors (notably Stripe) to meet legal, tax, accounting, and fraud-prevention obligations, for the period required by law.

11. Your choices and rights. You can edit your profile, upload or remove photos, adjust availability, and delete content you created at any time. You can permanently delete your account and personal data in the app at Profile > Settings > Delete account. If you are on the waitlist and have no account, the unsubscribe link in any email we have sent you removes you from the list, and you can email us at the address in Section 16 to have the record deleted outright — you do not need an account to make either request. Depending on where you live (including under the GDPR and the California CCPA/CPRA), you may have the right to access, correct, delete, port, or restrict processing of your personal information, to withdraw consent, and to not be discriminated against for exercising these rights. We do not sell personal information. To exercise a right, use the in-app controls or contact us; we will verify your request and respond within the time required by law.

12. Security. We protect data with access controls, database row-level security, owner-scoped file storage, and encryption in transit. No method of transmission or storage is perfectly secure; we cannot guarantee absolute security.

13. International transfers. We and our providers may process information in the United States and other countries. Where required, we rely on appropriate safeguards for cross-border transfers.

14. Children. The Service is for users 18 and older. We do not knowingly collect personal information from anyone under 18; if we learn we have, we will delete it.

15. Changes. We may update this Policy. When we make material changes we will update the version and prompt you to review it in the app. Continued use after an update means you accept the updated Policy.

16. Contact. Questions or privacy requests: mainmail@gohustlr.com$doc$
where not exists (
  select 1 from public.legal_documents where slug = 'privacy' and version = '2026-09-08'
);

-- Verify: the newest privacy row is this one, and it covers the waitlist.
do $$
declare v text; ok boolean;
begin
  select version into v from public.legal_documents
   where slug = 'privacy' order by published_at desc limit 1;
  if v <> '2026-09-08' then
    raise exception 'FIX FAILED: newest privacy version is %, expected 2026-09-08', v;
  end if;
  select body like '%8a. The launch waitlist%'
     and body like '%Last updated: September 8, 2026%'
     and body not like '%Last updated: August 12, 2026%'
    into ok
    from public.legal_documents where slug = 'privacy' and version = '2026-09-08';
  if not ok then
    raise exception 'FIX FAILED: the published body is missing the waitlist section or still carries the old date';
  end if;
  raise notice 'privacy 2026-09-08 published and current';
end $$;
