(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const marcador = '_relma_muebles';
  const prefijo = 'mueble:';
  const meta = sesion => sesion?.asignaciones?.[marcador];
  const lugares = sesion => meta(sesion)?.lugares || [];
  const esMuebles = sesion => Array.isArray(meta(sesion)?.lugares);
  const claves = new Set(['sumar', 'fijar']);
  const id = () => crypto.randomUUID();
  const normalizar = valor => String(valor ?? '').trim().toUpperCase();
  let activa = null;
  let lugarId = null;
  let piezas = new Map();
  let ocupada = false;
  let pendiente = null;

  function admin() { return _esAdminSesion(); }
  function cuenta() { return usuarios[usuarioLogueado]?.permisos?.inventario === true; }
  function propios(sesion) { return lugares(sesion).filter(m => m.usuario === usuarioLogueado); }

  async function datos(consulta) {
    if (!supabaseClient) throw new Error('La conexión del inventario no está disponible.');
    const {data, error} = await consulta;
    if (error) throw new Error(error.message);
    return data;
  }

  function elegibles(sucursal) {
    return Object.entries(usuarios).filter(([, perfil]) => perfil.aprobado !== false
      && perfil.permisos?.inventario && perfil.sucursalesPermitidas?.includes(sucursal));
  }

  function filaMueble() {
    const fila = document.createElement('div');
    fila.className = 'sesion-mueble-asignacion';
    fila.innerHTML = '<label>Mueble o área <input maxlength="100" placeholder="Bodega · Estante A"></label><label>Responsable <select></select></label><button class="rojo" type="button" data-sm="quitar-fila">Quitar</button>';
    $('sesionMueblesFilas').append(fila);
    opcionesResponsables();
  }

  function opcionesResponsables() {
    const opciones = elegibles($('sesionSucursal').value).map(([usuario, perfil]) =>
      `<option value="${esc(usuario)}">${esc(perfil.nombre || usuario)} · @${esc(usuario)}</option>`).join('');
    $('sesionMueblesFilas').querySelectorAll('select').forEach(select => {
      const anterior = select.value;
      select.innerHTML = '<option value="">Selecciona un usuario</option>' + opciones;
      if ([...select.options].some(opcion => opcion.value === anterior)) select.value = anterior;
    });
  }

  function modalidad() {
    const muebles = $('sesionModalidad').value === 'muebles';
    $('sesionMueblesConfiguracion').hidden = !muebles;
    $('sesionPaginasConfiguracion').hidden = muebles;
    if (muebles && !$('sesionMueblesFilas').children.length) filaMueble();
    else if (!muebles) void actualizarInfoPaginas();
  }

  function prepararModal() {
    $('sesionModalidad').value = 'paginas';
    $('sesionMueblesFilas').replaceChildren();
    $('sesionPaginasConfiguracion').hidden = false;
    $('sesionMueblesConfiguracion').hidden = true;
  }

  async function crear() {
    if (!admin() || !supabaseClient) return mostrarErrorSesion('Se requiere acceso de administrador y conexión.');
    const nombre = $('sesionNombre').value.trim();
    const sucursal = $('sesionSucursal').value;
    const base = inventariosPorSucursal[sucursal]?.base;
    if (!nombre || !base?.length) return mostrarErrorSesion('Escribe un nombre y carga el Excel de la sucursal.');
    const usuariosSucursal = new Set(elegibles(sucursal).map(([usuario]) => usuario));
    const nombres = new Set();
    const ubicaciones = [];
    for (const fila of $('sesionMueblesFilas').children) {
      const nombre = fila.querySelector('input').value.trim();
      const usuario = fila.querySelector('select').value;
      if (!nombre && !usuario) continue;
      if (!nombre || !usuariosSucursal.has(usuario)) return mostrarErrorSesion('Completa el nombre y el responsable de cada mueble.');
      if (nombres.has(normalizar(nombre))) return mostrarErrorSesion('Cada mueble debe tener un nombre diferente.');
      nombres.add(normalizar(nombre));
      ubicaciones.push({id: id(), nombre, usuario, terminado: false});
    }
    if (!ubicaciones.length) return mostrarErrorSesion('Agrega y asigna al menos un mueble.');
    const codigos = new Map();
    for (const codigo of Object.keys(vinculos)) {
      for (const producto of skusDeCodigo(codigo)) {
        const clave = normalizar(producto.sku);
        if (!codigos.has(clave)) codigos.set(clave, []);
        codigos.get(clave).push(normalizar(codigo));
      }
    }
    const snapshot = base.map(({sku,descripcion,exis}) => ({
      sku: normalizar(sku), descripcion: descripcion || '', exis: Number(exis) || 0, codigos: codigos.get(normalizar(sku)) || []
    }));
    try {
      await datos(supabaseClient.from('sesiones_conteo').insert({
        nombre, sucursal_id: sucursal, estado: 'borrador', creada_por: usuarioLogueado,
        asignaciones: {[marcador]: {lugares: ubicaciones}}, total_productos: snapshot.length,
        pagina_tamano: 200, snapshot_base: snapshot
      }));
      cerrarModalNuevaSesion();
      await cargarListaSesiones();
      toast('Sesión por muebles creada');
    } catch (error) {
      mostrarErrorSesion('No se pudo crear: ' + error.message);
    }
  }

  function boton(accion, texto, valor = '', clase = 'gris') {
    return `<button type="button" class="${clase}" data-sm="${accion}" data-valor="${esc(valor)}">${esc(texto)}</button>`;
  }

  function render() {
    const panel = $('sesionMueblesPanel');
    if (!panel) return;
    const visible = admin() || cuenta();
    const valida = activa && activa.sucursal_id === sucursalActual && propios(activa).length && cuenta();
    if (activa && !valida) salir();
    $('pestanaInventario').classList.toggle('sesion-mueble-activa', !!activa);
    if (!visible) { panel.replaceChildren(); return; }
    if (activa) { renderOperador(panel); return; }

    const sesiones = sesionesActuales.filter(s => s.sucursal_id === sucursalActual && esMuebles(s)
      && !meta(s).archivada && (admin() || (s.estado === 'abierta' && propios(s).length)));
    panel.innerHTML = '<h4>Sesiones por muebles</h4>' + boton('refrescar', 'Actualizar sesiones') + sesiones.map(s => {
      const estado = {borrador:'Borrador', abierta:'Abierta', cerrada:'Cerrada'}[s.estado];
      const controles = [];
      if (s.estado === 'abierta' && cuenta() && propios(s).length) controles.push(boton('unirse', 'Unirse', s.id, 'verde'));
      if (admin()) {
        if (s.estado === 'borrador') controles.push(boton('abrir', 'Abrir sesión', s.id, 'verde'));
        if (s.estado === 'abierta') controles.push(boton('cerrar', 'Cerrar sesión', s.id));
        controles.push(boton('reporte', 'Exportar Excel', s.id), boton('archivar', 'Eliminar sesión', s.id, 'rojo'));
      }
      return `<section class="sesion-mueble-tarjeta"><strong>${esc(s.nombre)}</strong>
        <p class="small">${esc(estado)} · ${lugares(s).filter(m => m.terminado).length}/${lugares(s).length} muebles terminados</p>
        ${admin() ? `<p class="small">${lugares(s).map(m => esc(m.nombre) + ' · @' + esc(m.usuario)).join('<br>')}</p>` : ''}
        <div class="sesion-mueble-botones">${controles.join('')}</div></section>`;
    }).join('');
  }

  function renderOperador(panel) {
    const lugar = propios(activa).find(m => m.id === lugarId);
    const lista = propios(activa).map(m => boton('seleccionar', m.nombre + (m.terminado ? ' · Terminado' : ''), m.id, lugarId === m.id ? 'verde' : 'gris'));
    const controles = !lugar || lugar.terminado || activa.estado !== 'abierta' ? '' : `
      <div class="sesion-mueble-botones">${boton('camara', 'Escanear en ' + lugar.nombre, '', 'camara')}${boton('terminar', 'Terminar mueble')}</div>
      <form id="sesionMuebleCaptura" class="sesion-mueble-asignacion">
        <label>SKU o código <input name="codigo" required autocomplete="off"></label>
        <label>Total en este mueble <input name="cantidad" type="number" min="0" max="10000000" step="1" required inputmode="numeric"></label>
        <button type="submit" class="verde">Guardar</button>
      </form>`;
    panel.innerHTML = `<h4>${esc(activa.nombre)} · Por muebles</h4>
      <p class="small">${activa.estado !== 'abierta' ? 'Sesión cerrada' : lugar ? 'Mueble seleccionado: ' + esc(lugar.nombre) : 'Elige el mueble que vas a contar.'}</p>
      <div class="sesion-mueble-botones">${lista.join('')}${boton('salir', 'Salir de la sesión')}</div>
      ${controles}<p id="sesionMuebleAviso" class="small" role="status"></p><ul id="sesionMueblePiezas"></ul>`;
    mostrarPiezas();
  }

  function mostrarPiezas() {
    const ul = $('sesionMueblePiezas');
    if (ul) ul.innerHTML = [...piezas.values()].map(p => `<li>${esc(p.cantidad)} · ${esc(p.descripcion || p.sku)} <small>${esc(p.sku)}</small></li>`).join('');
  }

  async function actual(idSesion) {
    return datos(supabaseClient.from('sesiones_conteo').select('*').eq('id', idSesion).eq('sucursal_id', sucursalActual).maybeSingle());
  }

  async function unirse(idSesion) {
    if (!cuenta()) return;
    if (sesionActivaUsuario) throw new Error('Primero sal de tu sesión por páginas.');
    const s = await actual(idSesion);
    if (!esMuebles(s) || s.estado !== 'abierta' || meta(s).archivada || !propios(s).length) throw new Error('La sesión ya no está abierta o no tienes un mueble asignado.');
    activa = s;
    lugarId = null;
    piezas.clear();
    render();
  }

  async function capturas(s, lugar) {
    const filas = [];
    for (let desde = 0; ; desde += 500) {
      let consulta = supabaseClient.from('conteos_individuales').select('id,sku,usuario,cantidad,dispositivo,timestamp')
        .eq('sesion_id', s.id).order('timestamp').order('id');
      if (lugar) consulta = consulta.in('dispositivo', ['sumar', 'fijar'].map(op => prefijo + lugar + ':' + op));
      const lote = await datos(consulta.range(desde, desde + 499));
      filas.push(...lote);
      if (lote.length < 500) return filas;
    }
  }

  function agrupar(s, filas) {
    const ubicaciones = new Map(lugares(s).map(m => [m.id, m]));
    const productos = new Map((s.snapshot_base || []).map(p => [p.sku, p]));
    const porLugar = new Map();
    for (const fila of filas) {
      const [etiqueta, ubicacion, operacion] = String(fila.dispositivo || '').split(':');
      const lugar = ubicaciones.get(ubicacion);
      if (etiqueta !== 'mueble' || !lugar || !claves.has(operacion)) continue;
      if (!porLugar.has(ubicacion)) porLugar.set(ubicacion, new Map());
      const items = porLugar.get(ubicacion);
      const previo = items.get(fila.sku)?.cantidad || 0;
      items.set(fila.sku, {
        sku: fila.sku, descripcion: productos.get(fila.sku)?.descripcion || '',
        cantidad: operacion === 'fijar' ? fila.cantidad : previo + fila.cantidad, usuario: fila.usuario
      });
    }
    return porLugar;
  }

  async function seleccionar(nuevo) {
    if (!activa || ocupada || pendiente) return;
    cerrarCamara();
    const s = await actual(activa.id);
    if (!esMuebles(s) || meta(s).archivada || !propios(s).some(m => m.id === nuevo)) throw new Error('El mueble ya no está asignado.');
    const filas = await capturas(s, nuevo);
    activa = s;
    lugarId = nuevo;
    piezas = agrupar(s, filas).get(nuevo) || new Map();
    render();
  }

  function producto(codigo, aceptarDesconocido) {
    const sku = normalizar(codigo);
    const base = activa?.snapshot_base || [];
    const exacto = base.find(p => p.sku === sku);
    if (exacto) return exacto;
    const vinculados = base.filter(p => p.codigos?.includes(sku));
    if (vinculados.length === 1) return vinculados[0];
    if (vinculados.length > 1) throw new Error('Código con varias coincidencias. Captura el SKU.');
    if (aceptarDesconocido && sku && sku.length <= 120) return {sku, descripcion: 'Fuera del Excel'};
    throw new Error('Código fuera del Excel. Puedes capturarlo manualmente.');
  }

  async function guardar(p, cantidad, operacion) {
    if (ocupada || !activa || !lugarId) throw new Error('Selecciona un mueble y espera a que termine la captura anterior.');
    if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > 10000000) throw new Error('Ingresa una cantidad válida.');
    ocupada = true;
    try {
      const s = activa;
      const lugar = propios(s).find(m => m.id === lugarId);
      if (s.estado !== 'abierta' || !lugar || lugar.terminado || !cuenta()) throw new Error('La sesión o el mueble ya están cerrados.');
      const clave = [s.id, lugarId, p.sku, operacion, cantidad].join('|');
      if (pendiente && pendiente.clave !== clave) throw new Error('Verifica la captura pendiente del SKU ' + pendiente.sku + ' antes de continuar.');
      const envio = {
        id: pendiente?.id || id(), sesion_id: s.id, usuario: usuarioLogueado, sku: p.sku,
        cantidad, dispositivo: prefijo + lugarId + ':' + operacion
      };
      try {
        await datos(supabaseClient.from('conteos_individuales').upsert(envio, {onConflict:'id', ignoreDuplicates:true}));
      } catch (error) {
        if (_esErrorRed(error)) {
          pendiente = {clave, id: envio.id, sku:p.sku};
          throw new Error('No se confirmó la captura. Repite el mismo código para verificar sin duplicarlo.');
        }
        pendiente = null;
        if (/sesión por muebles|mueble está terminado/i.test(error.message)) {
          const vigente = await actual(s.id).catch(() => null);
          if (vigente && !meta(vigente).archivada) { activa = vigente; render(); }
          else if (vigente) { salir(); render(); }
        }
        throw error;
      }
      pendiente = null;
      const total = operacion === 'fijar' ? cantidad : (piezas.get(p.sku)?.cantidad || 0) + cantidad;
      piezas.set(p.sku, {...p, cantidad: total});
      mostrarPiezas();
      return total;
    } finally { ocupada = false; }
  }

  async function escanear(codigo) {
    try {
      const p = producto(codigo, false);
      const total = await guardar(p, 1, 'sumar');
      confirmarEscaneoVisual(true, `+1 ${p.descripcion || p.sku} · ${total} en ${lugares(activa).find(m => m.id === lugarId)?.nombre || 'este mueble'}`);
    } catch (error) { confirmarEscaneoVisual(false, error.message); }
  }

  async function terminar() {
    if (!activa || !lugarId || ocupada || pendiente) throw new Error('Resuelve la captura pendiente antes de terminar.');
    if (!confirm('¿Marcar este mueble como terminado?')) return;
    const s = await actual(activa.id);
    if (s?.estado !== 'abierta' || !propios(s).some(m => m.id === lugarId)) throw new Error('El mueble ya no está disponible.');
    const asignaciones = {[marcador]: {...meta(s), lugares: lugares(s).map(m => m.id === lugarId ? {...m, terminado:true} : m)}};
    const guardado = await datos(supabaseClient.from('sesiones_conteo').update({asignaciones})
      .eq('id', s.id).eq('estado', 'abierta').eq('asignaciones', JSON.stringify(s.asignaciones)).select('*').maybeSingle());
    if (!guardado) throw new Error('La sesión cambió. Actualiza y vuelve a intentar.');
    activa = guardado;
    render();
  }

  async function cambiarEstado(idSesion, accion) {
    if (!admin()) return;
    const s = await actual(idSesion);
    if (!esMuebles(s) || meta(s).archivada) return;
    const faltan = lugares(s).filter(m => !m.terminado).length;
    const mensajes = {
      abrir: '¿Abrir la sesión para que los operadores puedan unirse?',
      cerrar: `¿Cerrar la sesión? ${faltan} muebles pendientes. Se detendrán las capturas.`,
      archivar: '¿Eliminar la sesión de la lista y archivar sus capturas?'
    };
    if ((accion === 'abrir' && s.estado !== 'borrador') || (accion === 'cerrar' && s.estado !== 'abierta')) return;
    if (!confirm(mensajes[accion])) return;
    const ahora = new Date().toISOString();
    const cambios = accion === 'abrir' ? {estado:'abierta', fecha_apertura:ahora}
      : {estado:'cerrada', fecha_cierre:s.fecha_cierre || ahora};
    if (accion === 'archivar') cambios.asignaciones = {[marcador]: {...meta(s), archivada:true}};
    const guardado = await datos(supabaseClient.from('sesiones_conteo').update(cambios).eq('id', s.id)
      .eq('estado',s.estado).eq('asignaciones',JSON.stringify(s.asignaciones)).select('id').maybeSingle());
    if (!guardado) throw new Error('La sesión cambió. Actualiza y vuelve a intentar.');
    await cargarListaSesiones();
  }

  async function exportar(idSesion) {
    if (!admin() || !window.XLSX) return;
    const s = await actual(idSesion);
    if (!esMuebles(s)) return;
    const porLugar = agrupar(s, await capturas(s));
    const resumen = new Map();
    const detalle = [];
    for (const m of lugares(s)) {
      for (const p of porLugar.get(m.id)?.values() || []) {
        detalle.push([m.nombre, p.usuario, p.sku, p.descripcion, p.cantidad]);
        resumen.set(p.sku, (resumen.get(p.sku) || 0) + p.cantidad);
      }
    }
    const terminado = lugares(s).every(m => m.terminado);
    const totales = (s.snapshot_base || []).map(p => {
      const contado = resumen.get(p.sku) ?? (terminado ? 0 : null);
      resumen.delete(p.sku);
      return [p.sku,p.descripcion,p.exis,contado,contado === null ? null : contado - p.exis,''];
    });
    for (const [sku,cantidad] of resumen) totales.push([sku,'',null,cantidad,null,'Fuera del Excel']);
    const wb = XLSX.utils.book_new();
    const hojas = [
      ['Resumen', [['Sesión',s.nombre], ['Estado',s.estado], ['Muebles pendientes',lugares(s).filter(m => !m.terminado).length], ['SKU','Producto','Sistema','Contado','Diferencia','Revisión'], ...totales]],
      ['Por mueble', [['Mueble','Operador','SKU','Producto','Piezas'], ...detalle]],
      ['Avance', [['Mueble','Asignado a','Terminado'], ...lugares(s).map(m => [m.nombre,m.usuario,m.terminado ? 'Sí' : 'No'])]]
    ];
    for (const [nombre,filas] of hojas) XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(filas),nombre);
    XLSX.writeFile(wb,'Conteo-por-muebles.xlsx');
  }

  function salir() {
    if (activa) cerrarCamara();
    activa = null;
    lugarId = null;
    pendiente = null;
    piezas.clear();
    $('pestanaInventario')?.classList.remove('sesion-mueble-activa');
  }

  async function ejecutar(control, tarea) {
    if (control.disabled) return;
    control.disabled = true;
    try { await tarea(); }
    catch (error) { toast(error.message || 'No se pudo completar la acción.', 'error'); }
    finally { control.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('sesionModalidad').addEventListener('change', modalidad);
    $('sesionSucursal').addEventListener('change', opcionesResponsables);
    $('invPanelSesion').addEventListener('toggle', () => {
      if ($('invPanelSesion').open) void cargarListaSesiones();
    });
    document.addEventListener('click', e => {
      const control = e.target.closest('button[data-sm]');
      if (!control) return;
      const {sm, valor} = control.dataset;
      const tareas = {
        refrescar: cargarListaSesiones, agregar: filaMueble, 'quitar-fila': () => control.closest('.sesion-mueble-asignacion').remove(),
        unirse: () => unirse(valor), seleccionar: () => seleccionar(valor),
        abrir: () => cambiarEstado(valor,'abrir'), cerrar: () => cambiarEstado(valor,'cerrar'),
        archivar: () => cambiarEstado(valor,'archivar'), reporte: () => exportar(valor),
        salir: () => { if (ocupada || pendiente) throw new Error('Resuelve la última captura antes de salir.'); salir(); render(); },
        camara: () => abrirCamara('muebles'), terminar
      };
      if (tareas[sm]) void ejecutar(control,tareas[sm]);
    });
    document.addEventListener('submit', e => {
      if (e.target.id !== 'sesionMuebleCaptura') return;
      e.preventDefault();
      const form = e.target;
      void ejecutar(form.querySelector('button'), async () => {
        const p = producto(form.elements.codigo.value, true);
        const total = await guardar(p,form.elements.cantidad.valueAsNumber,'fijar');
        $('sesionMuebleAviso').textContent = `Guardado · ${p.sku} · ${total} piezas`;
        form.reset();
        form.elements.codigo.focus();
      });
    });
  });

  window.sesionesMueble = {esMuebles, render, prepararModal, crear, salir,
    activa: () => !!activa, escanear, ocupada: () => ocupada,
    nombre: () => lugares(activa).find(m => m.id === lugarId)?.nombre || '',
    error: mensaje => confirmarEscaneoVisual(false,mensaje)};
})();
