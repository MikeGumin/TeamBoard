-- =====================================================================
-- TeamBoard · Шаг 2. Row Level Security (RLS) — правила доступа
-- Выполнить в Supabase Dashboard → SQL Editor ПОСЛЕ 01_schema.sql
--
-- Идея: анонимный ключ из браузера может читать/менять ТОЛЬКО то,
-- что разрешено этими политиками. Обход возможен только через
-- service_role key (он не попадает во фронтенд).
-- =====================================================================

alter table public.profiles      enable row level security;
alter table public.docs          enable row level security;
alter table public.tasks         enable row level security;
alter table public.task_comments enable row level security;
alter table public.invite_codes  enable row level security;

-- ---------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------
-- Любой авторизованный видит список команды (имена нужны в карточках задач).
drop policy if exists "profiles: read all authed" on public.profiles;
create policy "profiles: read all authed"
  on public.profiles for select
  to authenticated
  using (true);

-- Пользователь может обновить СВОЙ профиль (имя), но не роль.
-- Роль меняется только политикой ниже (админ) или триггером при регистрации.
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = 'worker');

-- Админ может менять любой профиль (повышать/понижать роли, править имя).
drop policy if exists "profiles: admin updates any" on public.profiles;
create policy "profiles: admin updates any"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Вставка профилей НЕ разрешена напрямую — её делает триггер handle_new_user
-- (security definer) при регистрации.

-- ---------------------------------------------------------------------
-- DOCS (документация)
-- ---------------------------------------------------------------------
-- Читать могут все авторизованные.
drop policy if exists "docs: read authed" on public.docs;
create policy "docs: read authed"
  on public.docs for select
  to authenticated
  using (true);

-- Создавать/редактировать/удалять статьи — только админ.
drop policy if exists "docs: admin insert" on public.docs;
create policy "docs: admin insert"
  on public.docs for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "docs: admin update" on public.docs;
create policy "docs: admin update"
  on public.docs for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "docs: admin delete" on public.docs;
create policy "docs: admin delete"
  on public.docs for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- TASKS (задачи)
-- ---------------------------------------------------------------------
-- Авторизованные читают все задачи (у каждого свой фильтр по исполнителю
-- делается на клиенте; закрытые данные здесь отсутствуют).
drop policy if exists "tasks: read authed" on public.tasks;
create policy "tasks: read authed"
  on public.tasks for select
  to authenticated
  using (true);

-- Создавать задачи — только админ.
drop policy if exists "tasks: admin insert" on public.tasks;
create policy "tasks: admin insert"
  on public.tasks for insert
  to authenticated
  with check (public.is_admin());

-- Обновлять задачу может:
--   1) админ — всё (статус, исполнитель, срок, текст);
--   2) исполнитель задачи — только статус (проверяется ниже отдельной
--      политикой "worker moves own status").
-- Здесь — право админа.
drop policy if exists "tasks: admin update" on public.tasks;
create policy "tasks: admin update"
  on public.tasks for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Право исполнителя менять задачу (в первую очередь — статус).
-- Жёсткие ограничения («рабочий не может закрыть задачу», «не может
-- переписать текст/исполнителя») обеспечиваются триггером
-- guard_task_update() ниже — на уровне БД, а не только в UI.
drop policy if exists "tasks: assignee update status" on public.tasks;
create policy "tasks: assignee update status"
  on public.tasks for update
  to authenticated
  using (assignee_id = auth.uid())
  with check (assignee_id = auth.uid());

-- Удалять задачи — только админ.
drop policy if exists "tasks: admin delete" on public.tasks;
create policy "tasks: admin delete"
  on public.tasks for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- Триггер-защита для рабочих:
--   1) НЕ могут перевести задачу в done/closed (это привилегия капитана);
--   2) НЕ могут менять заголовок, описание, исполнителя и срок —
--      только статус. Админ проходит свободно.
-- ---------------------------------------------------------------------
create or replace function public.guard_task_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.status in ('done', 'closed') then
      raise exception 'Закрывать задачи может только админ';
    end if;
    if new.title       is distinct from old.title
       or new.description  is distinct from old.description
       or new.assignee_id  is distinct from old.assignee_id
       or new.due_date     is distinct from old.due_date
       or new.creator_id   is distinct from old.creator_id then
      raise exception 'Рабочий может менять только статус задачи';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists task_update_guard on public.tasks;
create trigger task_update_guard before update on public.tasks
  for each row execute function public.guard_task_update();

-- ---------------------------------------------------------------------
-- TASK_COMMENTS
-- ---------------------------------------------------------------------
-- Все авторизованные читают комментарии; пишут от своего имени;
-- удалить комментарий может только админ.
drop policy if exists "comments: read authed" on public.task_comments;
create policy "comments: read authed"
  on public.task_comments for select
  to authenticated
  using (true);

drop policy if exists "comments: insert own" on public.task_comments;
create policy "comments: insert own"
  on public.task_comments for insert
  to authenticated
  with check (author_id = auth.uid());

drop policy if exists "comments: admin delete" on public.task_comments;
create policy "comments: admin delete"
  on public.task_comments for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- INVITE_CODES
-- ---------------------------------------------------------------------
-- Админ: полный доступ к кодам.
drop policy if exists "invites: admin all" on public.invite_codes;
create policy "invites: admin all"
  on public.invite_codes for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Прямой доступ незалогиненных к таблице кодов ЗАКРЫТ (см. выше: политика
-- только для admin). Проверка кода при регистрации идёт через безопасную
-- RPC-функцию consume_invite_code() из файла 03_functions.sql — она атомарно
-- проверяет и «сжигает» код, поэтому перебирать или блокировать чужие коды
-- через прямые запросы невозможно.
drop policy if exists "invites: no anon access" on public.invite_codes;
