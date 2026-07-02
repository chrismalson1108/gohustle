-- Expanded DRAFT legal documents (v2026-07-02). Inserting a new (slug, version)
-- row makes it the current doc and re-prompts everyone for acceptance (AuthContext
-- checkNeedsAcceptance → ConsentScreen). Dollar-quoted bodies avoid escaping.
-- NOTE: these are plain-language drafts for beta, NOT attorney-reviewed final text.

insert into public.legal_documents (slug, version, title, body) values
('terms', '2026-07-02', 'Terms of Service', $doc$Last updated: July 2, 2026

Please read these Terms of Service ("Terms") carefully. By creating an account, accessing, or using the GoHustlr mobile app or website (the "Service"), you agree to these Terms. If you do not agree, do not use the Service.

1. About GoHustlr. GoHustlr operates a marketplace that connects people who want to hire help ("Posters") with people who want to perform work ("Earners"). GoHustlr provides the platform, coordination tools, and payments tooling. GoHustlr is a neutral venue: we are not a party to any agreement between a Poster and an Earner, we do not employ Earners, we are not a staffing agency or contractor, and we do not supervise, direct, or control the work performed.

2. Definitions. "Gig" is a listing posted by a Poster. "Booking" is an Earner's request to perform a Gig and the resulting engagement. "Content" is anything you submit, including gigs, messages, photos, reviews, and profile information. "We," "us," and "our" mean GoHustlr.

3. Eligibility. You must be at least 18 years old and able to form a legally binding contract. The Service is intended primarily for college students but is open to any eligible adult. You agree to provide accurate, current information and to keep it up to date. One person may not maintain multiple accounts to evade suspension or reviews.

4. Your account. You are responsible for activity under your account and for keeping your credentials secure. You may sign in with email/password or with a third-party provider (Google, Apple). Notify us promptly of any unauthorized use.

5. Our role; no background checks. GoHustlr does NOT conduct criminal background checks, reference checks, or employment-history checks on users, and does not verify the skills, qualifications, or trustworthiness of any Poster or Earner beyond the optional badges described in Section 10. You are solely responsible for evaluating anyone you deal with and for your own safety. Meet in safe, public settings where appropriate and use your own judgment.

6. Bookings, escrow, and payments. Payments on the Service are processed by our payment processor, Stripe. When a Poster accepts a Booking, the Poster's payment method is authorized and the funds are held (an escrow-style hold) — not paid out — until the work is verified. When both parties mark the work done and the Poster verifies it, the held funds are captured and released to the Earner, minus our service fee. Optional tips are charged separately to the Poster and paid to the Earner. Cash or other payments arranged off-platform are at the parties' own risk and are NOT protected, held, or refundable by GoHustlr; circumventing platform payments is prohibited (Section 11).

7. Service fee. GoHustlr charges a service fee on payments processed through the platform (currently 10% of the Gig amount). The fee and the amount you will pay or receive are disclosed before you confirm. Fees may change prospectively with notice.

8. Cancellations, disputes, and refunds. A Booking may be cancelled before the work is verified; a cancellation after an Earner has started may apply a cancellation fee that is disclosed at the time. If a Poster reports a problem with completed work, the Poster may release a reduced amount, and the remainder of the hold is returned to the Poster; a dispute record is created. Because payments run through Stripe, chargebacks and payment-network rules may also apply. GoHustlr may, but is not obligated to, mediate disputes between users.

9. Payouts. To receive funds, an Earner must set up a payout account through Stripe (Stripe Connect), which may require identity and bank information collected directly by Stripe. Payout timing is determined by Stripe. GoHustlr never holds your bank credentials.

10. Verification and badges. We offer optional verification: (a) Student verification confirms control of a school (.edu) email via a one-time code; (b) Identity verification uses Stripe Identity to check a government ID and selfie. A badge indicates only that the specific check was completed — it is NOT a guarantee of any user's identity, safety, character, or fitness for a Gig, and you should not rely on a badge as a substitute for your own judgment.

11. Acceptable use. You agree not to use the Service to: break any law or facilitate illegal activity; post or arrange work involving drugs, weapons, sexual services, gambling, or other prohibited or hazardous activities; harass, threaten, defraud, discriminate against, or endanger anyone; post false, infringing, obscene, or hateful content; circumvent platform payments or fees; scrape, reverse-engineer, overload, or interfere with the Service; impersonate others; or create listings for anything you may not lawfully offer. We use automated and manual moderation and a report/block system, and we may remove Content or suspend or terminate accounts that violate these Terms.

12. Your Content and license. You retain ownership of your Content. You grant GoHustlr a worldwide, non-exclusive, royalty-free license to host, store, reproduce, and display your Content solely to operate, provide, and improve the Service. You represent that you have the rights to the Content you submit and that it does not violate any law or third-party right.

13. Reviews and ratings. Reviews are two-sided (Posters rate Earners and Earners rate Posters). Reviews must be honest and based on a genuine transaction. Do not post reviews in exchange for compensation or to manipulate ratings.

14. AI assistant. The in-app AI assistant ("Hustlr") is an optional convenience powered by a third-party model provider (Anthropic). It can make mistakes and may produce inaccurate or incomplete information. Do not rely on it for legal, financial, tax, medical, or safety decisions. Actions the assistant takes on your behalf (for example, drafting a gig) are still subject to these Terms.

15. Third-party services. The Service relies on third parties including Stripe (payments, payouts, identity), Supabase (data and storage), Expo (push notifications), Anthropic (AI assistant), and map/geolocation providers. Your use of those features may also be governed by the third party's terms. GoHustlr is not responsible for third-party services.

16. Intellectual property. The Service, including its software, design, and trademarks (including "GoHustlr" and "Hustlr"), is owned by GoHustlr and protected by law. We grant you a limited, revocable, non-transferable license to use the Service for its intended purpose. You may not copy, modify, or create derivative works except as allowed by law.

17. Suspension and termination. You may stop using the Service and delete your account at any time (Profile > Settings > Delete account). We may suspend or terminate access, with or without notice, for violations of these Terms, suspected fraud or harm, or as required by law. Sections that by their nature should survive termination (including 5, 8, 12, 16, 18–23) survive.

18. Disclaimers. THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. GoHustlr does not warrant that Gigs, work, or users are safe, lawful, accurate, or suitable, or that the Service will be uninterrupted or error-free.

19. Limitation of liability. TO THE MAXIMUM EXTENT PERMITTED BY LAW, GoHustlr AND ITS OWNERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, DATA, OR GOODWILL, ARISING FROM OR RELATED TO THE SERVICE OR ANY INTERACTION BETWEEN USERS. OUR TOTAL LIABILITY FOR ANY CLAIM WILL NOT EXCEED THE GREATER OF (a) THE TOTAL SERVICE FEES YOU PAID US IN THE SIX MONTHS BEFORE THE CLAIM OR (b) US $100. Some jurisdictions do not allow certain limitations, so some of these may not apply to you.

20. Indemnification. You agree to indemnify and hold harmless GoHustlr and its owners from claims, losses, and expenses (including reasonable legal fees) arising from your Content, your use of the Service, your interactions or agreements with other users, the work you perform or arrange, or your violation of these Terms or any law.

21. Dispute resolution and governing law. These Terms are governed by the laws of the State in which GoHustlr is organized, without regard to conflict-of-laws rules. Before filing any claim, you agree to first try to resolve it informally by contacting us. [DRAFT PLACEHOLDER — a final version should specify the governing state, venue, and whether disputes are resolved by binding arbitration and any class-action waiver; this will be set with counsel.]

22. Changes to these Terms. We may update these Terms. When we make material changes we will update the version and prompt you to accept again in the app. Continued use after an update means you accept the updated Terms.

23. Miscellaneous. If any provision is unenforceable, the rest remains in effect. Our failure to enforce a provision is not a waiver. You may not assign these Terms; we may assign them to a successor. These Terms are the entire agreement between you and GoHustlr regarding the Service.

24. Contact. Questions about these Terms: mainmail@gohustlr.com$doc$),

