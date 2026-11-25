(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const marcador = '_relma_muebles';
  const prefijo = 'mueble:';
  const meta = sesion => sesion?.asignaciones?.[marcador];
  const lugares = sesion => meta(sesion)?.lugares || [];
  const esMuebles = sesion => Array.isArray(meta(sesion)?.lugares);
  const id = () => crypto.randomUUID();
  const normalizar = valor => String(valor ?? '').trim().toUpperCase();
  const momento = valor => valor ? new Date(valor).toLocaleString('es-MX') : '';
  const cuenta = () => usuarios[usuarioLogueado]?.permisos?.inventario === true;
  const admin = () => !!usuarioLogueado && _esAdminSesion();
  const creador = s => admin() && s?.creada_por === usuarioLogueado;
  const propios = s => lugares(s).filter(m => m.usuario === usuarioLogueado);
  const abierta = s => s?.estado === 'abierta' && !meta(s)?.archivada;
  const operaciones = ['sumar', 'fijar', 'quitar', 'venta-antes', 'venta-despues'];
  const filasPorPagina = 500;
  let sesiones = [], activa = null, lugarId = '', filas = [];
  let ocupada = false, pendiente = null, refrescando = null, modoPz = true;
  let revision = '', estadoVista = '';
  let gestion = null, productoEdicion = null;
  const descargados = new Map();
  const miLugar = () => propios(activa).find(m => m.id === lugarId);
  const puedeCapturar = () => abierta(activa) && !!miLugar() && !miLugar().terminado;
  const accesoTemporal = () => !!usuarioLogueado && !cuenta()
    && sesiones.some(s => abierta(s) && propios(s).length);
  const puedeVer = () => !!usuarioLogueado && (admin() || cuenta() || accesoTemporal());

  function columnaCosto(encabezados) {
    const valores = encabezados.map(h => normalizar(h).normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    const unitario = valores.findIndex(h => /\bCOST[OE]\b.*\bUNIT(?:ARIO)?\b/.test(h));
    if (unitario >= 0) return unitario;
    return valores.findIndex(h => /\bCOST[OE]\b/.test(h)
      && !/\b(TOTAL|IMPORTE|EXTENDIDO|INVENTARIO|VALOR)\b/.test(h));
  }

  function leerCosto(valor) {
    if (valor == null || String(valor).trim() === '') return null;
    let limpio = String(valor).trim().replace(/^(MXN|USD)\s*/i, '').replace(/[\s$,]/g, '');
    const numero = Number(limpio);
    return limpio && Number.isFinite(numero) && numero >= 0 ? numero : null;
  }

  async function datos(consulta) {
    if (!supabaseClient) throw new Error('La conexión del inventario no está disponible.');
    const {data, error} = await consulta;
    if (error) throw new Error(error.message);
    return data;
  }

  function actualizarAcceso() {
    const tab = $('tabMuebles'), inventario = $('tabInventario');
    if (!tab || !inventario || !usuarioLogueado) return;
    tab.hidden = !puedeVer();
    inventario.style.display = cuenta() || accesoTemporal() ? 'inline-block' : 'none';
    if (tabActual === 'muebles' && !puedeVer()) cambiarPestana('ventas');
  }

  function boton(accion, texto, valor = '', clase = 'gris', deshabilitado = false) {
    return `<button type="button" class="${clase}" data-sm="${accion}" data-valor="${esc(valor)}"${deshabilitado ? ' disabled' : ''}>${esc(texto)}</button>`;
  }

  function elegibles() {
    return Object.entries(usuarios).filter(([, u]) => u.aprobado !== false)
      .sort((a, b) => (a[1].nombre || a[0]).localeCompare(b[1].nombre || b[0]));
  }

  function nombreUsuario(usuario) {
    return usuarios[usuario]?.nombre || usuario;
  }

  function abrirGestion(sesion) {
    if (sesion ? !creador(sesion) : !admin()) return;
    gestion = {sesion, nombre: sesion?.nombre || `Inventario ${getSucursal(sucursalActual)?.nombre || ''} ${new Date().toLocaleDateString('es-MX', {month:'short', year:'numeric'})}`,
      sucursal: sesion?.sucursal_id || sucursalActual, total: '', archivoCosto:null,
      grupos: new Map()};
    for (const m of lugares(sesion)) {
      if (!gestion.grupos.has(m.usuario)) gestion.grupos.set(m.usuario, []);
      gestion.grupos.get(m.usuario).push({...m});
    }
    if (!sesion) gestion.grupos.set(usuarioLogueado, [{id:id(), nombre:'', usuario:usuarioLogueado, terminado:false}]);
    renderGestion();
    $('modalMuebleGestion').classList.add('activo');
  }

  function renderGestion() {
    const {sesion, nombre, sucursal, total, grupos} = gestion;
    const listaUsuarios = elegibles();
    const opciones = listaUsuarios.filter(([u]) => !grupos.has(u)).map(([u,p]) =>
      `<option value="${esc(u)}">${esc(p.nombre || u)} · @${esc(u)}</option>`).join('');
    const gruposHtml = [...grupos].map(([u, muebles]) => `<section class="sesion-mueble-tarjeta">
      <strong>${esc(nombreUsuario(u))} · @${esc(u)}</strong>
      ${muebles.map(m => `<div class="sesion-mueble-asignacion">
        <label>Mueble o área<input maxlength="100" value="${esc(m.nombre)}" data-mueble-nombre="${esc(m.id)}"></label>
        ${sesion ? `<label>Asignado a<select data-traslado="${esc(m.id)}">${listaUsuarios.map(([k,p]) => `<option value="${esc(k)}"${u === k ? ' selected' : ''}>${esc(p.nombre || k)} · @${esc(k)}</option>`).join('')}</select></label>` : boton('quitar-fila','Quitar',m.id,'rojo')}
      </div>`).join('')}
      ${boton('agregar-mueble', 'Agregar mueble', u)}
    </section>`).join('');
    $('muebleGestionCuerpo').innerHTML = `<h3>${sesion ? 'Reasignar muebles o áreas' : 'Crear sesión por mueble'}</h3>
      ${sesion ? `<p>${esc(nombre)}</p>` : `<label>Nombre de sesión<input id="muebleNombreSesion" maxlength="120" value="${esc(nombre)}"></label>
      <label>Sucursal<select id="muebleSucursal">${sucursales.map(s => `<option value="${esc(s.id)}"${s.id === sucursal ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></label>
      <label>Total de muebles o áreas (opcional)<input id="muebleTotal" type="number" min="1" max="250" value="${esc(total)}"></label>
      <label>Excel para completar costos (opcional)<input id="muebleArchivoCosto" type="file" accept=".xlsx,.xls,.csv"></label>
      <p class="small" id="muebleNombreArchivo">${gestion.archivoCosto ? esc(gestion.archivoCosto.name) : 'Usa el Excel de esta sucursal si se cargó antes de que la app guardara el costo.'}</p>
      <div id="muebleReparto"${total ? '' : ' hidden'}>${boton('repartir','Repartir automáticamente')}</div>`}
      ${gruposHtml}
      <div class="sesion-mueble-asignacion"><label>Usuario<select id="muebleNuevoUsuario"><option value="">Selecciona un usuario</option>${opciones}</select></label>
      ${boton('agregar-usuario','Agregar usuario')}</div>
      <div class="sesion-mueble-botones">${boton('guardar-gestion',sesion ? 'Guardar asignaciones' : 'Crear sesión','','verde')}${boton('cancelar-gestion','Cancelar')}</div>`;
  }

  function recogerGestion() {
    if (!gestion.sesion) {
      gestion.nombre = $('muebleNombreSesion').value;
      gestion.sucursal = $('muebleSucursal').value;
      gestion.total = $('muebleTotal').value;
    }
    const campos = new Map([...$('muebleGestionCuerpo').querySelectorAll('[data-mueble-nombre]')].map(e => [e.dataset.muebleNombre, e.value]));
    for (const m of [...gestion.grupos.values()].flat()) if (campos.has(m.id)) m.nombre = campos.get(m.id);
  }

  function agregarMueble(u) {
    if (!u) throw new Error('Selecciona un usuario.');
    recogerGestion();
    if (!gestion.grupos.has(u)) gestion.grupos.set(u, []);
    gestion.grupos.get(u).push({id:id(), nombre:'', usuario:u, terminado:false});
    renderGestion();
  }

  function quitarFila(idMueble) {
    recogerGestion();
    for (const [u, muebles] of gestion.grupos) gestion.grupos.set(u, muebles.filter(m => m.id !== idMueble));
    renderGestion();
  }

  function repartir() {
    recogerGestion();
    const asignados = [...gestion.grupos.keys()];
    const cantidad = Number(gestion.total);
    if (!asignados.length || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 250) {
      throw new Error('Selecciona usuarios e ingresa entre 1 y 250 muebles.');
    }
    const existentes = [...gestion.grupos.values()].flat();
    if (existentes.filter(m => m.nombre.trim()).length > cantidad) throw new Error('El total es menor que la cantidad de muebles con nombre.');
    const nombres = existentes.filter(m => m.nombre.trim()).map(m => m.nombre);
    const ocupados = new Set(nombres.map(normalizar));
    for (let n = 1; nombres.length < cantidad; n++) {
      if (!ocupados.has(normalizar('Mueble ' + n))) nombres.push('Mueble ' + n);
    }
    gestion.grupos = new Map(asignados.map(u => [u, []]));
    nombres.forEach((nombre, i) => {
      const usuario = asignados[i % asignados.length];
      gestion.grupos.get(usuario).push({id:id(), nombre, usuario, terminado:false});
    });
    renderGestion();
  }

  function armarSnapshot(base) {
    const codigos = new Map();
    for (const codigo of Object.keys(vinculos)) {
      for (const producto of skusDeCodigo(codigo)) {
        const clave = normalizar(producto.sku);
        if (!codigos.has(clave)) codigos.set(clave, []);
        codigos.get(clave).push(normalizar(codigo));
      }
    }
    return base.map(({sku, descripcion, exis, costo}) => ({
      sku:normalizar(sku), descripcion:descripcion || '', exis:Number(exis) || 0,
      costo:leerCosto(costo), codigos:codigos.get(normalizar(sku)) || []
    }));
  }

  async function completarCostos(base, archivo) {
    if (!archivo) return base;
    if (!window.XLSX) throw new Error('El lector de Excel no está disponible.');
    const libro = XLSX.read(await archivo.arrayBuffer(),{type:'array'});
    const tabla = XLSX.utils.sheet_to_json(libro.Sheets[libro.SheetNames[0]],{header:1,defval:'',raw:true});
    const fila = tabla.findIndex(r => columnaCosto(r) >= 0 && r.some(v => /^(SKU|REX|CLAVE|C[ÓO]DIGO)(\s|$)/i.test(String(v).trim())));
    if (fila < 0) throw new Error('No se encontró la clave de producto y el costo unitario en el Excel.');
    const colSku = tabla[fila].findIndex(v => /^(SKU|REX|CLAVE|C[ÓO]DIGO)(\s|$)/i.test(String(v).trim()));
    const colCosto = columnaCosto(tabla[fila]);
    const precios = new Map();
    for (const r of tabla.slice(fila+1)) {
      const sku = normalizar(r[colSku]);
      const costo = leerCosto(r[colCosto]);
      if (!sku || costo === null) continue;
      if (precios.has(sku) && precios.get(sku) !== costo) precios.set(sku,null);
      else precios.set(sku,costo);
    }
    let encontrados = 0;
    const mezcla = base.map(p=>{
      const sku = normalizar(p.sku);
      if (!precios.has(sku)) return p;
      encontrados++;
      return {...p,costo:precios.get(sku)};
    });
    if (!encontrados) throw new Error('El Excel de costos no coincide con los SKU del inventario cargado.');
    return mezcla;
  }

  async function guardarGestion() {
    recogerGestion();
    const {sesion, sucursal, nombre} = gestion;
    if (sesion ? !creador(sesion) : !admin()) return;
    const nombres = new Set(), ubicaciones = [];
    for (const m of [...gestion.grupos.values()].flat()) {
      const nombre = m.nombre.trim();
      if (!nombre && !lugares(sesion).some(l => l.id === m.id)) continue;
      if (!nombre || nombres.has(normalizar(nombre))) throw new Error('Cada mueble debe tener un nombre único.');
      nombres.add(normalizar(nombre));
      ubicaciones.push({...m, nombre});
    }
    if (!ubicaciones.length) throw new Error('Agrega al menos un mueble con nombre.');
    if (sesion) {
      await actualizarSesion(sesion, {asignaciones:{[marcador]:{...meta(sesion), lugares:ubicaciones}}});
    } else {
      let base = inventariosPorSucursal[sucursal]?.base;
      if (!base?.length) {
        await bajarInventarioSupabase(sucursal);
        base = inventariosPorSucursal[sucursal]?.base;
      }
      if (!base?.length || !nombre.trim()) throw new Error('Escribe el nombre y carga el Excel de esa sucursal.');
      const snapshot = armarSnapshot(await completarCostos(base,gestion.archivoCosto));
      await datos(supabaseClient.from('sesiones_conteo').insert({
        nombre:nombre.trim(), sucursal_id:sucursal, estado:'borrador', creada_por:usuarioLogueado,
        asignaciones:{[marcador]:{lugares:ubicaciones, version:2}},
        total_productos:snapshot.length, pagina_tamano:200, snapshot_base:snapshot
      }));
      if (!snapshot.some(p => p.costo !== null)) toast('Sesión creada. El Excel cargado no tiene costos disponibles.');
    }
    $('modalMuebleGestion').classList.remove('activo');
    gestion = null;
    await refrescar();
  }

  async function actualizarSesion(sesion, cambios) {
    const guardado = await datos(supabaseClient.from('sesiones_conteo').update(cambios).eq('id', sesion.id)
      .eq('estado',sesion.estado).eq('asignaciones',JSON.stringify(sesion.asignaciones)).select('*').maybeSingle());
    if (!guardado) throw new Error('La sesión cambió. Actualiza y vuelve a intentar.');
    return guardado;
  }

  async function listar() {
    const lista = [];
    for (let desde = 0; ; desde += 100) {
      const lote = await datos(supabaseClient.from('sesiones_conteo')
        .select('id,nombre,sucursal_id,estado,creada_por,fecha_creacion,fecha_apertura,fecha_cierre,asignaciones,total_productos')
        .not('asignaciones->' + marcador, 'is', null).order('fecha_creacion',{ascending:false})
        .order('id').range(desde, desde + 99));
      lista.push(...lote.filter(esMuebles));
      if (lote.length < 100) return lista;
    }
  }

  async function actual(idSesion) {
    const s = await datos(supabaseClient.from('sesiones_conteo').select('*').eq('id', idSesion).maybeSingle());
    if (!esMuebles(s)) throw new Error('No se encontró la sesión por muebles.');
    return s;
  }

  async function refrescar(avisar = false) {
    if (!usuarioLogueado || !supabaseClient) return;
    if (refrescando) return refrescando;
    const usuario = usuarioLogueado;
    refrescando = (async () => {
      const lista = await listar();
      if (usuario !== usuarioLogueado) return;
      sesiones = lista;
      if (activa) {
        const vigente = sesiones.find(s => s.id === activa.id);
        if (!abierta(vigente) || !propios(vigente).length) { salir(); toast('Tu acceso a esta sesión terminó.'); }
        else {
          activa = {...activa, ...vigente};
          if (!miLugar()) lugarId = '';
          if (!ocupada && !pendiente && tabActual === 'muebles') await cargarCapturas();
        }
      }
      actualizarAcceso();
      if (tabActual === 'muebles') {
        const cambio = JSON.stringify([lista,activa?.id,lugarId,revision]);
        const campoEnUso = $('sesionMueblesPanel')?.contains(document.activeElement)
          && document.activeElement.matches('input, select, textarea');
        if (cambio !== estadoVista && !campoEnUso) { render(); estadoVista = cambio; }
        else if (activa && !ocupada) mostrarProductos();
      }
    })().catch(error => { if (avisar) toast(error.message, 'error'); else console.warn(error); })
      .finally(() => { refrescando = null; });
    return refrescando;
  }

  async function capturas(s, ubicaciones = null) {
    const resultado = [];
    if (ubicaciones && !ubicaciones.length) return resultado;
    for (let desde = 0; ; desde += filasPorPagina) {
      let consulta = supabaseClient.from('conteos_individuales').select('id,sku,usuario,cantidad,dispositivo,timestamp')
        .eq('sesion_id',s.id).order('timestamp').order('id');
      if (ubicaciones) consulta = consulta.in('dispositivo', ubicaciones.flatMap(m => operaciones.map(op => prefijo + m + ':' + op)));
      const lote = await datos(consulta.range(desde,desde + filasPorPagina - 1));
      resultado.push(...lote);
      if (lote.length < filasPorPagina) return resultado;
    }
  }

  async function cargarCapturas() {
    const s = activa;
    if (!s) return;
    const carga = await capturas(s);
    if (activa?.id === s.id && !ocupada && !pendiente) {
      filas = carga;
      revision = carga.length + ':' + (carga.at(-1)?.id || '');
    }
  }

  async function unirse(idSesion) {
    if (sesionActivaUsuario) throw new Error('Primero sal de tu sesión por páginas.');
    const s = await actual(idSesion);
    if (!abierta(s) || !propios(s).length) throw new Error('La sesión está cerrada o no tienes muebles asignados.');
    activa = s;
    lugarId = '';
    filas = [];
    await cargarCapturas();
    render();
  }

  function agrupar(s, eventos) {
    const porLugar = new Map(lugares(s).map(m => [m.id, new Map()]));
    for (const e of eventos) {
      const [tipo, lugar, op] = String(e.dispositivo || '').split(':');
      const items = porLugar.get(lugar);
      if (tipo !== 'mueble' || !items || !operaciones.includes(op)) continue;
      const p = items.get(e.sku) || {sku:e.sku, cantidad:0, contado:false, antes:0, despues:0, historial:[]};
      if (op === 'sumar') { p.cantidad += Number(e.cantidad); p.contado = true; }
      if (op === 'fijar') { p.cantidad = Number(e.cantidad); p.contado = true; }
      if (op === 'quitar') { p.cantidad = 0; p.contado = false; }
      if (op === 'venta-antes') p.antes += Number(e.cantidad);
      if (op === 'venta-despues') p.despues += Number(e.cantidad);
      p.historial.push({...e, op});
      items.set(e.sku, p);
    }
    return porLugar;
  }

  function conciliar(s, eventos) {
    const porLugar = agrupar(s,eventos);
    const acumulados = new Map();
    for (const items of porLugar.values()) for (const p of items.values()) {
      const total = acumulados.get(p.sku) || {cantidad:0, antes:0, despues:0, contado:false};
      total.cantidad += p.cantidad;
      total.antes += p.antes;
      total.despues += p.despues;
      total.contado ||= p.contado;
      acumulados.set(p.sku,total);
    }
    const completa = lugares(s).length > 0 && lugares(s).every(m => m.terminado);
    const resumen = (s.snapshot_base || []).map(p => {
      const t = acumulados.get(p.sku) || {cantidad:0, antes:0, despues:0, contado:false};
      acumulados.delete(p.sku);
      const observado = t.cantidad - t.despues;
      const sistema = p.exis - t.antes - t.despues;
      const diferencia = observado - sistema;
      return {...p,...t, observado, sistema, diferencia, estado:completa ? (diferencia === 0 ? 'Cuadra' : diferencia < 0 ? 'Faltante' : 'Sobrante')
        : diferencia > 0 ? 'Sobrante preliminar' : 'Pendiente de conciliar'};
    });
    for (const [sku,t] of acumulados) if (t.contado || t.antes || t.despues) resumen.push({sku,...t, descripcion:'Fuera del Excel', estado:'Fuera del Excel'});
    return {porLugar,resumen,completa};
  }

  function render() {
    const panel = $('sesionMueblesPanel');
    if (!panel || !puedeVer()) return;
    const lista = sesiones.filter(s => !meta(s).archivada && (
      (admin() && (s.sucursal_id === sucursalActual || creador(s))) || (abierta(s) && propios(s).length)));
    const anterior = $('invPanelMuebles');
    if (anterior) anterior.hidden = !admin();
    const tarjetas = lista.map(s => {
      const controles = [];
      if (abierta(s) && propios(s).length && activa?.id !== s.id) controles.push(boton('unirse','Unirse a la sesión',s.id,'verde'));
      if (creador(s)) {
        if (s.estado === 'borrador') controles.push(boton('abrir','Abrir sesión',s.id,'verde'));
        if (s.estado === 'abierta') {
          controles.push(boton('reasignar','Reasignar áreas',s.id), boton('cerrar','Cerrar sesión',s.id,'rojo'));
        }
        if (s.estado !== 'borrador') controles.push(boton('reporte',s.estado === 'abierta' ? 'Reporte preliminar' : 'Reporte final',s.id));
        controles.push(boton('archivar','Eliminar sesión',s.id,'rojo'));
      }
      const visibles = creador(s) ? lugares(s) : propios(s);
      const estado = {borrador:'Borrador',abierta:'Abierta',cerrada:'Cerrada'}[s.estado] || s.estado;
      return `<section class="sesion-mueble-tarjeta"><strong>${esc(s.nombre)}</strong>
        <p class="small">${esc(estado)} · ${esc(getSucursal(s.sucursal_id)?.nombre || s.sucursal_id)} · Creada por @${esc(s.creada_por)}</p>
        <p class="small">${visibles.filter(m => m.terminado).length}/${visibles.length} muebles terminados</p>
        <div class="sesion-mueble-botones">${controles.join('')}</div></section>`;
    });
    const filtro = $('muebleFiltro')?.value || '';
    const codigo = $('muebleCodigo')?.value || '';
    panel.innerHTML = `<section class="panel"><h3>Inventario por mueble</h3>
      <div class="sesion-mueble-botones">${admin() ? boton('crear','Crear sesión por mueble','','verde') : ''}${boton('refrescar','Actualizar sesiones')}</div>
      ${tarjetas.join('') || '<p class="small">No hay sesiones disponibles.</p>'}</section>
      ${activa ? renderTrabajo(filtro,codigo) : ''}`;
    if (activa) mostrarProductos();
  }

  function renderTrabajo(filtro,codigo) {
    const lugar = miLugar();
    const agrupados = agrupar(activa,filas);
    const botones = propios(activa).map(m => {
      const cantidad = [...(agrupados.get(m.id)?.values() || [])].reduce((a,p) => a + p.cantidad, 0);
      return boton('seleccionar',`${m.nombre} · ${cantidad} pz${m.terminado ? ' · Terminado' : ''}`,m.id,m.id === lugarId ? 'verde' : 'gris');
    });
    const adminInfo = admin() ? `<p class="small">${(activa.snapshot_base || []).length} productos en el Excel · ${lugares(activa).filter(m=>m.terminado).length}/${lugares(activa).length} muebles terminados</p>` : '';
    return `<section class="panel"><h3>${esc(activa.nombre)}</h3>
      <div class="sesion-mueble-botones">${botones.join('')}${boton('salir','Salir de la sesión')}</div>
      ${lugar ? `<p><strong>${esc(lugar.nombre)}</strong></p>${boton('terminar',lugar.terminado ? 'Desmarcar terminado' : 'Marcar terminado')}` : '<p class="small">Elige el mueble que vas a contar.</p>'}</section>
      ${lugar ? `<section class="panel" id="muebleContar"><h3>2 · Contar productos</h3>${adminInfo}
        <div class="sesion-mueble-botones">${boton('modo',`Modo PZ ${modoPz ? 'activado' : 'desactivado'}`,'',modoPz ? 'verde' : 'gris')}
        ${boton('venta','Registrar venta','','amarillo',!puedeCapturar())}</div>
        <label class="small"><input type="checkbox" id="muebleContinuo"${continuo() ? ' checked' : ''}${modoPz ? '' : ' disabled'}> Escaneo continuo</label>
        <div class="mueble-metricas" id="muebleMetricas"></div>
        <form id="muebleCaptura" class="fila">
          <input id="muebleCodigo" value="${esc(codigo)}" required autocomplete="off" placeholder="SKU o código de barras"${puedeCapturar() ? '' : ' disabled'}>
          <button class="verde"${puedeCapturar() ? '' : ' disabled'}>Capturar</button>${boton('camara','📷','','camara',!puedeCapturar())}
        </form>
        <p id="muebleAviso" role="status" class="small"></p></section>
      <section class="panel"><h3>Mi zona en sesión</h3>
        <div class="fila"><input id="muebleFiltro" value="${esc(filtro)}" placeholder="Buscar por nombre, SKU o código">
        ${boton('buscar-camara','Escanear')}</div><div id="muebleProductos" class="mueble-lista"></div></section>
      <section class="panel"><h3>Resumen de conteo</h3>
        <p class="small">Las existencias del Excel corresponden a la sucursal. Los productos de varios muebles se comparan en el reporte global.</p>
        <div id="muebleDiferencias" class="mueble-lista"></div>${boton('reporte-zona','Exportar mi conteo','','verde')}</section>` : ''}`;
  }

  function continuo() {
    try { return localStorage.getItem('fc_relma_mueble_continuo') !== '0'; }
    catch { return true; }
  }

  function mapaProductos() {
    return new Map((activa?.snapshot_base || []).map(p => [p.sku,p]));
  }

  function mostrarProductos() {
    const agrupados = activa ? agrupar(activa,filas) : new Map();
    for (const control of $('sesionMueblesPanel')?.querySelectorAll('[data-sm="seleccionar"]') || []) {
      const m = propios(activa).find(m=>m.id === control.dataset.valor);
      if (!m) continue;
      const cantidad = [...(agrupados.get(m.id)?.values() || [])].reduce((n,p)=>n+p.cantidad,0);
      control.textContent = `${m.nombre} · ${cantidad} pz${m.terminado ? ' · Terminado' : ''}`;
    }
    const lista = $('muebleProductos');
    if (!lista || !miLugar()) return;
    const abiertos = new Set([...lista.querySelectorAll('details[open]')].map(n => n.dataset.sku));
    const items = [...(agrupados.get(lugarId)?.values() || [])];
    const base = mapaProductos();
    const q = normalizar($('muebleFiltro').value);
    const capturados = items.filter(p => p.contado);
    lista.innerHTML = capturados.filter(p => {
      const prod = base.get(p.sku);
      return [p.sku,prod?.descripcion,...(prod?.codigos || [])].some(t => normalizar(t).includes(q));
    }).map(p => `<details data-sku="${esc(p.sku)}"${abiertos.has(p.sku) ? ' open' : ''}>
      <summary><strong>${esc(p.sku)}</strong> · ${esc(base.get(p.sku)?.descripcion || 'Fuera del Excel')} · ${p.cantidad} pz</summary>
      <p class="small">${p.historial.filter(e=>['fijar','sumar'].includes(e.op)).length} capturas</p>
      <ul>${p.historial.map(e=>`<li>${esc(momento(e.timestamp))} · @${esc(e.usuario)} · ${esc(etiqueta(e.op))} · ${e.cantidad} pz</li>`).join('')}</ul>
      ${boton('editar','Editar',p.sku,'gris',!puedeCapturar())}
    </details>`).join('') || '<p class="small">Sin productos contados que coincidan.</p>';
    $('muebleMetricas').textContent = `${capturados.reduce((n,p)=>n+p.cantidad,0)} pz contadas · ${items.reduce((n,p)=>n+p.antes+p.despues,0)} pz vendidas`;
    const diferencias = diferenciasZona(items,base);
    $('muebleDiferencias').innerHTML = diferencias.map(p => `<p class="small"><strong>${esc(p.sku)}</strong> · ${esc(p.descripcion)} · ${esc(p.estado)}</p>`).join('')
      || '<p class="small">Sin diferencias visibles en este mueble.</p>';
  }

  function diferenciasZona(items,base) {
    const conciliacion = new Map(conciliar(activa,filas).resumen.map(p=>[p.sku,p]));
    return items.filter(p => p.contado || p.antes || p.despues).flatMap(p => {
      const prod = base.get(p.sku);
      if (!prod) return [{sku:p.sku,descripcion:'Fuera del Excel',estado:'Revisar'}];
      const global = conciliacion.get(p.sku);
      if (global?.diferencia === 0 && (global.contado || global.estado === 'Cuadra')) return [];
      const estado = ['Faltante','Sobrante','Sobrante preliminar'].includes(global?.estado)
        ? `${global.estado} global de ${Math.abs(global.diferencia)} pz` : 'Pendiente de conciliar';
      return [{sku:p.sku,descripcion:prod.descripcion,estado}];
    });
  }

  function etiqueta(op) {
    return {sumar:'Escaneo +1',fijar:'Corrección de total',quitar:'Conteo quitado','venta-antes':'Venta antes de contar','venta-despues':'Venta después de contar'}[op] || op;
  }

  function producto(codigo, aceptaDesconocido = false) {
    const sku = normalizar(codigo);
    const base = activa?.snapshot_base || [];
    const exacto = base.find(p => p.sku === sku);
    if (exacto) return exacto;
    const vinculados = base.filter(p => p.codigos?.includes(sku));
    if (vinculados.length === 1) return vinculados[0];
    if (vinculados.length > 1) throw new Error('Código con varias coincidencias. Captura el SKU.');
    if (aceptaDesconocido && sku && sku.length <= 120) return {sku,descripcion:'Fuera del Excel'};
    throw new Error('Código fuera del Excel. Verifica el SKU.');
  }

  async function guardar(p,cantidad,op) {
    if (ocupada || !puedeCapturar()) throw new Error('Selecciona un mueble abierto y espera la captura anterior.');
    if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > 10000000
      || (op.startsWith('venta-') && cantidad === 0)) throw new Error('Ingresa una cantidad válida.');
    const clave = [activa.id,lugarId,p.sku,op,cantidad].join('|');
    if (pendiente && pendiente.clave !== clave) throw new Error('Repite la captura pendiente del SKU ' + pendiente.sku + ' antes de continuar.');
    const envio = {id:pendiente?.id || id(),sesion_id:activa.id,usuario:usuarioLogueado,sku:p.sku,cantidad,dispositivo:prefijo + lugarId + ':' + op};
    ocupada = true;
    try {
      let row;
      if (pendiente) row = await datos(supabaseClient.from('conteos_individuales').select('id,sku,usuario,cantidad,dispositivo,timestamp').eq('id',envio.id).maybeSingle());
      if (!row) {
        const inserted = await datos(supabaseClient.from('conteos_individuales').upsert(envio,{onConflict:'id',ignoreDuplicates:true}).select('id,sku,usuario,cantidad,dispositivo,timestamp').maybeSingle());
        row = inserted || await datos(supabaseClient.from('conteos_individuales').select('id,sku,usuario,cantidad,dispositivo,timestamp').eq('id',envio.id).maybeSingle());
      }
      if (!row) throw new Error('La app no pudo confirmar la captura.');
      if (!filas.some(f=>f.id === row.id)) filas.push(row);
      pendiente = null;
      mostrarProductos();
      return agrupar(activa,filas).get(lugarId)?.get(p.sku)?.cantidad || 0;
    } catch (error) {
      if (_esErrorRed(error)) {
        pendiente = {clave,id:envio.id,sku:p.sku};
        throw new Error('No se confirmó la captura. Repite la misma operación para verificarla sin duplicar.');
      }
      pendiente = null;
      throw error;
    } finally { ocupada = false; }
  }

  async function escanear(codigo) {
    try {
      const p = producto(codigo);
      const total = await guardar(p,1,'sumar');
      confirmarEscaneoVisual(true,`+1 ${p.descripcion || p.sku} · ${total} en ${miLugar()?.nombre || 'este mueble'}`);
    } catch (error) {
      confirmarEscaneoVisual(false,error.message);
      if (!$('modalCamara')?.classList.contains('activo')) toast(error.message,'error');
    }
  }

  function buscarEscaneo(codigo) {
    const filtro = $('muebleFiltro');
    if (filtro) { filtro.value = codigo; mostrarProductos(); }
  }

  function abrirCantidad(codigo, editar = false) {
    try {
      if (!puedeCapturar()) throw new Error('Este mueble ya está terminado.');
      const p = producto(codigo,editar || !modoPz);
      if (modoPz && !editar) { void escanear(codigo); return; }
      const actual = agrupar(activa,filas).get(lugarId)?.get(p.sku);
      productoEdicion = {modo:editar ? 'editar' : 'contar',p};
      $('muebleProductoCuerpo').innerHTML = `<h3>${esc(p.sku)}</h3><p>${esc(p.descripcion)}</p>
        ${admin() && p.exis != null ? `<p class="small">Sistema en sucursal · ${p.exis} pz</p>` : ''}
        <p class="small">Contado en ${esc(miLugar()?.nombre)} · ${actual?.cantidad || 0} pz</p>
        ${editar && actual?.historial.length ? `<details><summary>Aportaciones en esta sesión</summary><ul>${actual.historial.map(e=>`<li>@${esc(e.usuario)} · ${esc(momento(e.timestamp))} · ${esc(etiqueta(e.op))} · ${e.cantidad} pz</li>`).join('')}</ul></details>` : ''}
        <label>¿Cuántas piezas hay físicamente en este mueble?<input id="muebleCantidad" class="cant-grande" type="number" min="0" max="10000000" step="1" value="${actual?.cantidad ?? 0}" inputmode="numeric"></label>
        <div class="sesion-mueble-botones">${boton('guardar-producto','Guardar','','verde')}${boton('cancelar-producto','Cancelar')}
        ${editar ? boton('quitar-conteo','Quitar conteo de este producto','','rojo') : ''}</div>`;
      $('modalMuebleProducto').classList.add('activo');
      $('muebleCantidad').focus();
    } catch (error) { confirmarEscaneoVisual(false,error.message); toast(error.message,'error'); }
  }

  function abrirVenta(codigo = '') {
    if (!puedeCapturar()) return;
    const p = codigo ? producto(codigo) : null;
    productoEdicion = {modo:'venta'};
    $('muebleProductoCuerpo').innerHTML = `<h3>Registrar venta</h3><p>Salida de ${esc(miLugar().nombre)}</p>
      <div class="fila"><input id="muebleVentaSKU" value="${esc(p?.sku || '')}" placeholder="SKU o código de barras">${boton('camara-venta','📷','','camara')}</div>
      <label>Piezas vendidas<input id="muebleCantidad" type="number" min="1" max="10000000" step="1" value="1" inputmode="numeric"></label>
      <label>¿Esas piezas ya estaban incluidas en el conteo?<select id="muebleVentaMomento"><option value="">Selecciona una opción</option>
        <option value="venta-antes">No, salieron antes de contarlas</option><option value="venta-despues">Sí, salieron después de contarlas</option></select></label>
      <div class="sesion-mueble-botones">${boton('guardar-producto','Registrar venta','','verde')}${boton('cancelar-producto','Cancelar')}</div>`;
    $('modalMuebleProducto').classList.add('activo');
  }

  function buscarVenta(codigo) {
    try {
      const p = producto(codigo);
      $('muebleVentaSKU').value = p.sku;
      $('muebleCantidad').focus();
    } catch (error) { toast(error.message,'error'); }
  }

  function cerrarProducto() {
    $('modalMuebleProducto')?.classList.remove('activo');
    productoEdicion = null;
  }

  async function guardarProducto(quitar = false) {
    if (!productoEdicion) return;
    let p = productoEdicion.p;
    let op = quitar ? 'quitar' : 'fijar';
    const cantidad = quitar ? 0 : $('muebleCantidad').valueAsNumber;
    if (productoEdicion.modo === 'venta') {
      p = producto($('muebleVentaSKU').value);
      op = $('muebleVentaMomento').value;
      if (!op) throw new Error('Indica si las piezas ya estaban contadas.');
    }
    if (quitar && !confirm('¿Quitar el conteo de este producto en este mueble?')) return;
    await guardar(p,cantidad,op);
    cerrarProducto();
    if ($('muebleCodigo')) $('muebleCodigo').value = '';
    toast(op.startsWith('venta-') ? 'Venta registrada en la sesión' : 'Conteo actualizado');
  }

  async function terminar() {
    if (!miLugar() || ocupada || pendiente) throw new Error('Resuelve la captura pendiente.');
    const s = await actual(activa.id);
    const m = propios(s).find(m => m.id === lugarId);
    if (!abierta(s) || !m) throw new Error('El mueble ya no está disponible.');
    activa = await actualizarSesion(s,{asignaciones:{[marcador]:{...meta(s),
      lugares:lugares(s).map(l=>l.id === m.id ? {...l,terminado:!l.terminado} : l)}}});
    render();
  }

  async function cambiarEstado(idSesion,accion) {
    const s = await actual(idSesion);
    if (!creador(s) || meta(s).archivada) return;
    if (accion === 'abrir' && s.estado !== 'borrador') return;
    if (accion === 'cerrar' && !abierta(s)) return;
    if (accion === 'archivar' && !confirm('¿Eliminar la sesión de la lista? Sus capturas se conservarán archivadas.')) return;
    if (accion === 'cerrar') {
      const faltan = lugares(s).filter(m=>!m.terminado).length;
      const confirmacion = prompt(`Escribe CERRAR para terminar la sesión. Quedan ${faltan} muebles pendientes.`);
      if (normalizar(confirmacion) !== 'CERRAR') return;
    }
    const ahora = new Date().toISOString();
    const cambios = accion === 'abrir' ? {estado:'abierta',fecha_apertura:ahora}
      : {estado:'cerrada',fecha_cierre:s.fecha_cierre || ahora};
    if (accion === 'archivar') cambios.asignaciones = {[marcador]:{...meta(s),archivada:true}};
    const guardada = await actualizarSesion(s,cambios);
    await refrescar();
    if (accion === 'cerrar') {
      try {
        const eventos = await capturas(guardada);
        if (descargados.get(s.id) !== huella(eventos,guardada)) await descargar(guardada,eventos);
      } catch (error) { toast('Sesión cerrada. Descarga el Excel desde Reporte final. ' + error.message,'error'); }
    }
  }

  function huella(eventos,s) {
    return JSON.stringify([eventos.length,eventos.at(-1)?.id,lugares(s)]);
  }

  function aMoneda(a) { return Math.round((a + Number.EPSILON) * 100) / 100; }

  async function descargar(s,eventos,soloZona = '') {
    if (!window.XLSX) throw new Error('Excel no está disponible.');
    const ubicaciones = new Map(lugares(s).map(m=>[m.id,m]));
    const base = new Map((s.snapshot_base || []).map(p=>[p.sku,p]));
    const {porLugar,resumen,completa} = conciliar(s,eventos);
    const encabezado = ['SKU','Producto','Sistema al cargar','Contado físicamente','Venta antes','Venta después','Sistema ajustado','Físico al corte','Diferencia','Costo unitario','Valor faltante','Valor sobrante','Estado'];
    const global = resumen.map(p => {
      const costo = leerCosto(p.costo);
      return [p.sku,p.descripcion,p.exis ?? null,p.cantidad,p.antes,p.despues,p.sistema ?? null,p.observado ?? null,p.diferencia ?? null,costo,
        costo != null && completa && p.diferencia < 0 ? aMoneda(-p.diferencia*costo) : null,
        costo != null && p.diferencia > 0 ? aMoneda(p.diferencia*costo) : null,p.estado];
    });
    const faltante = global.reduce((n,p)=>n+(p[10] || 0),0);
    const sobrante = global.reduce((n,p)=>n+(p[11] || 0),0);
    const sinCosto = global.filter(p=>p[8] && p[9] == null).length;
    const detalle = eventos.flatMap(e=>{
      const [,lugar,op] = String(e.dispositivo || '').split(':');
      const m = ubicaciones.get(lugar);
      if (!m || !operaciones.includes(op)) return [];
      return [[m.nombre,e.usuario,e.sku,base.get(e.sku)?.descripcion || '',etiqueta(op),e.cantidad,momento(e.timestamp)]];
    });
    const zona = [...porLugar].flatMap(([key,items]) => [...items.values()].map(p=>[
      ubicaciones.get(key).nombre,p.sku,base.get(p.sku)?.descripcion || '',p.cantidad,p.antes,p.despues,
      [...new Set(p.historial.map(e=>e.usuario))].map(u=>'@'+u).join(', ')]));
    const wb = XLSX.utils.book_new();
    const hojas = soloZona
      ? [['Resumen', [['Mueble',ubicaciones.get(soloZona)?.nombre || ''],['Usuario',usuarioLogueado],
        ['SKU','Producto','Estado'],...diferenciasZona([...(porLugar.get(soloZona)?.values() || [])],base).map(p=>[p.sku,p.descripcion,p.estado])]]]
      : [['Resumen', [['Sesión',s.nombre],['Estado',s.estado],['Conciliación',completa ? 'Completa' : 'Preliminar'],
        ['Valor faltante',completa ? aMoneda(faltante) : null],['Valor sobrante',aMoneda(sobrante)],['SKU con diferencia y costo ausente',sinCosto],[],encabezado,...global]]];
    hojas.push(['Por mueble',[['Mueble','SKU','Producto','Piezas','Venta antes','Venta después','Participantes'], ...zona]],
      ['Capturas',[['Mueble','Usuario','SKU','Producto','Movimiento','Cantidad','Hora'], ...detalle]]);
    if (!soloZona) hojas.push(['Avance',[['Mueble','Asignado a','Terminado'],...lugares(s).map(m=>[m.nombre,m.usuario,m.terminado ? 'Sí' : 'No'])]]);
    for (const [nombre,rows] of hojas) {
      const hoja = XLSX.utils.aoa_to_sheet(rows);
      hoja['!cols'] = [{wch:25},{wch:28},{wch:34},...Array.from({length:10},()=>({wch:19}))];
      XLSX.utils.book_append_sheet(wb,hoja,nombre);
    }
    const nombre = (soloZona ? ubicaciones.get(soloZona)?.nombre : s.nombre) || 'Inventario';
    XLSX.writeFile(wb,nombre.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-') + '.xlsx');
    if (!soloZona) descargados.set(s.id,huella(eventos,s));
  }

  async function reporte(idSesion) {
    const s = await actual(idSesion);
    if (creador(s)) await descargar(s,await capturas(s));
  }

  async function reporteZona() {
    if (!miLugar()) return;
    await cargarCapturas();
    const captura = filas.filter(e=>String(e.dispositivo).split(':')[1] === lugarId);
    const items = [...(agrupar(activa,captura).get(lugarId)?.values() || [])];
    const diferencias = diferenciasZona(items,mapaProductos());
    if (diferencias.length && !confirm(`Hay ${diferencias.length} productos con diferencias o pendientes de conciliar. ¿Descargar de todos modos?`)) return;
    await descargar(activa,captura,lugarId);
  }

  function salir() {
    if (activa) cerrarCamara();
    cerrarProducto();
    activa = null;
    lugarId = '';
    pendiente = null;
    filas = [];
  }

  async function ejecutar(control,tarea) {
    if (control.disabled) return;
    control.disabled = true;
    try { await tarea(); }
    catch (error) { toast(error.message || 'No se pudo completar la acción.','error'); }
    finally { control.disabled = false; }
  }

  function seleccionar(nuevo) {
    if (ocupada || pendiente) throw new Error('Resuelve la captura pendiente antes de cambiar de mueble.');
    if (!propios(activa).some(m=>m.id === nuevo)) return;
    cerrarCamara();
    lugarId = nuevo;
    render();
  }

  document.addEventListener('DOMContentLoaded',()=>{
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-bg" id="modalMuebleGestion"><div class="modal" id="muebleGestionCuerpo"></div></div>
      <div class="modal-bg" id="modalMuebleProducto"><div class="modal" id="muebleProductoCuerpo"></div></div>`);
    document.addEventListener('input',e=>{
      if (e.target.id === 'muebleTotal') $('muebleReparto').hidden = !e.target.value;
      if (e.target.id === 'muebleFiltro') mostrarProductos();
    });
    document.addEventListener('change',e=>{
      if (e.target.id === 'muebleArchivoCosto' && gestion) {
        gestion.archivoCosto = e.target.files[0] || null;
        $('muebleNombreArchivo').textContent = gestion.archivoCosto?.name || 'Sin archivo adicional de costos.';
      }
      if (e.target.id === 'muebleSucursal' && gestion?.archivoCosto) {
        gestion.archivoCosto = null;
        $('muebleArchivoCosto').value = '';
        $('muebleNombreArchivo').textContent = 'Selecciona el Excel de la nueva sucursal.';
      }
      if (e.target.id === 'muebleContinuo') {
        try { localStorage.setItem('fc_relma_mueble_continuo',e.target.checked ? '1' : '0'); } catch {}
      }
      if (e.target.dataset.traslado && gestion) {
        recogerGestion();
        for (const [u,items] of gestion.grupos) {
          const m = items.find(m=>m.id === e.target.dataset.traslado);
          if (!m || u === e.target.value) continue;
          gestion.grupos.set(u,items.filter(x=>x.id !== m.id));
          const nuevo = e.target.value;
          if (!gestion.grupos.has(nuevo)) gestion.grupos.set(nuevo,[]);
          gestion.grupos.get(nuevo).push({...m,usuario:nuevo});
          renderGestion();
          break;
        }
      }
    });
    document.addEventListener('click',e=>{
      const control = e.target.closest('button[data-sm]');
      if (!control) return;
      const {sm,valor} = control.dataset;
      const tareas = {
        crear:()=>abrirGestion(), refrescar:()=>refrescar(true),
        reasignar:async()=>abrirGestion(await actual(valor)), 'agregar-mueble':()=>agregarMueble(valor),
        'agregar-usuario':()=>agregarMueble($('muebleNuevoUsuario').value), 'quitar-fila':()=>quitarFila(valor),
        repartir, 'guardar-gestion':guardarGestion,
        'cancelar-gestion':()=>{$('modalMuebleGestion').classList.remove('activo'); gestion=null;},
        unirse:()=>unirse(valor), seleccionar:()=>seleccionar(valor), terminar,
        salir:()=>{if(ocupada || pendiente) throw new Error('Resuelve la captura pendiente.'); salir(); render();},
        abrir:()=>cambiarEstado(valor,'abrir'), cerrar:()=>cambiarEstado(valor,'cerrar'), archivar:()=>cambiarEstado(valor,'archivar'),
        reporte:()=>reporte(valor), 'reporte-zona':reporteZona,
        modo:()=>{if (pendiente) throw new Error('Resuelve la captura pendiente.'); modoPz=!modoPz; render();},
        camara:()=>abrirCamara(modoPz && continuo() ? 'mueble-captura' : 'mueble-captura-unica'),
        'buscar-camara':()=>abrirCamara('mueble-busqueda'),
        venta:()=>abrirVenta(), 'camara-venta':()=>abrirCamara('mueble-venta'),
        editar:()=>abrirCantidad(valor,true),'guardar-producto':()=>guardarProducto(),
        'quitar-conteo':()=>guardarProducto(true),'cancelar-producto':cerrarProducto
      };
      if (tareas[sm]) void ejecutar(control,tareas[sm]);
    });
    document.addEventListener('submit',e=>{
      if (e.target.id !== 'muebleCaptura') return;
      e.preventDefault();
      const input = $('muebleCodigo'), codigo = input.value.trim();
      if (!codigo) return;
      if (modoPz) {
        void ejecutar(e.target.querySelector('button'),async()=>{
          const p = producto(codigo);
          const total = await guardar(p,1,'sumar');
          $('muebleAviso').textContent = p.sku + ' · ' + total + ' pz';
          input.value = '';
          input.focus();
        });
      } else abrirCantidad(codigo);
    });
    setInterval(()=>{ if (usuarioLogueado && !document.hidden) void refrescar(); },12000);
  });

  window.sesionesMueble = {esMuebles,render,refrescar,salir,puedeVer,accesoTemporal,actualizarAcceso,
    columnaCosto,leerCosto,escanear,buscarEscaneo,abrirCantidad,buscarVenta,
    ocupada:()=>ocupada,nombre:()=>miLugar()?.nombre || '',error:mensaje=>confirmarEscaneoVisual(false,mensaje)};

})();
