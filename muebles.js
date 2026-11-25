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
    if (acceso !== 'trabajador') return $('#mueblesAdminContenido');
    return $('#mueblesTrabajoEnApp');
  }

  async function comprobarCuenta() {
    const {data, error} = await cliente.auth.getUser();
    if (data?.user && !error) return true;
    contenedorActual().innerHTML = '<p>Tu usuario de FC‑Relma todavía no está habilitado para conteo por muebles.</p>';
    return false;
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
      .select('id,nombre,creado').eq('sucursal', sucursalActual).order('creado', {ascending: false}));
    $('#mueblesAdminContenido').innerHTML = `
      <form id="mueblesCrear" class="muebles-form">
        <label>Nombre del inventario <input name="nombre" required maxlength="120" placeholder="Inventario de noviembre"></label>
        <button class="verde">Crear inventario por muebles</button>
      </form>
      ${filas.map(fila => `<button class="gris muebles-item" data-inventario="${fila.id}">${html(fila.nombre)}</button>`).join('')}`;
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
      .select('id,nombre,referencia').eq('id', inventarioId).eq('sucursal', sucursalActual).single());
    await actualizarUbicaciones();
  }

  async function actualizarUbicaciones() {
    ubicaciones = await datos(cliente.from(tablas.ubicaciones)
      .select('id,nombre,persona,correo,terminada').eq('inventario', inventario.id).order('nombre'));
    if (acceso === 'trabajador') ubicaciones = ubicaciones.filter(area => area.persona === usuarioLogueado);
    const contenedor = contenedorActual();
    if (acceso === 'trabajador') {
      contenedor.innerHTML = '<button class="gris" data-muebles-accion="ver-sesiones">Mis sesiones</button>' + (ubicaciones.length ? ubicaciones.map(area => `<button class="gris muebles-item" data-area="${area.id}">${html(area.nombre)} · ${area.terminada ? 'Terminado' : 'Abrir'}</button>`).join('')
        : '<p>No tienes muebles asignados en esta sesión.</p>');
      return;
    }
    const personas = Object.entries(usuarios).filter(([, u]) =>
      u?.permisos?.inventario && (u.permisos.ajustes || u.sucursalesPermitidas?.includes(sucursalActual)));
    contenedor.innerHTML = `
      <div class="fila muebles-acciones"><button class="gris" data-muebles-accion="lista">Volver</button><button class="gris" data-muebles-accion="actualizar">Actualizar avance</button></div>
      <h4>${html(inventario.nombre)}</h4>
      <p>${ubicaciones.filter(a => a.terminada).length} de ${ubicaciones.length} ubicaciones terminadas</p>
      <form id="mueblesAsignar" class="muebles-form">
        <label>Mueble o área <input name="nombre" required maxlength="120" placeholder="Bodega · Estante A"></label>
        <label>Responsable <select name="persona" required>${personas.map(([clave,u]) => `<option value="${html(clave)}">${html(u.nombre || clave)}</option>`).join('')}</select></label>
        <label>Correo del responsable <input name="correo" type="email" required maxlength="254"></label>
        <button class="verde">Asignar mueble</button>
      </form>
      ${ubicaciones.map(a => `<div class="muebles-asignacion"><span><strong>${html(a.nombre)}</strong> · ${html(usuarios[a.persona]?.nombre || a.persona)}<br><small>${a.terminada ? 'Terminado' : 'Pendiente'}</small></span></div>`).join('')}
      ${ubicaciones.length ? '<button class="verde muebles-item" data-muebles-accion="exportar">Exportar conteo a Excel</button>' : ''}`;
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

  async function verSesionesAsignadas() {
    acceso = 'trabajador';
    inventario = null;
    ubicacion = null;
    cliente ||= conectar();
    if (!(await comprobarCuenta())) return;
    const filas = await datos(cliente.from(tablas.ubicaciones)
      .select('inventario,nombre').eq('persona', usuarioLogueado).order('nombre'));
    const sesiones = new Map();
    for (const fila of filas) {
      const muebles = sesiones.get(fila.inventario) || [];
      muebles.push(fila.nombre);
      sesiones.set(fila.inventario, muebles);
    }
    contenedorActual().innerHTML = sesiones.size
      ? [...sesiones].map(([id, muebles]) => `<div class="muebles-asignacion"><span>${html(muebles.join(', '))}</span><button class="verde" data-unirme="${id}">Unirse</button></div>`).join('')
      : '<p>Aún no tienes muebles asignados. Cuando un administrador te asigne uno, aparecerá aquí.</p>';
  }

  async function unirseInventario(inventarioId) {
    if (!formatoId.test(inventarioId) || guardando) return;
    const fila = await datos(cliente.from(tablas.catalogos).select('productos').eq('inventario', inventarioId).single());
    inventario = {id: inventarioId};
    catalogo = fila.productos;
    await actualizarUbicaciones();
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
    contenedorActual().innerHTML = `
      <button class="gris" data-muebles-accion="mis-muebles">Mis muebles</button>
      <h2>${html(ubicacion.nombre)}</h2>
      ${ubicacion.terminada ? '<p>Mueble terminado.</p>' : `
      <button class="verde muebles-item" data-muebles-accion="camara">📷 Escanear</button>
      <form id="mueblesManual" class="muebles-form">
        <label>SKU o código <input name="codigo" required maxlength="120"></label>
        <label>Cantidad total en este mueble <input name="cantidad" required type="number" min="0" max="10000000" step="1"></label>
        <button class="gris">Guardar cantidad</button>
      </form>`}
      <ul id="mueblesDetalle"></ul>
      ${ubicacion.terminada ? '' : '<button class="verde muebles-item" data-muebles-accion="terminar">Terminar mueble</button>'}`;
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
      toast(`Guardado · ${producto.descripcion || producto.sku} · ${total} piezas`);
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
    const resumen = inventario.referencia.map(p => {
      const cuenta = totales.get(p.sku)?.cantidad ?? (completo ? 0 : null);
      totales.delete(p.sku);
      return [p.sku, p.descripcion, p.esperado, cuenta, cuenta === null ? null : cuenta - p.esperado, ''];
    });
    for (const [sku,p] of totales) resumen.push([sku,p.descripcion,null,p.cantidad,null,'Fuera del Excel']);
    const wb = XLSX.utils.book_new();
    for (const [nombre, filas] of [
      ['Resumen', [[completo ? 'CONTEO TERMINADO' : 'PRELIMINAR'], ['SKU','Producto','Esperado','Contado','Diferencia','Revisión'], ...resumen]],
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
      toast(error.message, 'error');
    } finally { if (boton) boton.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const panel = $('#invPanelMuebles');
    function prepararPanel() {
      panel.hidden = !usuarios[usuarioLogueado]?.permisos?.inventario;
      if (panel.hidden) { panel.open = false; return; }
      if ($('#mueblesTrabajoEnApp')) return;
      $('#mueblesAdminContenido').insertAdjacentHTML('beforebegin',
        '<div class="fila muebles-acciones"><button class="verde" data-muebles-accion="ver-sesiones">Mis sesiones</button><button class="gris" id="mueblesAdministrar" data-muebles-accion="administrar">Administrar sesiones</button></div><div id="mueblesTrabajoEnApp"></div>');
    }
    panel.addEventListener('toggle', () => {
      if (!panel.open) return;
      prepararPanel();
      if (panel.hidden) return;
      $('#mueblesAdministrar').hidden = !existePermisoLocal();
      $('#mueblesAdminContenido').hidden = true;
      $('#mueblesTrabajoEnApp').hidden = false;
      operar(null, verSesionesAsignadas);
    });
    const vigilante = new MutationObserver(prepararPanel);
    vigilante.observe($('#pestanaInventario'), {attributes:true, attributeFilter:['style']});
    prepararPanel();
    document.addEventListener('click', evento => {
      const boton = evento.target.closest('button');
      if (!boton) return;
      const {inventario: destino, area, unirme, mueblesAccion} = boton.dataset;
      if (destino) operar(boton, () => abrirInventario(destino));
      if (area) operar(boton, () => abrirUbicacion(area));
      if (unirme) operar(boton, () => unirseInventario(unirme));
      const accion = {
        lista: listaInventarios, actualizar: actualizarUbicaciones,
        'ver-sesiones': () => {
          if (guardando) return;
          $('#mueblesAdminContenido').hidden = true;
          $('#mueblesTrabajoEnApp').hidden = false;
          return verSesionesAsignadas();
        },
        administrar: () => {
          if (!existePermisoLocal() || guardando) return;
          $('#mueblesAdminContenido').hidden = false;
          $('#mueblesTrabajoEnApp').hidden = true;
          return iniciarEncargado();
        },
        'mis-muebles': () => { if (!guardando) { ubicacion = null; return actualizarUbicaciones(); } }, camara: () => abrirCamara('muebles'),
        terminar, exportar
      }[mueblesAccion];
      if (accion) operar(boton, accion);
    });
    document.addEventListener('submit', evento => {
      const formulario = evento.target;
      const accion = {mueblesCrear: crearInventario, mueblesAsignar: asignar, mueblesManual: capturarManual}[formulario.id];
      if (!accion) return;
      evento.preventDefault();
      operar(formulario.querySelector('button'), () => accion(formulario));
    });
  });

  window.conteoMuebles = {
    escanear,
    ocupada: () => guardando,
    nombre: () => ubicacion?.nombre || '',
    error: texto => confirmarEscaneoVisual(false, texto)
  };
})();
