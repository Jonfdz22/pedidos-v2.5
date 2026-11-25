alter table public.relma_muebles_inventarios
  add column estado text not null default 'abierta' check (estado in ('abierta','cerrada','archivada'));

alter table public.relma_muebles_ubicaciones
  add column estado_sesion text not null default 'abierta' check (estado_sesion in ('abierta','cerrada','archivada'));

grant update (estado) on public.relma_muebles_inventarios to authenticated;
grant update (estado_sesion) on public.relma_muebles_ubicaciones to authenticated;

alter policy ubicacion_leer on public.relma_muebles_ubicaciones
  using (
    (estado_sesion <> 'archivada' and correo = lower((select auth.jwt() ->> 'email')))
    or exists (
      select 1 from public.relma_muebles_inventarios i
      where i.id = inventario and i.encargado = (select auth.uid())
    )
  );

alter policy ubicacion_asignar on public.relma_muebles_ubicaciones
  with check (exists (
    select 1 from public.relma_muebles_inventarios i
    where i.id = inventario and i.encargado = (select auth.uid()) and i.estado = 'abierta'
  ) and estado_sesion = 'abierta');

alter policy ubicacion_terminar on public.relma_muebles_ubicaciones
  using (correo = lower((select auth.jwt() ->> 'email')) and not terminada and estado_sesion = 'abierta')
  with check (correo = lower((select auth.jwt() ->> 'email')) and estado_sesion = 'abierta');

create policy ubicacion_administrar_estado on public.relma_muebles_ubicaciones
  for update to authenticated
  using (exists (
    select 1 from public.relma_muebles_inventarios i
    where i.id = inventario and i.encargado = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.relma_muebles_inventarios i
    where i.id = inventario and i.encargado = (select auth.uid()) and i.estado = estado_sesion
  ));

alter policy captura_insertar on public.relma_muebles_capturas
  with check (exists (
    select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.estado_sesion = 'abierta'
      and u.correo = lower((select auth.jwt() ->> 'email'))
  ));

alter policy captura_corregir on public.relma_muebles_capturas
  using (exists (
    select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.estado_sesion = 'abierta'
      and u.correo = lower((select auth.jwt() ->> 'email'))
  ))
  with check (exists (
    select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.estado_sesion = 'abierta'
      and u.correo = lower((select auth.jwt() ->> 'email'))
  ));

alter policy operacion_insertar on public.relma_muebles_operaciones
  with check (exists (
    select 1 from public.relma_muebles_ubicaciones u
    where u.id = ubicacion and not u.terminada and u.estado_sesion = 'abierta'
      and u.correo = lower((select auth.jwt() ->> 'email'))
  ));

create function public.relma_muebles_validar_asignacion()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  perform 1 from public.relma_muebles_inventarios
    where id = new.inventario and encargado = (select auth.uid()) and estado = 'abierta' for update;
  if not found then raise exception 'La sesión está cerrada o no tienes permiso'; end if;
  return new;
end;
$$;

create trigger relma_muebles_validar_asignacion
  before insert on public.relma_muebles_ubicaciones
  for each row execute function public.relma_muebles_validar_asignacion();

create function public.relma_muebles_propagar_estado()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if (old.estado = 'archivada' and new.estado <> old.estado)
     or (old.estado = 'cerrada' and new.estado = 'abierta') then
    raise exception 'Transición de sesión no disponible';
  end if;
  update public.relma_muebles_ubicaciones set estado_sesion = new.estado where inventario = new.id;
  return new;
end;
$$;

create trigger relma_muebles_propagar_estado
  after update of estado on public.relma_muebles_inventarios
  for each row when (old.estado is distinct from new.estado)
  execute function public.relma_muebles_propagar_estado();

revoke all on function public.relma_muebles_validar_asignacion(),
  public.relma_muebles_propagar_estado() from public, anon, authenticated;