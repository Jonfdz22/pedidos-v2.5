(() => {
  'use strict';

  const tablas = {
    inventarios: 'relma_muebles_inventarios',
    catalogos: 'relma_muebles_catalogos',
    ubicaciones: 'relma_muebles_ubicaciones',
    capturas: 'relma_muebles_capturas'
  };
  const id = () => crypto.randomUUID();
  const $ = selector => document.querySelector(selector);
  const formatoId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  let acceso;
  let cliente;
  let inventario;
  let ubicaciones = [];
  let ubicacion;
  let catalogo = [];
  let capturas = [];
  let guardando = false;

  function conectar() {
    if (!window.supabase || !configSupabase.url || !configSupabase.key) {
      throw new Error('La conexión con Supabase no está disponible.');
    }
    return window.supabase.createClient(configSupabase.url, configSupabase.key, {
      auth: {storageKey: 'fc_muebles_cuenta', flowType: 'pkce'}
    });
  }

  function contenedorActual() {
    return acceso === 'trabajador' ? $('#mueblesTrabajo') : $('#mueblesAdminContenido');
  }

  async function comprobarCuenta() {
    const {data, error} = await cliente.auth.getUser();
    if (data?.user && !error) return true;
    contenedorActual().innerHTML = `
      <p>Para entrar a este inventario, verifica tu correo. Usa el correo asignado a tus muebles.</p>
      <form id="mueblesIdentificar" class="muebles-form">
        <label>Correo electrónico <input name="correo" type="email" required autocomplete="email"></label>
        <button class="verde">Enviar enlace de acceso</button>
      </form>`;
    return false;
  }

  async function enviarAcceso(formulario) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    if (acceso === 'trabajador') url.searchParams.set('muebles', inventario.id);
    else url.searchParams.set('muebles-admin', '1');
    const {error} = await cliente.auth.signInWithOtp({
      email: formulario.correo.value.trim().toLowerCase(),
      options: {emailRedirectTo: url.href}
    });
    if (error) throw error;
    if (acceso === 'trabajador') mostrarMensaje('Revisa tu correo y abre el enlace en este navegador.');
    else toast('Revisa tu correo y abre el enlace en este navegador.');
  }

  async function datos(consulta) {
    const {data, error} = await consulta;
    if (error) throw new Error(error.code === '23505' ? 'Ya existe un mueble o área con ese nombre.' : error.message);
    return data;
  }

  function html(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function existePermisoLocal() {
    return !!usuarios[usuarioLogueado]?.permisos?.ajustes;
  }

  function mostrarMensaje(texto) {
    const nodo = $('#mueblesMensaje');
    if (nodo) nodo.textContent = texto;
  }

  async function iniciarEncargado() {
    if (!existePermisoLocal()) return;
    acceso = 'encargado';
    cliente ||= conectar();
    if (await comprobarCuenta()) await listaInventarios();
  }

  async function listaInventarios() {
    inventario = null;
    ubicaciones = [];
    ubicacion = null;
    const filas = await datos(cliente.from(tablas.inventarios)
      .select('id,nombre,creado,estado').eq('sucursal', sucursalActual).neq('estado','archivada').order('creado', {ascending: false}));
    $('#mueblesAdminContenido').innerHTML = `
      <form id="mueblesCrear" class="muebles-form">
        <label>Nombre del inventario <input name="nombre" required maxlength="120" placeholder="Inventario de noviembre"></label>
        <button class="verde">Crear inventario por muebles</button>
      </form>
      ${filas.map(fila => `<button class="gris muebles-item" data-inventario="${fila.id}">${html(fila.nombre)} · ${fila.estado === "cerrada" ? "Cerrada" : "Abierta"}</button>`).join('')}`;
  }

  async function crearInventario(formulario) {
    if (!inventarioBase.length) throw new Error('Primero carga el Excel en «1 · Cargar inventario del sistema».');
    const nombre = formulario.nombre.value.trim();
    if (!nombre) throw new Error('Escribe un nombre para el inventario.');
    const vinculados = new Map();
    for (const [codigo, enlaces] of Object.entries(vinculos)) {
      for (const enlace of (Array.isArray(enlaces) ? enlaces : [enlaces])) {
        const sku = String(typeof enlace === 'string' ? enlace : enlace?.sku || '').toUpperCase();
        const codigos = vinculados.get(sku) || [];
        codigos.push(codigo.toUpperCase());
        vinculados.set(sku, codigos);
      }
    }
    const base = inventarioBase.map(p => ({
      sku: String(p.sku).toUpperCase(), descripcion: String(p.descripcion || '').slice(0,200), esperado: Number(p.exis) || 0
    }));
    const productos = base.map(({sku, descripcion}) => ({sku, descripcion, codigos: vinculados.get(sku) || []}));
    const nuevo = id();
    await datos(cliente.rpc('relma_muebles_iniciar', {
      p_id: nuevo, p_sucursal: sucursalActual,
      p_nombre: nombre, p_base: base, p_productos: productos
    }));
    await abrirInventario(nuevo);
  }

  async function abrirInventario(inventarioId) {
    inventario = await datos(cliente.from(tablas.inventarios)
      .select('id,nombre,referencia,estado').neq('estado','archivada').eq('id', inventarioId).eq('sucursal', sucursalActual).single());
    await actualizarUbicaciones();
  }

  async function actualizarUbicaciones() {
    ubicaciones = await datos(cliente.from(tablas.ubicaciones)
      .select('id,nombre,persona,correo,terminada,estado_sesion').eq('inventario', inventario.id).order('nombre'));
    const contenedor = acceso === 'encargado' ? $('#mueblesAdminContenido') : $('#mueblesTrabajo');
    if (acceso === 'trabajador') {
      contenedor.innerHTML = ubicaciones.length ? ubicaciones.map(area => `<button class="gris muebles-item" data-area="${area.id}">${html(area.nombre)} · ${area.estado_sesion === 'cerrada' ? 'Sesión cerrada' : area.terminada ? 'Terminado' : 'Abrir'}</button>`).join('')
        : '<p>Este enlace no tiene muebles asignados.</p>';
      return;
    }
    const personas = Object.entries(usuarios).filter(([, u]) =>
      u?.permisos?.inventario && (u.permisos.ajustes || u.sucursalesPermitidas?.includes(sucursalActual)));
    contenedor.innerHTML = `
      <div class="fila muebles-acciones"><button class="gris" data-muebles-accion="lista">Volver</button><button class="gris" data-muebles-accion="actualizar">Actualizar avance</button></div>
      <h4>${html(inventario.nombre)}</h4>
      <p>${ubicaciones.filter(a => a.terminada).length} de ${ubicaciones.length} ubicaciones terminadas</p>
      ${inventario.estado === 'abierta' ? `<form id="mueblesAsignar" class="muebles-form">
        <label>Mueble o área <input name="nombre" required maxlength="120" placeholder="Bodega · Estante A"></label>
        <label>Responsable <select name="persona" required>${personas.map(([clave,u]) => `<option value="${html(clave)}">${html(u.nombre || clave)}</option>`).join('')}</select></label>
        <label>Correo del responsable <input name="correo" type="email" required maxlength="254"></label>
        <button class="verde">Asignar mueble</button>
      </form>` : ''}
      ${ubicaciones.map(a => `<div class="muebles-asignacion"><span><strong>${html(a.nombre)}</strong> · ${html(usuarios[a.persona]?.nombre || a.persona)}<br><small>${a.terminada ? 'Terminado' : 'Pendiente'}</small></span><button class="gris" data-enlace="1">Ver enlace</button></div>`).join('')}
      ${ubicaciones.length ? '<button class="verde muebles-item" data-muebles-accion="exportar">Exportar conteo a Excel</button>' : ''}
      <div class="fila muebles-acciones">
        ${inventario.estado === 'abierta' ? '<button class="gris" data-muebles-accion="cerrar-sesion">Cerrar sesión</button>' : ''}
        <button class="rojo" data-muebles-accion="eliminar-sesion">Eliminar sesión</button>
      </div>`;
  }

  async function asignar(formulario) {
    const persona = formulario.persona.value;
    const nombre = formulario.nombre.value.trim();
    if (!nombre) throw new Error('Escribe el nombre del mueble o área.');
    const correo = formulario.correo.value.trim().toLowerCase();
    await datos(cliente.from(tablas.ubicaciones).insert({
      id: id(), inventario: inventario.id, nombre, persona, correo
    }));
    await actualizarUbicaciones();
  }

  function verEnlace() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('muebles', inventario.id);
    const dialogo = $('#mueblesCompartir');
    dialogo.querySelector('input').value = url.href;
    dialogo.showModal();
  }

  async function abrirEnlace(inventarioId) {
    if (!formatoId.test(inventarioId)) return;
    acceso = 'trabajador';
    inventario = {id: inventarioId};
    document.documentElement.classList.add('muebles-enlace');
    $('#mueblesExterno').hidden = false;
    cliente ||= conectar();
    if (!(await comprobarCuenta())) return;
    await actualizarUbicaciones();
    if (ubicaciones.length) {
      const fila = await datos(cliente.from(tablas.catalogos).select('productos').eq('inventario', inventario.id).single());
      catalogo = fila.productos;
    }
  }

  async function cargarCapturas(ubicacionId) {
    const total = [];
    for (let pagina = 0; ; pagina += 500) {
      const filas = await datos(cliente.from(tablas.capturas).select('sku,descripcion,cantidad')
        .eq('ubicacion', ubicacionId).order('sku').range(pagina, pagina + 499));
      total.push(...filas);
      if (filas.length < 500) return total;
    }
  }

  async function abrirUbicacion(areaId) {
    ubicacion = ubicaciones.find(area => area.id === areaId);
    if (!ubicacion) return;
    capturas = await cargarCapturas(areaId);
    mostrarUbicacion();
  }

  function mostrarUbicacion() {
    const cerrada = ubicacion.estado_sesion !== 'abierta';
    $('#mueblesTrabajo').innerHTML = `
      <button class="gris" data-muebles-accion="mis-muebles">Mis muebles</button>
      <h2>${html(ubicacion.nombre)}</h2>
      ${cerrada ? '<p>La sesión está cerrada. Puedes revisar tus capturas.</p>' : ubicacion.terminada ? '<p>Mueble terminado.</p>' : `
      <button class="verde muebles-item" data-muebles-accion="camara">📷 Escanear</button>
      <form id="mueblesManual" class="muebles-form">
        <label>SKU o código <input name="codigo" required maxlength="120"></label>
        <label>Cantidad total en este mueble <input name="cantidad" required type="number" min="0" max="10000000" step="1"></label>
        <button class="gris">Guardar cantidad</button>
      </form>`}
      <ul id="mueblesDetalle"></ul>
      ${cerrada || ubicacion.terminada ? '' : '<button class="verde muebles-item" data-muebles-accion="terminar">Terminar mueble</button>'}`;
    mostrarCapturas();
  }

  function mostrarCapturas() {
    const lista = $('#mueblesDetalle');
    if (!lista) return;
    lista.innerHTML = capturas.map(p => `<li><strong>${html(p.cantidad)}</strong> · ${html(p.descripcion || p.sku)} <small>${html(p.sku)}</small></li>`).join('');
  }

  function resolverProducto(codigo) {
    const clave = codigo.trim().toUpperCase();
    if (!clave) throw new Error('Ingresa un código o SKU.');
    const sku = catalogo.find(p => p.sku === clave);
    if (sku) return sku;
    const opciones = catalogo.filter(p => p.codigos?.includes(clave));
    if (opciones.length === 1) return opciones[0];
    if (opciones.length > 1) throw new Error('Código con varias coincidencias. Captura el SKU.');
    return null;
  }

  async function guardar(producto, cantidad, anterior) {
    if (guardando) throw new Error('Espera a que termine la última captura.');
    guardando = true;
    const areaId = ubicacion.id;
    const operacion = {
      p_ubicacion: areaId, p_id: id(), p_sku: producto.sku,
      p_descripcion: producto.descripcion, p_cantidad: cantidad, p_anterior: anterior
    };
    try {
      let total;
      try {
        total = await datos(cliente.rpc('relma_muebles_guardar', operacion));
      } catch (error) {
        if (!/fetch|network|timeout|failed/i.test(error.message)) throw error;
        total = await datos(cliente.rpc('relma_muebles_guardar', operacion));
      }
      if (!Number.isInteger(total)) throw new Error('La captura no pudo confirmarse.');
      if (ubicacion?.id === areaId) {
        capturas = [...capturas.filter(p => p.sku !== producto.sku), {...producto, cantidad: total}];
        mostrarCapturas();
      }
      return total;
    } finally {
      guardando = false;
    }
  }

  async function capturarManual(formulario) {
    const codigo = formulario.codigo.value.trim().toUpperCase();
    let producto = resolverProducto(codigo);
    if (!producto) {
      const nombre = prompt('Producto fuera del Excel. Escribe su nombre para marcarlo en el reporte.');
      if (!nombre?.trim()) return;
      producto = {sku: codigo, descripcion: nombre.trim().slice(0,200)};
    }
    const anterior = capturas.find(p => p.sku === producto.sku)?.cantidad || 0;
    try {
      const total = await guardar(producto, formulario.cantidad.valueAsNumber, anterior);
      mostrarMensaje(`Guardado · ${producto.descripcion || producto.sku} · ${total} piezas`);
      formulario.reset();
    } catch (error) {
      capturas = await cargarCapturas(ubicacion.id).catch(() => capturas);
      mostrarCapturas();
      throw error;
    }
  }

  async function escanear(codigo) {
    try {
      const producto = resolverProducto(codigo);
      if (!producto) throw new Error('Código fuera del Excel. Puedes capturarlo manualmente.');
      const total = await guardar(producto, 1, null);
      confirmarEscaneoVisual(true, `+1 ${producto.descripcion || producto.sku} · ${total} en ${ubicacion.nombre}`);
    } catch (error) {
      confirmarEscaneoVisual(false, error.message);
    }
  }

  async function terminar() {
    if (guardando) throw new Error('Espera a que termine la captura.');
    if (!confirm('¿Marcar este mueble como terminado?')) return;
    guardando = true;
    try {
      await datos(cliente.from(tablas.ubicaciones).update({terminada: true})
        .eq('id', ubicacion.id).select('id').single());
      ubicacion = null;
      await actualizarUbicaciones();
    } finally { guardando = false; }
  }

  async function cambiarEstadoSesion(estado) {
    if (!existePermisoLocal() || acceso !== 'encargado' || !inventario) return;
    const actual = inventario;
    const pendientes = ubicaciones.filter(area => !area.terminada).length;
    const mensaje = estado === 'cerrada'
      ? `¿Cerrar «${actual.nombre}»? ${pendientes ? 'Muebles pendientes: ' + pendientes + '. ' : ''}Se bloquearán las capturas y podrás exportar el reporte.`
      : `¿Eliminar «${actual.nombre}» de la lista? Se cerrará el acceso a sus muebles y las capturas quedarán archivadas.`;
    if (!confirm(mensaje)) return;
    await datos(cliente.from(tablas.inventarios).update({estado}).eq('id', actual.id)
      .eq('estado', actual.estado).select('id').single());
    if (estado === 'archivada') await listaInventarios();
    else await abrirInventario(actual.id);
    toast(estado === 'cerrada' ? 'Sesión cerrada.' : 'Sesión eliminada de la lista.');
  }

  async function exportar() {
    if (!window.XLSX) throw new Error('No se cargó el exportador de Excel.');
    const filas = await Promise.all(ubicaciones.map(async a =>
      (await cargarCapturas(a.id)).map(p => ({...p, area:a.nombre, persona:a.persona}))));
    const detalle = filas.flat();
    const totales = new Map();
    for (const p of detalle) {
      const anterior = totales.get(p.sku);
      totales.set(p.sku, {descripcion:p.descripcion, cantidad:(anterior?.cantidad || 0) + p.cantidad});
    }
    const completo = ubicaciones.every(a => a.terminada);
    const estadoReporte = completo ? 'CONTEO TERMINADO' : inventario.estado === 'cerrada' ? 'CERRADA CON MUEBLES PENDIENTES' : 'PRELIMINAR';
    const resumen = inventario.referencia.map(p => {
      const cuenta = totales.get(p.sku)?.cantidad ?? (completo ? 0 : null);
      totales.delete(p.sku);
      return [p.sku, p.descripcion, p.esperado, cuenta, cuenta === null ? null : cuenta - p.esperado, ''];
    });
    for (const [sku,p] of totales) resumen.push([sku,p.descripcion,null,p.cantidad,null,'Fuera del Excel']);
    const wb = XLSX.utils.book_new();
    for (const [nombre, filas] of [
      ['Resumen', [[estadoReporte], ['SKU','Producto','Esperado','Contado','Diferencia','Revisión'], ...resumen]],
      ['Por mueble', [['Mueble o área','Responsable','SKU','Producto','Cantidad'], ...detalle.map(p => [p.area,p.persona,p.sku,p.descripcion,p.cantidad])]],
      ['Avance', [['Mueble o área','Responsable','Estado'], ...ubicaciones.map(a => [a.nombre,a.persona,a.terminada?'Terminado':'Pendiente'])]]
    ]) XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(filas),nombre);
    XLSX.writeFile(wb,`Conteo-por-muebles${completo?'':'-preliminar'}.xlsx`);
  }

  async function operar(boton, operacion) {
    if (boton?.disabled) return;
    if (boton) boton.disabled = true;
    try { await operacion(); }
    catch (error) {
      if (acceso === 'trabajador') mostrarMensaje(error.message);
      else toast(error.message, 'error');
    } finally { if (boton) boton.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const panel = $('#invPanelMuebles');
    panel.addEventListener('toggle', () => {
      if (panel.open && !document.documentElement.classList.contains('muebles-enlace')) operar(null, iniciarEncargado);
    });
    const vigilante = new MutationObserver(() => {
      panel.hidden = !existePermisoLocal();
      if (panel.open && panel.hidden) panel.open = false;
    });
    vigilante.observe($('#pestanaInventario'), {attributes:true, attributeFilter:['style']});
    panel.hidden = !existePermisoLocal();
    const refrescar = $('#mueblesActualizarExterno');
    refrescar.addEventListener('click', () => operar(refrescar, () => {
      if (!guardando) { ubicacion = null; return abrirEnlace(inventario.id); }
    }));
    document.addEventListener('click', evento => {
      const boton = evento.target.closest('button');
      if (!boton) return;
      const {inventario: destino, area, enlace, mueblesAccion} = boton.dataset;
      if (destino) operar(boton, () => abrirInventario(destino));
      if (area) operar(boton, () => abrirUbicacion(area));
      if (enlace) verEnlace();
      const accion = {
        lista: listaInventarios, actualizar: actualizarUbicaciones,
        'mis-muebles': () => { if (!guardando) { ubicacion = null; return actualizarUbicaciones(); } }, camara: () => abrirCamara('muebles'),
        'cerrar-sesion': () => cambiarEstadoSesion('cerrada'),
        'eliminar-sesion': () => cambiarEstadoSesion('archivada'),
        terminar, exportar
      }[mueblesAccion];
      if (accion) operar(boton, accion);
    });
    document.addEventListener('submit', evento => {
      const formulario = evento.target;
      const accion = {mueblesCrear: crearInventario, mueblesAsignar: asignar, mueblesManual: capturarManual, mueblesIdentificar: enviarAcceso}[formulario.id];
      if (!accion) return;
      evento.preventDefault();
      operar(formulario.querySelector('button'), () => accion(formulario));
    });
    const parametros = new URLSearchParams(location.search);
    const enlace = parametros.get('muebles');
    if (enlace) operar(null, () => abrirEnlace(enlace));
    else if (parametros.has('muebles-admin') && existePermisoLocal()) {
      cambiarPestana('inventario');
      panel.open = true;
    }
  });

  window.conteoMuebles = {
    escanear,
    ocupada: () => guardando,
    nombre: () => ubicacion?.nombre || '',
    error: texto => confirmarEscaneoVisual(false, texto)
  };
})();
