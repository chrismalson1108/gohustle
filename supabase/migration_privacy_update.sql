-- ─────────────────────────────────────────────────────────────────────────────
-- Privacy Policy v2026-06-24 (idempotent). Run in the Supabase SQL editor.
-- Publishing a new (slug='privacy', version) row makes it the current doc; the
-- consent gate then re-prompts every user to accept it (no app release needed).
-- Adds: precise/GPS location disclosure, in-app account deletion, data-retention
-- statement, and GDPR/CCPA rights — closing the audit's privacy-disclosure gap.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.legal_documents (slug, version, title, body) values
('privacy', '2026-06-24', 'Privacy Policy', $doc$Last updated: 2026-06-24

This Privacy Policy explains what we collect, how we use it, and your rights.

1. Information we collect. Account details (name, email, username, photo), profile info (bio, city, school, skills), gig and booking activity, messages, reviews, photos you upload, expense/income records you enter, device push tokens, and payment information processed by Stripe. With your permission, we also collect your device's precise location (GPS) to sort nearby gigs by distance and show them on a map. Precise location is collected only while you are using the app, is optional, and you can turn it off anytime in your device settings.

2. How we use it. To operate the marketplace, match Posters and Earners, sort and map gigs by distance, process payments and payouts, send notifications, verify identity, prevent fraud and abuse, and improve the product.

3. Sharing. We share information between the Poster and Earner of a booking as needed to coordinate work. We use service providers (Supabase for data and storage, Stripe for payments and identity verification, Expo for push notifications, and Anthropic for the in-app AI assistant) who process data on our behalf. We do not sell your personal information.

4. Payments. Card, payout, and identity-verification data is handled by Stripe under its own terms and privacy policy. We do not store full card numbers.

5. Your choices and account deletion. You can edit your profile and delete content you created at any time. You can permanently delete your account and personal data from within the app at Profile > Settings > Delete account. You can disable push notifications and location access in your device settings.

6. Data retention. We keep your information while your account is active. When you delete your account we delete your personal data and de-identify reviews you wrote about other people. Records we are legally required to retain — for example payment and tax records — are kept by our payment processor (Stripe) for the period required by law.

7. Your rights. Depending on where you live (including under the GDPR and the CCPA), you may have the right to access, correct, delete, or export your personal data, and to object to or restrict certain processing. We do not sell personal information or use it for cross-context behavioral advertising. To exercise these rights, use the in-app controls above or contact us.

8. Security. We use access controls, row-level security, and encryption in transit. No system is perfectly secure.

9. Children. GoHustlr is for users 18 and older. We do not knowingly collect personal information from anyone under 18.

10. Contact. Questions or data requests: mainmail@gohustlr.com$doc$)
on conflict (slug, version) do nothing;
