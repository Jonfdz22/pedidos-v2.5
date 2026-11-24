create table public.relma_muebles_inventarios (
  id uuid primary key,
  encargado uuid not null references auth.users(id),
  sucursal text not null,
  nombre text not null check (length(trim(nombre)) between 1 and 120),
  referencia jsonb not null check (jsonb_typeof(referencia) = 'array'),
  creado timestamptz not null default now()
);

create table public.relma_muebles_catalogos (
  inventario uuid primary key references public.relma_muebles_inventarios(id),
  productos jsonb not null check (jsonb_typeof(productos) = 'array')
);

create table public.relma_muebles_ubicaciones (
  id uuid primary key,
  inventario uuid not null references public.relma_muebles_inventarios(id),
  nombre text not null check (length(trim(nombre)) between 1 and 120),
  persona text not null check (length(trim(persona)) between 1 and 100),
  correo text not null check (correo = lower(trim(correo)) and length(correo) between 3 and 254),
  terminada boolean not null default false,
  unique (inventario, nombre)
);

create table public.relma_muebles_capturas (
  ubicacion uuid not null references public.relma_muebles_ubicaciones(id),
  sku text not null check (length(trim(sku)) between 1 and 120),
  cantidad integer not null check (cantidad between 0 and 10000000),
  descripcion text not null default '' check (length(descripcion) <= 200),
  actualizado timestamptz not null default now(),
  primary key (ubicacion, sku)
);

create table public.relma_muebles_operaciones (
  ubicacion uuid not null references public.relma_muebles_ubicaciones(id),
  id uuid not null,
  primary key (ubicacion, id)
);

create index on public.relma_muebles_inventarios (encargado, sucursal);
create index on public.relma_muebles_ubicaciones (inventario, correo);

alter table public.relma_muebles_inventarios enable row level security;
alter table public.relma_muebles_catalogos enable row level security;
alter table public.relma_muebles_ubicaciones enable row level security;
alter table public.relma_muebles_capturas enable row level security;
alter table public.relma_muebles_operaciones enable row level security;

revoke all on public.relma_muebles_inventarios, public.relma_muebles_catalogos,
  public.relma_muebles_ubicaciones, public.relma_muebles_capturas, public.relma_muebles_operaciones
  from public, anon, authenticated;
grant select, insert on public.relma_muebles_inventarios, public.relma_muebles_catalogos,
  public.relma_muebles_ubicaciones, public.relma_muebles_capturas, public.relma_muebles_operaciones to authenticated;
grant update (terminada) on public.relma_muebles_ubicaciones to authenticated;
grant update (cantidad, descripcion, actualizado) on public.relma_muebles_capturas to authenticated;

create policy inventario_encargado on public.relma_muebles_inventarios
  for all to authenticated
  using (encargado = (select auth.uid()))
  with check (encargado = (select auth.uid()));

create policy ubicacion_leer on public.relma_muebles_ubicaciones
  for select to authenticated
  using (correo = lower((select auth.jwt() ->> 'email')) or exists (
    select 1 from public.relma_muebles_inventarios i where i.id = inventario and i.encargado = (select auth.uid())
  ));

create policy ubicacion_asignar on public.relma_muebles_ubicaciones
  for insert to authenticated
  with check (exists (select 1 from public.relma_muebles_inventarios i where i.id = inventario and i.encargado = (select auth.uid())));

create policy ubicacion_terminar on public.relma_muebles_ubicaciones
  for update to authenticated
  using (correo = lower((select auth.jwt() ->> 'email')) and not terminada)
  with check (correo = lower((select auth.jwt() ->> 'email')));

create policy catalogo_leer on public.relma_muebles_catalogos
  for select to authenticated
  using (exists (select 1 from public.relma_muebles_inventarios i where i.id = inventario and i.encargado = (select auth.uid()))
      or exists (select 1 from public.relma_muebles_ubicaciones u where u.inventario = relma_muebles_catalogos.inventario
        and u.correo = lower((select auth.jwt() ->> 'email'))));

create policy catalogo_crear on public.relma_muebles_catalogos
  for insert to authenticated
  with check (exists (select 1 from public.relma_muebles_inventarios i where i.id = inventario and i.encargado = (select auth.uid())));

