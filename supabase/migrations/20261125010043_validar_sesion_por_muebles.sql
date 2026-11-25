create function public.relma_validar_captura_mueble()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare
  sesion_estado text;
  configuracion jsonb;
  lugar_id text;
  operacion text;
begin
  if coalesce(new.dispositivo, '') not like 'mueble:%' then
    return new;
  end if;

  select estado, asignaciones -> '_relma_muebles'
    into sesion_estado, configuracion
    from public.sesiones_conteo where id = new.sesion_id for share;
  if not found or sesion_estado <> 'abierta'
    or configuracion is null or coalesce(configuracion ->> 'archivada', 'false') = 'true' then
    raise exception 'La sesión por muebles ya no está abierta.';
  end if;

  lugar_id := split_part(new.dispositivo, ':', 2);
  operacion := split_part(new.dispositivo, ':', 3);
  if operacion not in ('sumar', 'fijar') or new.cantidad is null or new.cantidad not between 0 and 10000000
    or (operacion = 'sumar' and new.cantidad <> 1) then
    raise exception 'La captura por mueble no es válida.';
  end if;

  if not exists (
    select 1 from jsonb_array_elements(configuracion -> 'lugares') lugar
     where lugar ->> 'id' = lugar_id and lugar ->> 'usuario' = new.usuario
       and coalesce(lugar ->> 'terminado', 'false') <> 'true'
  ) then
    raise exception 'El mueble está terminado o no está asignado a este usuario.';
  end if;

  return new;
end;
$$;

create trigger relma_validar_captura_mueble
  before insert on public.conteos_individuales
  for each row execute function public.relma_validar_captura_mueble();

revoke all on function public.relma_validar_captura_mueble() from public, anon, authenticated;
