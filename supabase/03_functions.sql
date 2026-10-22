-- =====================================================================
-- TeamBoard · Шаг 3. RPC-функция проверки приглашения
-- Выполнить в Supabase Dashboard → SQL Editor ПОСЛЕ 01_schema.sql
-- =====================================================================

-- Вызывается клиентом ПЕРЕД signUp. Атомарно: если код существует и не
-- использован — помечает его занятым под данным email и возвращает true.
-- Если кода нет / он уже применён — false.
-- security definer: функция имеет доступ к invite_codes в обход RLS,
-- но логика внутри жёсткая, а input — короткий код, который знает только
-- приглашённый человек и админ.
create or replace function public.consume_invite_code(p_code text, p_email text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  affected int;
begin
  update public.invite_codes
     set used_by = null,            -- uid ещё нет, отметим ниже триггером
         used_at = now(),
         code = code                -- noop, чтобы old/new были доступны
   where lower(code) = lower(trim(p_code))
     and used_at is null;
  get diagnostics affected = row_count;

  if affected = 0 then
    return false;
  end if;

  -- запоминаем email, на который был погашен код (в special колонке нет
  -- нужды: привяжем фактического нового пользователя триггером ниже)
  insert into public.invite_redemptions (code, email)
  values (lower(trim(p_code)), lower(trim(p_email)))
  on conflict (code) do update set email = excluded.email;

  return true;
end $$;

revoke all on function public.consume_invite_code(text, text) from public;
grant execute on function public.consume_invite_code(text, text) to anon, authenticated;

-- Таблица «кто каким кодом воспользовался» (для последующей привязки uid)
create table if not exists public.invite_redemptions (
  code        text primary key,
  email       text not null,
  redeemed_at timestamptz not null default now()
);
alter table public.invite_redemptions enable row level security;
-- Доступ только через функции админа/триггеры — прямых политик нет.

-- При появлении нового пользователя дописываем used_by его uid,
-- если он зарегистрировался с email, для которого был погашен код.
create or replace function public.link_invite_to_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.invite_codes ic
     set used_by = new.id
    from public.invite_redemptions r
   where lower(ic.code) = r.code
     and r.email = lower(new.email)
     and ic.used_by is null;
  return new;
end $$;

drop trigger if exists on_auth_user_link_invite on auth.users;
create trigger on_auth_user_link_invite
  after insert on auth.users
  for each row execute function public.link_invite_to_user();

-- Админский просмотр кодов остаётся через обычную таблицу (политика
-- "invites: admin all").
