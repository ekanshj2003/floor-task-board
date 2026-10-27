-- Run this ONCE in Supabase → SQL Editor, after the "Deploy Supabase" GitHub Action has finished.
-- It lets the database call the notification functions.
--
-- 1. Replace YOUR-PROJECT-REF with your project's reference (Settings → General → Reference ID).
-- 2. Replace PASTE-YOUR-CRON-SECRET with the same CRON_SECRET you saved in GitHub secrets.
-- 3. Press Run.

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
select vault.create_secret('PASTE-YOUR-CRON-SECRET', 'cron_secret');

-- To change them later:
-- select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), 'NEW-VALUE');
