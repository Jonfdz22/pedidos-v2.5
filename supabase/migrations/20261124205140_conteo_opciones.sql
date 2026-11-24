alter table public.sesiones_conteo
  add column if not exists mostrar_existencias boolean not null default true,
  add column if not exists revisar_pendientes boolean not null default true,
  add column if not exists visibilidad_actualizada_por text,
  add column if not exists visibilidad_actualizada_en timestamptz;