create policy captura_leer on public.relma_muebles_capturas
  for select to authenticated
  using (exists (
    select 1 from public.relma_muebles_ubicaciones u where u.id = ubicacion
      and (u.correo = lower((select auth.jwt() ->> 'email')) or exists (
        select 1 from public.relma_muebles_inventarios i
          where i.id = u.inventario and i.encargado = (select auth.uid())
      ))
  ));

create policy captura_insertar on public.relma_muebles_capturas
  for insert to authenticated
  with check (exists (select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.correo = lower((select auth.jwt() ->> 'email'))));

create policy captura_corregir on public.relma_muebles_capturas
  for update to authenticated
  using (exists (select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.correo = lower((select auth.jwt() ->> 'email'))))
  with check (exists (select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.correo = lower((select auth.jwt() ->> 'email'))));

create policy operacion_leer on public.relma_muebles_operaciones
  for select to authenticated
  using (exists (select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and u.correo = lower((select auth.jwt() ->> 'email'))));

create policy operacion_insertar on public.relma_muebles_operaciones
  for insert to authenticated
  with check (exists (select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.correo = lower((select auth.jwt() ->> 'email'))));

create function public.relma_muebles_iniciar(
  p_id uuid, p_sucursal text, p_nombre text, p_base jsonb, p_productos jsonb
)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  insert into public.relma_muebles_inventarios (id, encargado, sucursal, nombre, referencia)
    values (p_id, (select auth.uid()), p_sucursal, p_nombre, p_base);
  insert into public.relma_muebles_catalogos (inventario, productos) values (p_id, p_productos);
end;
$$;

create function public.relma_muebles_guardar(
  p_ubicacion uuid, p_id uuid, p_sku text, p_descripcion text, p_cantidad integer, p_anterior integer default null
)
returns integer language plpgsql security invoker set search_path = ''
as $$
declare total integer;
begin
  if p_cantidad is null or p_cantidad < 0 or (p_anterior is null and p_cantidad <> 1) then
    raise exception 'Cantidad inválida';
  end if;

  if exists (select 1 from public.relma_muebles_operaciones where ubicacion = p_ubicacion and id = p_id) then
    return (select cantidad from public.relma_muebles_capturas where ubicacion = p_ubicacion and sku = p_sku);
  end if;

  perform 1 from public.relma_muebles_ubicaciones
    where id = p_ubicacion and correo = lower((select auth.jwt() ->> 'email')) and not terminada
    for update;
  if not found then raise exception 'El mueble está cerrado o el enlace no tiene acceso'; end if;

  insert into public.relma_muebles_operaciones (ubicacion, id)
    values (p_ubicacion, p_id) on conflict do nothing;
  if not found then
    return (select cantidad from public.relma_muebles_capturas where ubicacion = p_ubicacion and sku = p_sku);
  end if;

  if p_anterior is null then
    insert into public.relma_muebles_capturas as c (ubicacion, sku, descripcion, cantidad)
      values (p_ubicacion, p_sku, p_descripcion, 1)
      on conflict (ubicacion, sku) do update set cantidad = c.cantidad + 1, actualizado = now()
      returning cantidad into total;
  else
    insert into public.relma_muebles_capturas as c (ubicacion, sku, descripcion, cantidad)
      select p_ubicacion, p_sku, p_descripcion, p_cantidad
      where p_anterior = 0 or exists (
        select 1 from public.relma_muebles_capturas where ubicacion = p_ubicacion and sku = p_sku and cantidad = p_anterior
      )
      on conflict (ubicacion, sku) do update set cantidad = p_cantidad, actualizado = now()
      where c.cantidad = p_anterior
      returning cantidad into total;
    if not found then raise exception 'El conteo cambió. Actualiza el mueble e inténtalo otra vez'; end if;
  end if;
  return total;
end;
$$;

revoke all on function public.relma_muebles_iniciar(uuid, text, text, jsonb, jsonb),
  public.relma_muebles_guardar(uuid, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.relma_muebles_iniciar(uuid, text, text, jsonb, jsonb),
  public.relma_muebles_guardar(uuid, uuid, text, text, integer, integer) to authenticated;
