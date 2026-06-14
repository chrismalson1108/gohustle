-- DB-driven legal documents + append-only acceptance audit log.
-- Update terms by inserting a new (slug, version) row — the app then re-prompts
-- everyone whose latest acceptance is for an older version. Idempotent.

create table if not exists public.legal_documents (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null,
  version      text not null,
  title        text not null,
  body         text not null,
  published_at timestamptz not null default now(),
  unique (slug, version)
);
alter table public.legal_documents enable row level security;
drop policy if exists "legal_docs_public_read" on public.legal_documents;
create policy "legal_docs_public_read" on public.legal_documents for select using (true);

create table if not exists public.legal_acceptances (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  slug        text not null,
  version     text not null,
  accepted_at timestamptz not null default now()
);
create index if not exists legal_acceptances_user_idx on public.legal_acceptances (user_id);
alter table public.legal_acceptances enable row level security;
drop policy if exists "legal_acc_insert_own" on public.legal_acceptances;
create policy "legal_acc_insert_own" on public.legal_acceptances for insert with check (auth.uid() = user_id);
drop policy if exists "legal_acc_select_own" on public.legal_acceptances;
create policy "legal_acc_select_own" on public.legal_acceptances for select using (auth.uid() = user_id);

-- Seed the current versions (dollar-quoted bodies avoid escaping).
insert into public.legal_documents (slug, version, title, body) values
('terms', '2026-06-13', 'Terms of Service', $doc$Last updated: 2026-06-13

Welcome to GoHustlr. By creating an account or using the app you agree to these Terms.

1. What GoHustlr is. GoHustlr is a marketplace that connects people who want to hire help ("Posters") with people who want to perform work ("Earners"). GoHustlr is not a party to the agreements made between Posters and Earners and does not employ Earners. We provide the platform, payments tooling, and tools to coordinate work.

2. Eligibility. You must be at least 18 years old and able to form a binding contract. You agree to provide accurate information and keep it up to date.

3. Bookings and payments. Posters fund a booking through our payment processor (Stripe). Funds are held and released to the Earner after the work is verified. Cash payments arranged off-platform are at the parties' own risk and are not protected by GoHustlr.

4. Fees. GoHustlr charges a service fee on platform payments, disclosed before you confirm.

5. Conduct. You agree not to use GoHustlr for anything illegal, harmful, harassing, or fraudulent, and not to circumvent platform payments. We may suspend or remove accounts that violate these Terms.

6. Ratings and content. You are responsible for content you post (gigs, messages, photos, reviews). Don't post anything unlawful or infringing. You grant GoHustlr a license to display content you submit for operating the service.

7. Disclaimers. The service is provided "as is." GoHustlr does not guarantee the quality, safety, or legality of gigs or the conduct of users. To the maximum extent permitted by law, GoHustlr is not liable for indirect or consequential damages.

8. Changes. We may update these Terms; continued use after an update means you accept the new version.

Contact: mainmail@gohustlr.com$doc$),
('privacy', '2026-06-13', 'Privacy Policy', $doc$Last updated: 2026-06-13

This Privacy Policy explains what we collect and how we use it.

1. Information we collect. Account details (name, email, username, photo), profile info (bio, city, skills), gig and booking activity, messages, reviews, photos you upload, expense/income records you enter, device push tokens, and payment information processed by Stripe.

2. How we use it. To operate the marketplace, match Posters and Earners, process payments and payouts, send notifications, prevent fraud and abuse, and improve the product.

3. Sharing. We share information between the Poster and Earner of a booking as needed to coordinate work. We use service providers (e.g., Supabase for data, Stripe for payments, Expo for push) who process data on our behalf. We do not sell your personal information.

4. Payments. Card and payout data is handled by Stripe under its own terms and privacy policy. We don't store full card numbers.

5. Your choices. You can edit your profile, delete content you created, and request account deletion by contacting us. You can disable push notifications in your device settings.

6. Security. We use access controls and encryption in transit. No system is perfectly secure.

7. Contact. Questions or data requests: mainmail@gohustlr.com$doc$),
('contractor', '2026-06-13', 'Independent Contractor Agreement', $doc$Last updated: 2026-06-13

This Agreement applies to Earners who perform work through GoHustlr.

1. Independent contractor status. You are an independent contractor, not an employee, agent, or partner of GoHustlr. You are not entitled to employee benefits, and GoHustlr does not withhold taxes on your behalf.

2. Your responsibilities. You control how, when, and whether you accept and perform work. You supply your own tools unless a Poster provides them. You are responsible for performing work competently, safely, and lawfully.

3. Taxes. You are solely responsible for reporting and paying all taxes on income you earn, including cash payments. For card payments processed through Stripe, you may receive tax forms (e.g., a 1099-K) where required by law. Use the in-app Tax Center to track income and deductible expenses.

4. Insurance and liability. You are responsible for any insurance appropriate to your work. GoHustlr is not liable for injuries, damages, or losses arising from work you perform or arrange.

5. Relationship with Posters. Your agreement to perform a gig is directly with the Poster. GoHustlr is not a party to that agreement.

6. No guarantee of work. GoHustlr does not guarantee any minimum amount of gigs, bookings, or income.

By accepting, you confirm you have read and agree to operate as an independent contractor.

Contact: mainmail@gohustlr.com$doc$)
on conflict (slug, version) do nothing;
