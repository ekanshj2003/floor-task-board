-- Floor Task Board: database schema, security rules and notification triggers
-- Applied automatically by the "Deploy Supabase" GitHub Action (supabase db push).

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create schema if not exists private;

---------------------------------------------------------------------------
-- Tables
---------------------------------------------------------------------------

create table public.departments (
  name text primary key check (char_length(name) between 1 and 40),
  sort int not null default 100
);
insert into public.departments (name, sort) values
  ('Factory', 1), ('Godown', 2), ('Office', 3)
on conflict do nothing;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  username text unique check (username ~ '^[a-z0-9._-]{3,30}$'),
  dept text references public.departments (name) on update cascade on delete set null,
  role text not null default 'staff' check (role in ('admin', 'manager', 'staff')),
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  details text not null default '',
  dept text references public.departments (name) on update cascade on delete set null,
  assignee uuid references public.profiles (id) on delete set null,
  assigned_by uuid references public.profiles (id) on delete set null,
  due timestamptz not null,
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  status text not null default 'open' check (status in ('open', 'progress', 'done')),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  -- reminder bookkeeping (set by the reminders function)
  sent_24h boolean not null default false,
  sent_morning boolean not null default false,
  sent_1h boolean not null default false,
  sent_overdue boolean not null default false
);
create index tasks_due_idx on public.tasks (due) where status <> 'done';
create index tasks_assignee_idx on public.tasks (assignee);

create table public.followups (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks (id) on delete cascade,
  author uuid references public.profiles (id) on delete set null default auth.uid(),
  note text not null check (char_length(note) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index followups_task_idx on public.followups (task_id, created_at);

-- One row per phone/browser that turned on notifications
create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- In-app alert inbox (every push is also stored here)
create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- Lockout for username + PIN logins (used only by the login function)
create table public.login_attempts (
  username text primary key,
  failed int not null default 0,
  locked_until timestamptz
);

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

-- Calls one of our Edge Functions in the background (needs the two vault
-- secrets from supabase/setup_secrets.sql; does nothing until they exist).
create or replace function private.call_fn(fn text, payload jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  base text;
  secret text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if base is null or secret is null then
    return;
  end if;
  perform net.http_post(
    url := rtrim(base, '/') || '/functions/v1/' || fn,
    body := payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 10000
  );
end $$;

---------------------------------------------------------------------------
-- New user -> profile (the very first account becomes admin)
---------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  first_user boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, name, username, dept, role, phone)
  values (
    new.id,
    coalesce(nullif(meta->>'name', ''), split_part(coalesce(new.email, ''), '@', 1), new.phone, 'User'),
    nullif(lower(meta->>'username'), ''),
    coalesce(nullif(meta->>'dept', ''), (select name from public.departments order by sort limit 1)),
    case when first_user then 'admin'
         when meta->>'role' in ('admin', 'manager', 'staff') then meta->>'role'
         else 'staff' end,
    new.phone
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

---------------------------------------------------------------------------
-- Task rules
---------------------------------------------------------------------------

create or replace function private.task_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.assigned_by := auth.uid();
  end if;
  new.done_at := case when new.status = 'done' then now() else null end;
  return new;
end $$;

create trigger tasks_before_insert
  before insert on public.tasks
  for each row execute function private.task_before_insert();

create or replace function private.task_before_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Staff (the assignee) may only change the status
  if auth.uid() is not null and coalesce(public.my_role(), 'staff') = 'staff' then
    if new.title is distinct from old.title
       or new.details is distinct from old.details
       or new.dept is distinct from old.dept
       or new.assignee is distinct from old.assignee
       or new.assigned_by is distinct from old.assigned_by
       or new.due is distinct from old.due
       or new.priority is distinct from old.priority then
      raise exception 'Only a manager can edit task details';
    end if;
  end if;

  if new.status = 'done' and old.status <> 'done' then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;

  -- New deadline or new person: reminders start over
  if new.due is distinct from old.due or new.assignee is distinct from old.assignee then
    new.sent_24h := false;
    new.sent_morning := false;
    new.sent_1h := false;
    new.sent_overdue := false;
  end if;
  return new;
end $$;

create trigger tasks_before_update
  before update on public.tasks
  for each row execute function private.task_before_update();

---------------------------------------------------------------------------
-- Instant notifications
---------------------------------------------------------------------------

create or replace function private.on_task_assigned()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.assignee is distinct from old.assignee then
    perform private.call_fn('notify', jsonb_build_object('type', 'assigned', 'task_id', new.id));
  end if;
  return null;
end $$;

create trigger tasks_notify_insert
  after insert on public.tasks
  for each row execute function private.on_task_assigned();

create trigger tasks_notify_reassign
  after update of assignee on public.tasks
  for each row execute function private.on_task_assigned();

create or replace function private.on_followup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform private.call_fn('notify', jsonb_build_object('type', 'followup', 'followup_id', new.id));
  return null;
end $$;

create trigger followups_notify
  after insert on public.followups
  for each row execute function private.on_followup();

-- Deadline reminders: every 5 minutes
select cron.schedule('task-reminders', '*/5 * * * *', $$select private.call_fn('reminders', '{}'::jsonb)$$);

---------------------------------------------------------------------------
-- Row level security
---------------------------------------------------------------------------

alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.followups enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notifications enable row level security;
alter table public.login_attempts enable row level security; -- no policies: server only

create policy "read departments" on public.departments for select to authenticated using (true);
create policy "admin adds departments" on public.departments for insert to authenticated with check (public.my_role() = 'admin');
create policy "admin edits departments" on public.departments for update to authenticated using (public.my_role() = 'admin');
create policy "admin removes departments" on public.departments for delete to authenticated using (public.my_role() = 'admin');

-- Profiles are changed only through the admin-users function
create policy "read team" on public.profiles for select to authenticated using (true);

create policy "read tasks" on public.tasks for select to authenticated using (public.my_role() is not null);
create policy "managers create tasks" on public.tasks for insert to authenticated
  with check (public.my_role() in ('admin', 'manager'));
create policy "managers or assignee update tasks" on public.tasks for update to authenticated
  using (public.my_role() in ('admin', 'manager') or assignee = auth.uid());
create policy "managers delete tasks" on public.tasks for delete to authenticated
  using (public.my_role() in ('admin', 'manager'));

create policy "read followups" on public.followups for select to authenticated using (public.my_role() is not null);
create policy "add own followups" on public.followups for insert to authenticated
  with check (author = auth.uid() and public.my_role() is not null);

create policy "own subscriptions" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own alerts" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "mark own alerts read" on public.notifications for update to authenticated using (user_id = auth.uid());

-- Live updates in the app
alter publication supabase_realtime add table public.tasks, public.followups, public.notifications;
