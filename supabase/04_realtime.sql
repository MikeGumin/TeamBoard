-- =====================================================================
-- TeamBoard · Шаг 4 (опционально). Realtime — живое обновление доски
-- Выполнить в Supabase Dashboard → SQL Editor.
-- Без этого шага приложение работает, но данные обновляются только
-- при действиях пользователя / перезагрузке страницы.
-- =====================================================================

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.docs;
alter publication supabase_realtime add table public.profiles;

-- Если команда "table is not in publication" уже добавлена — ошибка не страшна,
-- просто пропустите соответствующую строку.