('privacy', '2026-07-02', 'Privacy Policy', $doc$Last updated: July 2, 2026

This Privacy Policy explains what information GoHustlr ("we," "us") collects, how we use and share it, and the choices and rights you have. It applies to the GoHustlr mobile app and website (the "Service"). By using the Service you agree to this Policy.

1. Who we are. GoHustlr operates a marketplace connecting Posters (who hire help) and Earners (who perform work). We are the controller of the personal information described here, except where a service provider acts as an independent controller (for example, Stripe for payments and identity — see Section 6).

2. Information we collect.
 (a) Information you provide: name, email, username, password (stored hashed by our auth provider), profile photo, bio, city, school, skills and rates; gigs, bookings, messages, reviews, and photos you upload (profile, gig, chat, and proof-of-work images); expense and cash-income records you enter in the Tax Center; and support communications.
 (b) Payment and verification information: handled directly by Stripe (card, bank/payout, and government-ID/selfie data). We receive limited results and status (for example, the last four digits of a card, verification success/failure), not full card or ID document data.
 (c) Information collected automatically: device and app information, log and usage data, push-notification tokens, and — only with your permission — your device's precise location (GPS).
 (d) Information from third parties: if you sign in with Google or Apple, we receive basic profile information (name, email) from that provider; and verification outcomes from Stripe.

3. How we use information. To create and operate your account; run the marketplace and match Posters and Earners; sort and map gigs by distance; process payments, payouts, tips, refunds, and fees; provide the AI assistant; send transactional and push notifications; verify student status and identity; power the Tax Center; prevent, detect, and investigate fraud, abuse, and safety issues; provide support; comply with law; and improve the Service. Where the GDPR applies, our legal bases are: performance of a contract (operating the Service), our legitimate interests (security, fraud prevention, product improvement), your consent (precise location, push notifications), and legal obligation (tax and payment records).

4. The AI assistant and Anthropic. If you use the in-app AI assistant, the messages you send it — and relevant account context needed to answer — are processed by Anthropic (our model provider) to generate responses. This processing happens on our servers using Anthropic's API. We do not sell this data, and per Anthropic's API terms this content is not used to train their models. Do not share information with the assistant you would not want processed for this purpose.

5. How we share information.
 (a) Between users: we share the information needed to coordinate a Booking between its Poster and Earner (for example, names, ratings, messages, and relevant photos), and public profile fields are visible to other users.
 (b) Service providers (sub-processors) who process data on our behalf under contract: Stripe (payments, payouts, identity), Supabase (database, authentication, file storage, hosting), Expo (push-notification delivery), Anthropic (AI assistant), Resend (transactional email), and a map/geocoding provider.
 (c) Legal and safety: to comply with law, enforce our Terms, or protect the rights, property, or safety of users or the public.
 (d) Business transfer: in a merger, acquisition, or sale of assets, subject to this Policy.
 We do NOT sell your personal information and do NOT use it for cross-context behavioral advertising.

6. Payments and identity. Card, payout, and identity-verification data is collected and processed by Stripe under Stripe's own terms and privacy policy. We do not store full card numbers or government-ID images.

7. Location. With your permission we collect precise (GPS) location while you are using the app, to show and sort nearby gigs and to display them on a map. Precise location is optional; you can decline it or turn it off anytime in your device settings, and core features still work without it.

8. Push notifications. If you enable notifications, we store a device push token to deliver booking, message, and account alerts. You can disable notifications in your device settings.

9. Analytics and cookies. We use minimal, privacy-preserving analytics to understand app performance and errors. The website uses only cookies/local storage necessary to sign you in and remember your session. We do not use third-party advertising trackers.

10. Data retention. We keep your information while your account is active. When you delete your account, we delete your personal data and de-identify reviews you wrote about other people (so ratings history for others remains accurate). Some records must be retained by us or by our processors (notably Stripe) to meet legal, tax, accounting, and fraud-prevention obligations, for the period required by law.

11. Your choices and rights. You can edit your profile, upload or remove photos, adjust availability, and delete content you created at any time. You can permanently delete your account and personal data in the app at Profile > Settings > Delete account. Depending on where you live (including under the GDPR and the California CCPA/CPRA), you may have the right to access, correct, delete, port, or restrict processing of your personal information, to withdraw consent, and to not be discriminated against for exercising these rights. We do not sell personal information. To exercise a right, use the in-app controls or contact us; we will verify your request and respond within the time required by law.

12. Security. We protect data with access controls, database row-level security, owner-scoped file storage, and encryption in transit. No method of transmission or storage is perfectly secure; we cannot guarantee absolute security.

13. International transfers. We and our providers may process information in the United States and other countries. Where required, we rely on appropriate safeguards for cross-border transfers.

14. Children. The Service is for users 18 and older. We do not knowingly collect personal information from anyone under 18; if we learn we have, we will delete it.

15. Changes. We may update this Policy. When we make material changes we will update the version and prompt you to review it in the app. Continued use after an update means you accept the updated Policy.

16. Contact. Questions or privacy requests: mainmail@gohustlr.com$doc$),

