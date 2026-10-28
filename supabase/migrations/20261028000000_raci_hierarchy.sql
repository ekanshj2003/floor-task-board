-- Floor Task Board: reporting hierarchy + R/A/C/I on tasks + escalation
--   Responsible  = tasks.assignee   (one person, does the work)
--   Accountable  = tasks.accountable (one person, owns the result)
--   Consulted    = tasks.consulted   (several people, give input)
--   Informed     = tasks.informed    (several people, kept updated)

---------------------------------------------------------------------------
-- Columns
---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists reports_to uuid references public.profiles (id) on delete set null;
create index if not exists profiles_reports_to_idx on public.profiles (reports_to);

alter table public.tasks
  add column if not exists accountable uuid references public.profiles (id) on delete set null,
  add column if not exists consulted uuid[] not null default '{}',
  add column if not exists informed uuid[] not null default '{}',
  add column if not exists escalation_level int not null default 0;

-- Existing tasks: whoever assigned it is accountable
update public.tasks set accountable = assigned_by where accountable is null;

---------------------------------------------------------------------------
-- Hierarchy helpers
---------------------------------------------------------------------------

-- Everyone below a person (direct reports, their reports, and so on)
create or replace function private.team_of(uid uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  with recursive t as (
    select id from public.profiles where reports_to = uid
    union
    select p.id from public.profiles p join t on p.reports_to = t.id
  )
  select coalesce(array_agg(id), '{}') from t
$$;

-- Can the signed-in person see a task?
--   admin: everything
--   everyone else: tasks they are part of, plus tasks of anyone below them
create or replace function public.can_see_task(r uuid, a uuid, c uuid[], i uuid[], by_ uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_role text;
  team uuid[];
begin
  select p.role into my_role from public.profiles p where p.id = me and p.active;
  if my_role is null then return false; end if;
  if my_role = 'admin' then return true; end if;
  if me = r or me = a or me = by_ or me = any(coalesce(c, '{}')) or me = any(coalesce(i, '{}')) then
    return true;
  end if;
  team := private.team_of(me);
  if cardinality(team) = 0 then return false; end if;
  return coalesce(r = any(team), false)
      or coalesce(a = any(team), false)
      or coalesce(by_ = any(team), false)
      or coalesce(c, '{}') && team
      or coalesce(i, '{}') && team;
end $$;
revoke all on function public.can_see_task(uuid, uuid, uuid[], uuid[], uuid) from public, anon;
grant execute on function public.can_see_task(uuid, uuid, uuid[], uuid[], uuid) to authenticated;

-- Stop loops like A reports to B and B reports to A
create or replace function private.check_reports_to()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.reports_to is not null then
    if new.reports_to = new.id then
      raise exception 'A person cannot report to themselves.';
    end if;
    if new.reports_to = any(private.team_of(new.id)) then
      raise exception 'That would create a loop: the chosen boss already reports up to this person.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_reports_to_check on public.profiles;
create trigger profiles_reports_to_check
  before insert or update of reports_to on public.profiles
  for each row execute function private.check_reports_to();

-- New users can be created with a boss already set
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  first_user boolean := not exists (select 1 from public.profiles);
  boss uuid;
begin
  begin
    boss := nullif(meta->>'reports_to', '')::uuid;
  exception when others then
    boss := null;
  end;
  if boss is not null and not exists (select 1 from public.profiles where id = boss) then
    boss := null;
  end if;

  insert into public.profiles (id, name, username, dept, role, phone, reports_to)
  values (
    new.id,
    coalesce(nullif(meta->>'name', ''), split_part(coalesce(new.email, ''), '@', 1), new.phone, 'User'),
    nullif(lower(meta->>'username'), ''),
    coalesce(nullif(meta->>'dept', ''), (select name from public.departments order by sort limit 1)),
    case when first_user then 'admin'
         when meta->>'role' in ('admin', 'manager', 'staff') then meta->>'role'
         else 'staff' end,
    new.phone,
    boss
  );
  return new;
end $$;

---------------------------------------------------------------------------
-- Task rules
---------------------------------------------------------------------------

create or replace function private.task_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.assigned_by := auth.uid();
    if new.accountable is null then
      new.accountable := auth.uid();
    end if;
  end if;
  new.consulted := coalesce(new.consulted, '{}');
  new.informed := coalesce(new.informed, '{}');
  new.done_at := case when new.status = 'done' then now() else null end;
  return new;
end $$;

create or replace function private.task_before_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Staff (as Responsible or Accountable) may only change the status
  if auth.uid() is not null and coalesce(public.my_role(), 'staff') = 'staff' then
    if new.title is distinct from old.title
       or new.details is distinct from old.details
       or new.dept is distinct from old.dept
       or new.assignee is distinct from old.assignee
       or new.accountable is distinct from old.accountable
       or new.consulted is distinct from old.consulted
       or new.informed is distinct from old.informed
       or new.assigned_by is distinct from old.assigned_by
       or new.due is distinct from old.due
       or new.priority is distinct from old.priority then
      raise exception 'Only a manager can edit task details';
    end if;
  end if;

  new.consulted := coalesce(new.consulted, '{}');
  new.informed := coalesce(new.informed, '{}');

  if new.status = 'done' and old.status <> 'done' then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;

  -- New deadline or new Responsible person: reminders and escalation start over
  if new.due is distinct from old.due or new.assignee is distinct from old.assignee then
    new.sent_24h := false;
    new.sent_morning := false;
    new.sent_1h := false;
    new.sent_overdue := false;
    new.escalation_level := 0;
  end if;
  return new;
end $$;

---------------------------------------------------------------------------
-- Notify the people added to a task, with their role
---------------------------------------------------------------------------

create or replace function private.on_task_people()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  items jsonb := '[]'::jsonb;
  o_r uuid;
  o_a uuid;
  o_c uuid[] := '{}';
  o_i uuid[] := '{}';
  x uuid;
begin
  if new.status = 'done' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    o_r := old.assignee;
    o_a := old.accountable;
    o_c := coalesce(old.consulted, '{}');
    o_i := coalesce(old.informed, '{}');
  end if;

  if new.assignee is not null and new.assignee is distinct from o_r then
    items := items || jsonb_build_object('id', new.assignee, 'role', 'R');
  end if;
  if new.accountable is not null and new.accountable is distinct from o_a then
    items := items || jsonb_build_object('id', new.accountable, 'role', 'A');
  end if;
  for x in select unnest(coalesce(new.consulted, '{}')) except select unnest(o_c) loop
    items := items || jsonb_build_object('id', x, 'role', 'C');
  end loop;
  for x in select unnest(coalesce(new.informed, '{}')) except select unnest(o_i) loop
    items := items || jsonb_build_object('id', x, 'role', 'I');
  end loop;

  if jsonb_array_length(items) > 0 then
    perform private.call_fn('notify', jsonb_build_object(
      'type', 'assigned', 'task_id', new.id, 'actor', auth.uid(), 'people', items));
  end if;
  return null;
end $$;

drop trigger if exists tasks_notify_insert on public.tasks;
drop trigger if exists tasks_notify_reassign on public.tasks;
drop trigger if exists tasks_notify_people on public.tasks;
create trigger tasks_notify_people
  after insert or update of assignee, accountable, consulted, informed on public.tasks
  for each row execute function private.on_task_people();

---------------------------------------------------------------------------
-- Who sees what (row level security)
---------------------------------------------------------------------------

drop policy if exists "read tasks" on public.tasks;
create policy "read tasks" on public.tasks for select to authenticated
  using (public.can_see_task(assignee, accountable, consulted, informed, assigned_by));

drop policy if exists "managers or assignee update tasks" on public.tasks;
create policy "managers, responsible or accountable update tasks" on public.tasks for update to authenticated
  using (
    public.my_role() = 'admin'
    or (public.my_role() = 'manager' and public.can_see_task(assignee, accountable, consulted, informed, assigned_by))
    or assignee = auth.uid()
    or accountable = auth.uid()
  );

drop policy if exists "managers delete tasks" on public.tasks;
create policy "managers delete tasks" on public.tasks for delete to authenticated
  using (
    public.my_role() = 'admin'
    or (public.my_role() = 'manager' and public.can_see_task(assignee, accountable, consulted, informed, assigned_by))
  );

drop policy if exists "read followups" on public.followups;
create policy "read followups" on public.followups for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id));

drop policy if exists "add own followups" on public.followups;
create policy "add own followups" on public.followups for insert to authenticated
  with check (author = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id));
