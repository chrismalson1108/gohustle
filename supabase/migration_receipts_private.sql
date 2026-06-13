-- Make the receipts bucket private (financial documents). Owners read their own
-- via signed URLs; insert/delete owner policies remain. Idempotent.
update storage.buckets set public = false where id = 'receipts';

drop policy if exists "receipts_public_read" on storage.objects;
drop policy if exists "receipts_owner_read" on storage.objects;
create policy "receipts_owner_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