('contractor', '2026-07-02', 'Independent Contractor Agreement', $doc$Last updated: July 2, 2026

This Independent Contractor Agreement ("Agreement") applies to Earners who accept and perform work ("Gigs") through GoHustlr. By accepting a Gig or receiving payment through the Service, you agree to this Agreement, together with the Terms of Service.

1. Independent contractor status. You are an independent contractor. Nothing in this Agreement or your use of the Service creates an employment, agency, partnership, joint-venture, or franchise relationship between you and GoHustlr. You are not entitled to any employee benefits (such as health insurance, workers' compensation, unemployment, paid leave, or retirement), and GoHustlr does not withhold income, Social Security, Medicare, or other taxes on your behalf.

2. Control over your work. You decide whether, when, where, and how to offer your services and which Gigs to accept or decline. GoHustlr does not set your schedule, direct the manner or means of your work, require exclusivity, or supervise the services you perform. Your agreement to perform a Gig is directly with the Poster.

3. Your responsibilities. You will perform work competently, professionally, safely, and in compliance with all applicable laws, licenses, and permits. You are responsible for determining whether you are legally permitted and qualified to perform a given Gig and for declining work you are not equipped to do safely and lawfully.

4. Tools and expenses. Except where a Poster expressly provides materials, you supply your own tools, equipment, transportation, and supplies, and you bear your own business expenses. The in-app Tax Center is a convenience for tracking income and potentially deductible expenses; it is not tax advice.

5. Taxes. You are solely responsible for reporting and paying all federal, state, and local taxes on income you earn, including cash payments arranged off-platform. For payments processed through Stripe, you may receive tax forms (for example, an IRS Form 1099-K) where required by law and applicable thresholds. Consult a tax professional about your obligations.

6. Payments and fees. Payments for platform Gigs are processed through Stripe and released to you after the work is verified, minus GoHustlr's service fee (disclosed before the Poster confirms). To receive funds you must set up and maintain a Stripe payout account. GoHustlr does not guarantee payment for work arranged or performed off-platform.

7. Insurance. You are responsible for carrying any insurance appropriate to the work you perform. GoHustlr does not provide insurance coverage for you.

8. No background checks; your own judgment. GoHustlr does not conduct background, reference, or qualification checks on Posters or other users. You are responsible for evaluating each Poster and Gig and for your own safety, including declining or leaving any situation that feels unsafe.

9. No guarantee of work or income. GoHustlr does not guarantee any minimum number of Gigs, bookings, hours, or income, or that any Gig will be available to you.

10. No authority to bind GoHustlr. You have no authority to act for, make commitments on behalf of, or bind GoHustlr, and you will not represent yourself as an employee or agent of GoHustlr.

11. Compliance and prohibited work. You will not use the Service to offer or perform work that is illegal, hazardous beyond what a Poster has been clearly warned of, or otherwise prohibited by the Terms of Service. You are responsible for the quality, safety, and legality of the work you perform.

12. Liability and indemnification. GoHustlr is not liable for injuries, damages, or losses arising from work you perform or arrange, or from your interactions with Posters or others. You agree to indemnify and hold GoHustlr harmless from claims and expenses arising from your work, your conduct, or your violation of this Agreement or any law, to the extent permitted by law.

13. Term and termination. This Agreement applies whenever you use the Service as an Earner and continues until you stop using the Service or your account is terminated. Provisions that by their nature should survive (including 1, 5, 7, 8, 12) survive termination.

14. Acknowledgment. By accepting, you confirm that you have read and understood this Agreement and agree to operate as an independent contractor, not an employee of GoHustlr.

Contact: mainmail@gohustlr.com$doc$)
on conflict (slug, version) do nothing;
