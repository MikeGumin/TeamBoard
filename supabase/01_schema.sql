-- =====================================================================
-- TeamBoard · Шаг 1. Схема базы данных
-- Выполнить в Supabase Dashboard → SQL Editor (кнопка "New query")
-- =====================================================================

-- Профили пользователей (связаны с auth.users через id)
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '',
  role        text not null default 'worker' check (role in ('admin', 'worker')),
  created_at  timestamptz not null default now()
);

-- Статьи документации
create table if not exists public.docs (
  id          bigint generated always as identity primary key,
  title       text not null,
  content     text not null default '',
  author_id   uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Задачи
create table if not exists public.tasks (
  id            bigint generated always as identity primary key,
  title         text not null,
  description   text not null default '',
  assignee_id   uuid references public.profiles (id) on delete set null,
  creator_id    uuid references public.profiles (id) on delete set null,
  status        text not null default 'todo'
                check (status in ('todo', 'in_progress', 'review', 'done', 'closed')),
  due_date      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Комментарии к задачам
create table if not exists public.task_comments (
  id          bigint generated always as identity primary key,
  task_id     bigint not null references public.tasks (id) on delete cascade,
  author_id   uuid references public.profiles (id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Пригласительные коды для регистрации (выдаёт админ)
create table if not exists public.invite_codes (
  code        text primary key,
  created_by  uuid references public.profiles (id) on delete set null,
  used_by     uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);

-- Индексы
create index if not exists tasks_assignee_idx  on public.tasks (assignee_id);
create index if not exists tasks_status_idx    on public.tasks (status);
create index if not exists comments_task_idx   on public.task_comments (task_id);
create index if not exists docs_title_idx      on public.docs using gin (to_tsvector('simple', title));

-- Автообновление updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Триггер: при создании пользователя в auth.users автоматически
-- создаём профиль. Первый зарегистрированный человек становится ADMIN.
-- Все последующие — worker (повысить можно на вкладке «Админ»).
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  user_count int;
begin
  select count(*) into user_count from public.profiles;
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case when user_count = 0 then 'admin' else 'worker' end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- Функция проверки «я админ» (используется в RLS-политиках).
-- security definer нужен, чтобы не было рекурсии политик на profiles.
-- =====================================================================
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;
