-- ═══════════════════════════════════════════════════════════════
--  SUSCRIPCIONES MONITOREO — Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

create table if not exists suscripciones_monitoreo (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  user_email     text,
  plan           text        not null,   -- 'basico' | 'premium'
  created_at     timestamptz default now(),
  vence_at       timestamptz not null,
  reference      text,
  transaction_id text,
  metodo_pago    text
);

alter table suscripciones_monitoreo enable row level security;

create policy "susc_mon_select_own_or_admin"
  on suscripciones_monitoreo for select
  using (
    auth.uid() = user_id
    or (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "susc_mon_insert_own"
  on suscripciones_monitoreo for insert
  with check (auth.uid() = user_id);

create policy "susc_mon_update_admin"
  on suscripciones_monitoreo for update
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "susc_mon_delete_admin"
  on suscripciones_monitoreo for delete
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create index if not exists idx_susc_mon_user_id  on suscripciones_monitoreo (user_id);
create index if not exists idx_susc_mon_vence_at on suscripciones_monitoreo (vence_at);
