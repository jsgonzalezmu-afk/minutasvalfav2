-- ═══════════════════════════════════════════════════════════════
--  MINUTAS LEGALES COLOMBIA — Supabase Schema
--  Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════

-- ── MINUTAS ──────────────────────────────────────────────────
create table if not exists minutas (
  id                  uuid        primary key default gen_random_uuid(),
  nombre              text        not null,
  descripcion         text,
  categoria           text,
  tipo_documento      text,
  contexto_ia         text,
  precio              numeric(12,2) default 0,
  campos              jsonb       default '[]',
  campos_largo        jsonb       default '[]',
  tiene_ia            boolean     default false,
  placeholders_ia     jsonb       default '[]',
  tiene_clausulas     boolean     default false,
  clausulas_eleccion  jsonb       default '[]',
  archivo_url         text,
  archivo_nombre      text,
  -- Base64 para archivos ≤ 700 KB (acceso sin Storage)
  docx_base64         text,
  -- URL pública del docx de previsualización (sin marcadores)
  docx_preview_url    text,
  -- true cuando el docx solo vive en Storage (> 700 KB)
  solo_storage        boolean     default false,
  created_at          timestamptz default now()
);

-- ── VENTAS ──────────────────────────────────────────────────
create table if not exists ventas (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  user_email      text,
  minuta_id       uuid        references minutas(id) on delete set null,
  minuta_nombre   text,
  precio          numeric(12,2) default 0,
  estado          text        default 'pagado',
  metodo_pago     text,
  reference       text,
  transaction_id  text,
  created_at      timestamptz default now()
);

-- ── CATEGORIAS ───────────────────────────────────────────────
create table if not exists categorias (
  id          uuid        primary key default gen_random_uuid(),
  nombre      text        not null unique,
  created_at  timestamptz default now()
);

-- ── CONFIG ───────────────────────────────────────────────────
-- PK de texto para direccionar filas por nombre: 'wompi' | 'openai'
create table if not exists config (
  id               text        primary key,
  public_key       text,
  integrity_secret text,
  mode             text        default 'test',
  api_key          text,
  updated_at       timestamptz default now()
);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────

-- minutas: lectura pública, escritura solo admin
alter table minutas enable row level security;

create policy "minutas_select_public"
  on minutas for select using (true);

create policy "minutas_insert_admin"
  on minutas for insert
  with check (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "minutas_update_admin"
  on minutas for update
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "minutas_delete_admin"
  on minutas for delete
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

-- ventas: cada usuario ve las propias; admin ve todas; solo el dueño inserta
alter table ventas enable row level security;

create policy "ventas_select_own_or_admin"
  on ventas for select
  using (
    auth.uid() = user_id
    or (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "ventas_insert_own"
  on ventas for insert
  with check (auth.uid() = user_id);

create policy "ventas_delete_admin"
  on ventas for delete
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

-- categorias: lectura pública, escritura solo admin
alter table categorias enable row level security;

create policy "categorias_select_public"
  on categorias for select using (true);

create policy "categorias_insert_admin"
  on categorias for insert
  with check (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "categorias_delete_admin"
  on categorias for delete
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

-- config: solo admin
alter table config enable row level security;

create policy "config_select_admin"
  on config for select
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "config_insert_admin"
  on config for insert
  with check (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

create policy "config_update_admin"
  on config for update
  using (
    (select email from auth.users where id = auth.uid()) = 'jsgonzalezmu@gmail.com'
  );

-- ── ÍNDICES ─────────────────────────────────────────────────
create index if not exists idx_minutas_categoria  on minutas  (categoria);
create index if not exists idx_minutas_created_at on minutas  (created_at desc);
create index if not exists idx_ventas_user_id     on ventas   (user_id);
create index if not exists idx_ventas_created_at  on ventas   (created_at desc);

-- ── STORAGE BUCKET ───────────────────────────────────────────
-- Ejecutar en Supabase Dashboard → SQL Editor:
--
--   insert into storage.buckets (id, name, public)
--   values ('minutas', 'minutas', true)
--   on conflict (id) do nothing;
--
-- Luego en Storage → Policies, agregar:
--
--   Política lectura pública (SELECT):
--     bucket_id = 'minutas'
--
--   Política subida admin (INSERT):
--     bucket_id = 'minutas'
--     AND (select email from auth.users where id = auth.uid())
--         = 'jsgonzalezmu@gmail.com'
--
-- Los archivos quedan en:
--   Storage / minutas / minutas/<timestamp>_<filename>.docx
-- URL pública:
--   https://<proyecto>.supabase.co/storage/v1/object/public/minutas/minutas/<archivo>
