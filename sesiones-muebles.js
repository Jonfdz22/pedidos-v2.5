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
  const textoBusqueda = valor => normalizar(valor).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const momento = valor => valor ? new Date(valor).toLocaleString('es-MX') : '';
  const admin = () => !!usuarioLogueado && _esAdminSesion();
  const creador = s => admin() && s?.creada_por === usuarioLogueado;
  const propios = s => lugares(s).filter(m => m.usuario === usuarioLogueado);
  const abierta = s => s?.estado === 'abierta' && !meta(s)?.archivada;
  const puedeEditarSesion = s => creador(s) && !meta(s)?.archivada && ['borrador','abierta'].includes(s.estado);
  const operaciones = ['sumar', 'fijar', 'quitar', 'venta-antes', 'venta-despues'];
  const filasPorPagina = 500;
  let sesiones = [], activa = null, lugarId = '', filas = [];
  let ocupada = false, pendiente = null, refrescando = null, modoPz = true;
  let revision = '', estadoVista = '', errorConexion = '';
  let generacion = 0;
  let camaraMueble = false;
  let gestion = null, productoEdicion = null;
  let sugerencias = [], sugerenciaActiva = -1;
  const descargados = new Map();
  const miLugar = () => propios(activa).find(m => m.id === lugarId);
  const puedeCapturar = () => abierta(activa) && !!miLugar() && !miLugar().terminado;
  const accesoTemporal = () => sesiones.some(s => abierta(s) && propios(s).length > 0);
  const puedeVer = () => !!usuarioLogueado && (admin() || accesoTemporal());

  function columnaCosto(encabezados) {
    const valores = encabezados.map(textoBusqueda);
    const unitario = valores.findIndex(h => /\bCOST[OE]\b.*\bUNIT(?:ARIO)?\b/.test(h));
    if (unitario >= 0) return unitario;
    return valores.findIndex(h => /\bCOST[OE]\b/.test(h)
      && !/\b(TOTAL|IMPORTE|EXTENDIDO|INVENTARIO|VALOR)\b/.test(h));
  }

  function leerCosto(valor) {
    if (valor == null || String(valor).trim() === '') return null;
    const limpio = String(valor).trim().replace(/^MXN\s*/i, '').replace(/[\s$,]/g, '');
    const numero = Number(limpio);
    return limpio && Number.isFinite(numero) && numero >= 0 ? numero : null;
  }

  function precioDeInventario(p) {
    if (Object.hasOwn(p,'precioValuacion')) return leerCosto(p.precioValuacion);
    const precio = leerCosto(p.precio);
    return precio > 0 ? precio : null;
  }

  function valoresUnitarios(p) {
    const costo = leerCosto(p.costo);
    const precio = precioDeInventario(p);
    const origenPrecio = p.precioDeBaseSucursal ? 'Precio U. · inventario de sucursal' : 'Precio U.';
    return {costo, precio, valorUnitario:costo ?? precio,
      origenValor:costo != null ? 'Costo unitario' : precio != null ? origenPrecio : 'Sin valor unitario'};
  }

  async function datos(consulta) {
    if (!supabaseClient) throw new Error('La conexión del inventario no está disponible.');
    const {data, error} = await consulta;
    if (error) throw new Error(error.message);
    return data;
  }

  function actualizarAcceso() {
    const tab = $('tabMuebles');
    if (!tab) return;
    tab.hidden = !puedeVer();
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

  function puedeVerExistencia(s) {
    const habilitados = meta(s)?.verExistencias;
    return Array.isArray(habilitados) ? habilitados.includes(usuarioLogueado) : admin();
  }

  function existenciaDeCaptura(p, nodo) {
    if (!nodo) return;
    nodo.textContent = p?.exis != null && puedeVerExistencia(activa)
      ? `Existencia esperada en la sucursal · ${p.exis} pz` : '';
    nodo.hidden = !nodo.textContent;
  }

  function abrirGestion(sesion) {
    if (sesion ? !puedeEditarSesion(sesion) : !admin()) return;
    const verExistencias = meta(sesion)?.verExistencias;
    gestion = {sesion, nombre: sesion?.nombre || `Inventario ${getSucursal(sucursalActual)?.nombre || ''} ${new Date().toLocaleDateString('es-MX', {month:'short', year:'numeric'})}`,
      sucursal: sesion?.sucursal_id || sucursalActual, total: '', archivoCosto:null,
      grupos: new Map(),
      verExistencias: new Set(Array.isArray(verExistencias) ? verExistencias :
        [usuarioLogueado,...lugares(sesion).map(m => m.usuario)
          .filter(u => u === 'admin' || usuarios[u]?.permisos?.ajustes)])};
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
    for (const usuario of grupos.keys()) {
      if (!listaUsuarios.some(([u]) => u === usuario)) listaUsuarios.push([usuario,{nombre: nombreUsuario(usuario)}]);
    }
    const opciones = listaUsuarios.filter(([u]) => !grupos.has(u)).map(([u,p]) =>
      `<option value="${esc(u)}">${esc(p.nombre || u)} · @${esc(u)}</option>`).join('');
    const gruposHtml = [...grupos].map(([u, muebles]) => `<section class="sesion-mueble-tarjeta">
      <strong>${esc(nombreUsuario(u))} · @${esc(u)}</strong>
      <label class="mueble-permiso">
        <input type="checkbox" data-ver-existencias="${esc(u)}"${gestion.verExistencias.has(u) ? ' checked' : ''}>
        Ver la existencia esperada al escanear
      </label>
      ${muebles.map(m => `<div class="sesion-mueble-asignacion">
        <label>Mueble o área<input maxlength="100" value="${esc(m.nombre)}" data-mueble-nombre="${esc(m.id)}"></label>
        ${sesion ? `<label>Asignado a<select data-traslado="${esc(m.id)}">${listaUsuarios.map(([k,p]) => `<option value="${esc(k)}"${u === k ? ' selected' : ''}>${esc(p.nombre || k)} · @${esc(k)}</option>`).join('')}</select></label>` : boton('quitar-fila','Quitar',m.id,'rojo')}
      </div>`).join('')}
      ${boton('agregar-mueble', 'Agregar mueble', u)}
    </section>`).join('');
    $('muebleGestionCuerpo').innerHTML = `<h3>${sesion ? 'Editar áreas y permisos' : 'Crear sesión por mueble'}</h3>
      ${sesion ? `<p>${esc(nombre)}</p>` : `<label>Nombre de sesión<input id="muebleNombreSesion" maxlength="120" value="${esc(nombre)}"></label>
      <label>Sucursal<select id="muebleSucursal">${sucursales.map(s => `<option value="${esc(s.id)}"${s.id === sucursal ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></label>
      <label>Total de muebles o áreas (opcional)<input id="muebleTotal" type="number" min="1" max="250" value="${esc(total)}"></label>
      <p class="small">Se usa el precio unitario del inventario cargado de la sucursal.</p>
      <details${gestion.archivoCosto ? ' open' : ''}>
        <summary>Valores unitarios adicionales (opcional)</summary>
        <label>Excel con costos o precios unitarios<input id="muebleArchivoCosto" type="file" accept=".xlsx,.xls,.csv"></label>
        <p class="small" id="muebleNombreArchivo">${gestion.archivoCosto ? esc(gestion.archivoCosto.name) : 'Archivo adicional con Clave o SKU.'}</p>
      </details>
      <div id="muebleReparto"${total ? '' : ' hidden'}>${boton('repartir','Repartir automáticamente')}</div>`}
      ${gruposHtml}
      <div class="sesion-mueble-asignacion"><label>Usuario<select id="muebleNuevoUsuario"><option value="">Selecciona un usuario</option>${opciones}</select></label>
      ${boton('agregar-usuario','Agregar usuario')}</div>
      <div class="sesion-mueble-botones">${boton('guardar-gestion',sesion ? 'Guardar áreas y permisos' : 'Crear sesión','','verde')}${boton('cancelar-gestion','Cancelar')}</div>`;
  }

  function recogerGestion() {
    if (!gestion.sesion) {
      gestion.nombre = $('muebleNombreSesion').value;
      gestion.sucursal = $('muebleSucursal').value;
      gestion.total = $('muebleTotal').value;
    }
    for (const campo of $('muebleGestionCuerpo').querySelectorAll('[data-ver-existencias]')) {
      if (campo.checked) gestion.verExistencias.add(campo.dataset.verExistencias);
      else gestion.verExistencias.delete(campo.dataset.verExistencias);
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
    return base.map(p => ({
      sku:normalizar(p.sku), descripcion:p.descripcion || '', exis:Number(p.exis) || 0,
      costo:leerCosto(p.costo), precioValuacion:precioDeInventario(p), codigos:codigos.get(normalizar(p.sku)) || []
    }));
  }

  async function completarValores(base, archivo) {
    if (!window.XLSX) throw new Error('El lector de Excel no está disponible.');
    const libro = XLSX.read(await archivo.arrayBuffer(),{type:'array'});
    const referencias = new Map();
    const esClave = h => /^(SKU|REX|CLAVE|CODIGO)(\s|$)/.test(textoBusqueda(h));
    const columnaPrecio = fila => fila.findIndex(h => /^PRECIO(?:\s+(?:U\.?|UNIT\.?|UNITARIO|(?:DE\s+)?VENTA))?$/.test(textoBusqueda(h)));
    let columnasValidas = false;

    for (const nombre of libro.SheetNames) {
      const tabla = XLSX.utils.sheet_to_json(libro.Sheets[nombre],{header:1,defval:'',raw:true});
      const cabecera = tabla.findIndex(fila => fila.some(esClave) && (columnaCosto(fila) >= 0 || columnaPrecio(fila) >= 0));
      if (cabecera < 0) continue;
      columnasValidas = true;
      const encabezado = tabla[cabecera];
      const clave = encabezado.findIndex(esClave);
      const columnas = [['costo',columnaCosto(encabezado)],['precioValuacion',columnaPrecio(encabezado)]];
      for (const fila of tabla.slice(cabecera + 1)) {
        const sku = normalizar(fila[clave]);
        if (!sku) continue;
        const registro = referencias.get(sku) || {};
        for (const [campo,columna] of columnas) {
          const valor = columna < 0 ? null : leerCosto(fila[columna]);
          if (valor == null) continue;
          registro[campo] = Object.hasOwn(registro,campo) && registro[campo] !== valor ? null : valor;
        }
        referencias.set(sku,registro);
      }
    }
    if (!columnasValidas) throw new Error('El Excel necesita una columna SKU o Clave y Costo unitario o Precio U.');

    let encontrados = 0;
    const snapshot = base.map(p => {
      const referencia = referencias.get(normalizar(p.sku));
      if (referencia?.costo == null && referencia?.precioValuacion == null) return p;
      encontrados++;
      return {...p,costo:referencia.costo ?? leerCosto(p.costo),
        precioValuacion:referencia.precioValuacion ?? precioDeInventario(p)};
    });
    if (!encontrados) throw new Error('No hay costos o precios válidos que coincidan con los SKU de la sesión.');
    return {snapshot,encontrados};
  }

  function snapshotConValoresBase(s, base = inventariosPorSucursal[s.sucursal_id], usarPrecioReferencia = false) {
    const snapshot = s.snapshot_base || [];
    const fecha = meta(s)?.baseFecha;
    const baseOriginal = !!fecha && base?.fechaCargaBase === fecha;
    if (!base?.base?.length || (!baseOriginal && !usarPrecioReferencia)) return snapshot;
    const necesitaValores = p => baseOriginal
      ? !Object.hasOwn(p,'precioValuacion') : valoresUnitarios(p).valorUnitario == null;
    if (!snapshot.some(necesitaValores)) return snapshot;

    const productos = new Map(base.base.map(p => [normalizar(p.sku),p]));
    return snapshot.map(p => {
      if (!necesitaValores(p)) return p;
      const origen = productos.get(normalizar(p.sku));
      if (!origen) return p;
      const precioValuacion = precioDeInventario(origen);
      if (baseOriginal) return {...p,costo:leerCosto(p.costo) ?? leerCosto(origen.costo),
        precioValuacion:precioDeInventario(p) ?? precioValuacion};
      if (precioValuacion == null) return p;
      return {...p,precioValuacion,precioDeBaseSucursal:true};
    });
  }

  async function baseParaReporte(s) {
    const local = inventariosPorSucursal[s.sucursal_id];
    const fecha = meta(s)?.baseFecha;
    if ((fecha && local?.fechaCargaBase === fecha && local.base?.length) ||
        (s.snapshot_base || []).every(p => valoresUnitarios(p).valorUnitario != null)) return local;
    try {
      const {data: remota} = await datos(consultarBaseInventario(s.sucursal_id)) || {};
      const localMasReciente = Date.parse(local?.fechaCargaBase) > Date.parse(remota?.fechaCargaBase);
      return remota?.base?.length && !localMasReciente ? remota : local;
    } catch (error) {
      console.warn('No se pudo consultar el inventario cargado de la sucursal.',error);
      return local;
    }
  }

  async function cargarValoresSesion(idSesion, archivo) {
    const s = await actual(idSesion);
    if (!creador(s) || meta(s).archivada) return;
    const {snapshot,encontrados} = await completarValores(snapshotConValoresBase(s),archivo);
    if (!creador(s)) return;
    const guardada = await actualizarSesion(s,{snapshot_base:snapshot,asignaciones:{[marcador]:{
      ...meta(s), valoresActualizadosEn:new Date().toISOString()
    }}});
    if (activa?.id === s.id) activa = guardada;
    await refrescar();
    toast(`Valores unitarios cargados para ${encontrados} SKU.`);
  }

  async function guardarGestion() {
    recogerGestion();
    const {sesion, sucursal, nombre} = gestion;
    if (sesion ? !puedeEditarSesion(sesion) : !admin()) return;
    const nombres = new Set(), ubicaciones = [];
    for (const m of [...gestion.grupos.values()].flat()) {
      const nombre = m.nombre.trim();
      if (!nombre && !lugares(sesion).some(l => l.id === m.id)) continue;
      if (!nombre || nombres.has(normalizar(nombre))) throw new Error('Cada mueble debe tener un nombre único.');
      nombres.add(normalizar(nombre));
      ubicaciones.push({...m, nombre});
    }
    if (!ubicaciones.length) throw new Error('Agrega al menos un mueble con nombre.');
    if (ubicaciones.length > 250) throw new Error('La sesión admite hasta 250 muebles.');
    if (!sesion && !sucursales.some(s => s.id === sucursal)) throw new Error('Selecciona una sucursal válida.');
    const verExistencias = [...gestion.verExistencias].filter(u => ubicaciones.some(m => m.usuario === u));
    if (sesion) {
      await actualizarSesion(sesion, {asignaciones:{[marcador]:{...meta(sesion), lugares:ubicaciones, verExistencias}}});
    } else {
      let base = inventariosPorSucursal[sucursal]?.base;
      if (!base?.length) {
        await bajarInventarioSupabase(sucursal);
        base = inventariosPorSucursal[sucursal]?.base;
      }
      if (!base?.length || !nombre.trim()) throw new Error('Escribe el nombre y carga el Excel de esa sucursal.');
      const conValores = gestion.archivoCosto ? (await completarValores(base,gestion.archivoCosto)).snapshot : base;
      const snapshot = armarSnapshot(conValores);
      await datos(supabaseClient.from('sesiones_conteo').insert({
        nombre:nombre.trim(), sucursal_id:sucursal, estado:'borrador', creada_por:usuarioLogueado,
        asignaciones:{[marcador]:{lugares:ubicaciones, version:3, verExistencias, baseFecha:inventariosPorSucursal[sucursal]?.fechaCargaBase || null}},
        total_productos:snapshot.length, pagina_tamano:200, snapshot_base:snapshot
      }));
      if (!snapshot.some(p => valoresUnitarios(p).valorUnitario != null)) toast('Sesión creada. El Excel no tiene costos ni precios unitarios.');
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
    const generacionActual = generacion;
    refrescando = (async () => {
      const lista = await listar();
      if (generacionActual !== generacion) return;
      sesiones = lista;
      errorConexion = '';
      actualizarAcceso();
      let cambioDeAcceso = false;
      if (activa) {
        const vigente = sesiones.find(s => s.id === activa.id);
        if (!abierta(vigente) || !propios(vigente).length) {
          salir();
          cambioDeAcceso = true;
          toast('Tu acceso a esta sesión terminó.');
        } else {
          const ubicacionAnterior = miLugar();
          const sesionAnterior = activa;
          const veiaExistencia = puedeVerExistencia(sesionAnterior);
          const actualizada = meta(sesionAnterior).valoresActualizadosEn !== meta(vigente).valoresActualizadosEn
            ? await actual(vigente.id) : {...sesionAnterior, ...vigente};
          if (generacionActual !== generacion || activa !== sesionAnterior) return;
          activa = actualizada;
          if (veiaExistencia !== puedeVerExistencia(activa)) {
            existenciaDeCaptura(null,$('cameraExistenciaSistema'));
            existenciaDeCaptura(null,$('muebleExistenciaCaptura'));
            existenciaDeCaptura(productoEdicion?.p,$('muebleExistenciaSistema'));
            mostrarSugerencias();
          }
          if (!miLugar() || miLugar().terminado !== ubicacionAnterior?.terminado) {
            pausarCamara();
            cerrarProducto();
            if (!miLugar()) {
              lugarId = '';
              filas = [];
            }
            cambioDeAcceso = true;
          }
        }
      }
      if (tabActual === 'muebles') {
        if (cambioDeAcceso) render();
        if (activa && !ocupada && !pendiente) await cargarCapturas();
        const cambio = JSON.stringify([lista,activa?.id,lugarId,revision]);
        const campoEnUso = $('sesionMueblesPanel')?.contains(document.activeElement)
          && document.activeElement.matches('input, select, textarea');
        if (cambio !== estadoVista && (!campoEnUso || avisar) && !ocupada) {
          if (campoEnUso) {
            const campo = document.activeElement.id;
            render();
            $(campo)?.focus();
          } else render();
          estadoVista = cambio;
        } else if (activa && !ocupada) mostrarProductos();
        actualizarAvisoConexion();
      }
    })().catch(error => {
      if (generacionActual !== generacion) return;
      errorConexion = 'No se pudieron actualizar las sesiones. Revisa la conexión y vuelve a intentar.';
      actualizarAvisoConexion();
      if (avisar) toast(error.message, 'error');
      else console.warn(error);
    }).finally(() => {
      if (generacionActual === generacion) refrescando = null;
    });
    return refrescando;
  }

  async function capturas(s, ubicaciones = null, usuario = null) {
    // Limita el tamaño del filtro de PostgREST cuando un usuario tiene muchas áreas.
    if (ubicaciones?.length > 16) {
      const lote = await capturas(s, ubicaciones.slice(0, 16), usuario);
      const resto = await capturas(s, ubicaciones.slice(16), usuario);
      return [...lote, ...resto].sort(ordenCapturas);
    }
    const resultado = [];
    if (ubicaciones && !ubicaciones.length) return resultado;
    for (let desde = 0; ; desde += filasPorPagina) {
      let consulta = supabaseClient.from('conteos_individuales').select('id,sku,usuario,cantidad,dispositivo,timestamp')
        .eq('sesion_id',s.id).order('timestamp').order('id');
      if (usuario !== null) consulta = consulta.eq('usuario',usuario);
      if (ubicaciones) consulta = consulta.in('dispositivo', ubicaciones.flatMap(m => operaciones.map(op => prefijo + m + ':' + op)));
      const lote = await datos(consulta.range(desde,desde + filasPorPagina - 1));
      resultado.push(...lote);
      if (lote.length < filasPorPagina) return resultado;
    }
  }

  function ordenCapturas(a,b) {
    return Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id);
  }

  async function cargarCapturas() {
    const s = activa;
    if (!s) return;
    const anterior = filas;
    const carga = await capturas(s, creador(s) ? null : propios(s).map(m => m.id));
    if (activa === s && anterior === filas && !ocupada && !pendiente) {
      filas = carga;
      revision = carga.length + ':' + (carga.at(-1)?.id || '');
    }
  }

  async function unirse(idSesion) {
    if (sesionActivaUsuario) throw new Error('Primero sal de tu sesión por páginas.');
    const usuario = usuarioLogueado;
    const s = await actual(idSesion);
    if (!abierta(s) || !propios(s).length) throw new Error('La sesión está cerrada o no tienes muebles asignados.');
    if (ocupada || pendiente) throw new Error('Resuelve la captura pendiente antes de cambiar de sesión.');
    const carga = await capturas(s, creador(s) ? null : propios(s).map(m => m.id));
    if (usuario !== usuarioLogueado || !propios(s).length || ocupada || pendiente) return;
    activa = s;
    lugarId = propios(s)[0].id;
    filas = carga;
    revision = carga.length + ':' + (carga.at(-1)?.id || '');
    render();
  }

  function agrupar(s, eventos) {
    const porLugar = new Map(lugares(s).map(m => [m.id, new Map()]));
    for (const e of eventos) {
      const [tipo, lugar, op] = String(e.dispositivo || '').split(':');
      const items = porLugar.get(lugar);
      if (tipo !== 'mueble' || !items || !operaciones.includes(op)) continue;
      const sku = normalizar(e.sku);
      const p = items.get(sku) || {
        sku, cantidad:0, contado:false, antes:0, despues:0, descuentoFisico:0, historial:[], aportes:new Map()
      };
      const cantidad = Number(e.cantidad);
      if (op === 'fijar' || op === 'quitar') {
        p.cantidad = 0;
        p.descuentoFisico = 0;
        p.contado = false;
        p.aportes.clear();
      }
      if (op === 'sumar' || op === 'fijar') {
        p.cantidad += cantidad;
        p.contado = true;
        p.aportes.set(e.usuario, (p.aportes.get(e.usuario) || 0) + cantidad);
      }
      if (op === 'venta-antes') p.antes += cantidad;
      if (op === 'venta-despues') { p.despues += cantidad; p.descuentoFisico += cantidad; }
      p.historial.push({...e, op});
      items.set(sku, p);
    }
    return porLugar;
  }

  function conciliar(s, eventos, porLugar = agrupar(s,eventos),
    snapshot = snapshotConValoresBase(s,inventariosPorSucursal[s.sucursal_id],true)) {
    const acumulados = new Map();
    for (const lugar of lugares(s)) for (const p of porLugar.get(lugar.id).values()) {
      const total = acumulados.get(p.sku) || {
        cantidad:0, antes:0, despues:0, contado:false, descuentoFisico:0, muebles:[], usuarios:new Set()
      };
      total.cantidad += p.cantidad;
      total.antes += p.antes;
      total.despues += p.despues;
      total.descuentoFisico += p.descuentoFisico;
      if (p.contado || p.antes || p.despues) total.muebles.push(lugar.nombre);
      for (const usuario of p.aportes.keys()) total.usuarios.add(usuario);
      total.contado ||= p.contado;
      acumulados.set(p.sku,total);
    }
    const completa = lugares(s).length > 0 && lugares(s).every(m => m.terminado);
    const resumen = snapshot.map(p => {
      const sku = normalizar(p.sku);
      const t = acumulados.get(sku) || {
        cantidad:0, antes:0, despues:0, contado:false, descuentoFisico:0, muebles:[], usuarios:new Set()
      };
      acumulados.delete(sku);
      const observado = t.cantidad - t.descuentoFisico;
      const sistema = p.exis - t.antes - t.despues;
      const diferencia = calcularDif(sistema,observado);
      const cuadra = sistema < 0 ? 'Saldo compensado' : 'Cuadra';
      const falta = sistema < 0 ? 'Saldo negativo' : 'Faltante';
      const estado = completa ? (diferencia === 0 ? 'Cuadra' : diferencia < 0 ? 'Faltante' : 'Sobrante')
        : diferencia > 0 ? 'Sobrante preliminar'
        : t.contado ? (diferencia < 0 ? falta : cuadra) + ' preliminar' : 'Sin conteo';
      return {...p,...t,sku,observado,sistema,diferencia,estado};
    });
    for (const [sku,t] of acumulados) if (t.contado || t.antes || t.despues) resumen.push({sku,...t, descripcion:'Fuera del Excel', estado:'Fuera del Excel'});
    return {porLugar,resumen,completa};
  }

  function diferenciaVisible(p, completa) {
    return completa || p.contado || p.diferencia > 0 ? p.diferencia ?? null : null;
  }

  function render() {
    const panel = $('sesionMueblesPanel');
    if (!panel || !puedeVer()) return;
    const lista = sesiones.filter(s => !meta(s).archivada && (
      (admin() && (s.sucursal_id === sucursalActual || creador(s))) || (abierta(s) && propios(s).length)));
    const tarjetas = lista.map(s => {
      const controles = [], reportes = [];
      const asignado = abierta(s) && propios(s).length > 0;
      if (asignado && activa?.id !== s.id) controles.push(boton('unirse','Unirse a la sesión',s.id,'verde'));
      if (creador(s)) {
        if (s.estado === 'borrador') controles.push(boton('abrir','Abrir sesión',s.id,'verde'));
        if (puedeEditarSesion(s)) controles.push(boton('reasignar','Editar áreas y permisos',s.id));
        if (s.estado === 'abierta') controles.push(boton('cerrar','Cerrar sesión',s.id,'rojo'));
        controles.push(boton('archivar','Eliminar sesión',s.id,'rojo'));
      }
      if (asignado || (creador(s) && s.estado !== 'borrador')) {
        reportes.push(boton('reporte-personal','📥 Descargar mi conteo (Excel)',s.id,'verde'));
      }
      if (creador(s) && s.estado !== 'borrador') {
        const etiqueta = s.estado === 'abierta' ? '📊 Reporte global preliminar (Excel)' : '📊 Reporte global de cierre (Excel)';
        reportes.push(boton('reporte-global',etiqueta,s.id));
      }
      const visibles = creador(s) ? lugares(s) : propios(s);
      const estado = {borrador:'Borrador',abierta:'Abierta',cerrada:'Cerrada'}[s.estado] || s.estado;
      return `<section class="sesion-mueble-tarjeta"><strong>${esc(s.nombre)}</strong>
        <p class="small">${esc(estado)} · ${esc(getSucursal(s.sucursal_id)?.nombre || s.sucursal_id)} · Creada por @${esc(s.creada_por)}</p>
        <p class="small">${visibles.filter(m => m.terminado).length}/${visibles.length} muebles terminados</p>
        ${controles.length ? `<div class="sesion-mueble-botones">${controles.join('')}</div>` : ''}
        ${reportes.length ? `<div class="mueble-reportes">
          <strong class="small">Descargas de la sesión</strong>
          <div class="sesion-mueble-botones">${reportes.join('')}</div>
          ${creador(s) && s.estado !== 'borrador' ? `<details class="small">
            <summary>Valores unitarios adicionales (opcional)</summary>
            ${boton('cargar-valores','Cargar costos o precios (Excel)',s.id)}
          </details>` : ''}
        </div>` : ''}</section>`;
    });
    const filtro = $('muebleFiltro')?.value || '';
    const codigo = $('muebleCodigo')?.value || '';
    const sesionAbierta = $('mueblePanelSesion')?.open ?? true;
    panel.innerHTML = `<details class="panel inv-plegable" id="mueblePanelSesion"${sesionAbierta ? ' open' : ''}>
      <summary>📋 Sesión de conteo por mueble</summary>
      <div class="sesion-mueble-botones">${admin() ? boton('crear','➕ Crear sesión por mueble','','verde',!supabaseClient) : ''}${boton('refrescar','Actualizar sesiones')}</div>
      <p id="muebleConexion" class="small" role="status"></p>
      ${tarjetas.join('') || '<p class="small">No hay sesiones disponibles.</p>'}</details>
      ${activa ? renderTrabajo(filtro,codigo) : ''}`;
    actualizarAvisoConexion();
    if (activa) {
      mostrarProductos();
      mostrarSugerencias();
    }
  }

  function actualizarAvisoConexion() {
    const aviso = $('muebleConexion');
    if (aviso) aviso.textContent = supabaseClient ? errorConexion : 'Configura Supabase para usar las sesiones por mueble.';
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
        <div class="mueble-controles">
          <div class="sesion-mueble-botones">${boton('modo',`⚡ Modo PZ: ${modoPz ? 'Activado' : 'Desactivado'}`,'',modoPz ? 'verde' : 'gris',!puedeCapturar())}
          ${boton('venta','🛒 Registrar venta','','amarillo',!puedeCapturar())}</div>
          <label class="small"><input type="checkbox" id="muebleContinuo"${continuo() ? ' checked' : ''}${puedeCapturar() ? '' : ' disabled'}> Escaneo continuo</label>
        </div>
        <div class="inv-stats" id="muebleMetricas" aria-live="polite"></div>
        <form id="muebleCaptura" class="fila">
          <input id="muebleCodigo" value="${esc(codigo)}" autocomplete="off" autocapitalize="off" spellcheck="false" role="combobox" aria-label="Buscar productos para contar"
            aria-autocomplete="list" aria-expanded="false" aria-controls="muebleOpciones" enterkeyhint="go"
            placeholder="SKU, descripción o código de barras"${puedeCapturar() ? '' : ' disabled'}>
          ${boton('camara','📷','','camara',!puedeCapturar()).replace('<button ', '<button aria-label="Escanear para contar" ')}
        </form>
        <div id="muebleSugerencias" hidden></div>
        <p id="muebleAviso" role="status" class="small"></p>
        <p class="small" id="muebleExistenciaCaptura" hidden></p></section>
      <section class="panel" id="muebleMiZona"><h3>📊 Mi Zona en la Sesión</h3>
        <div class="fila"><input id="muebleFiltro" value="${esc(filtro)}" placeholder="Buscar por nombre, SKU o código">
        ${boton('buscar-camara','Escanear')}</div><div id="muebleProductos" class="mueble-lista"></div></section>
      ${renderPanelResumen()}` : ''}`;
  }

  function renderPanelResumen() {
    const global = creador(activa);
    const filtro = $('muebleResumenFiltro')?.value || '';
    const todos = $('muebleResumenTodos')?.checked;
    return `<section class="panel" id="muebleResumen"><h3>3 · Resumen del conteo</h3>
      <div class="inv-stats${global ? '' : ' mueble-resumen-zona'}" id="muebleResumenStats"></div>
      <input type="search" id="muebleResumenFiltro" aria-label="Filtrar productos del resumen"
        placeholder="Filtrar productos…" value="${esc(filtro)}">
      <div class="tabla-scroll">
        <table id="muebleResumenTabla" class="${global ? 'mueble-resumen-global' : ''}">
          <thead><tr><th scope="col">Clave</th><th scope="col">Descripción</th>
          ${global ? '<th scope="col">Esperado</th>' : ''}<th scope="col">Vendido</th>
          ${global ? '<th scope="col">Ajustado</th>' : ''}<th scope="col">Contado</th>
          ${global ? '<th scope="col">Dif</th><th scope="col">Dif $</th>' : ''}
          <th scope="col">Contó</th><th scope="col" aria-label="Acciones"></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="muebleResumenNota" class="small"></p>
      ${global ? `<label class="small"><input type="checkbox" id="muebleResumenTodos"${todos ? ' checked' : ''}> Mostrar también los que cuadran</label>` : ''}
    </section>`;
  }

  function continuo() {
    try { return localStorage.getItem('fc_relma_mueble_continuo') !== '0'; }
    catch { return true; }
  }

  function mapaProductos() {
    return new Map((activa?.snapshot_base || []).map(p => [normalizar(p.sku),p]));
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
    const q = textoBusqueda($('muebleFiltro').value);
    const capturados = items.filter(p => p.contado);
    lista.innerHTML = capturados.filter(p => {
      const prod = base.get(p.sku);
      return [p.sku,prod?.descripcion,...(prod?.codigos || [])].some(t => textoBusqueda(t).includes(q));
    }).map(p => `<details data-sku="${esc(p.sku)}"${abiertos.has(p.sku) ? ' open' : ''}>
      <summary><strong>${esc(p.sku)}</strong> · ${esc(base.get(p.sku)?.descripcion || 'Fuera del Excel')} · ${p.cantidad} pz</summary>
      <p class="small">${p.historial.filter(e=>['fijar','sumar'].includes(e.op)).length} capturas</p>
      <ul>${p.historial.map(e=>`<li>${esc(momento(e.timestamp))} · @${esc(e.usuario)} · ${esc(etiqueta(e.op))} · ${e.cantidad} pz</li>`).join('')}</ul>
      ${boton('editar','Editar',p.sku,'gris',!puedeCapturar())}
    </details>`).join('') || '<p class="small">Sin productos contados que coincidan.</p>';
    $('muebleMetricas').innerHTML = `<div class="inv-stat ok"><div class="num">${capturados.reduce((n,p)=>n+p.cantidad,0)}</div><div class="lbl">Pz contadas</div></div>
      <div class="inv-stat"><div class="num">${items.reduce((n,p)=>n+p.antes+p.despues,0)}</div><div class="lbl">Pz vendidas</div></div>`;
    mostrarResumen(agrupados);
  }

  function importeDeDiferencia(diferencia, valor) {
    if (diferencia == null) return null;
    if (diferencia === 0) return 0;
    return valor == null ? null : Math.sign(diferencia) * aMoneda(Math.abs(diferencia) * valor);
  }

  function mostrarResumen(agrupados = agrupar(activa,filas)) {
    const tabla = $('muebleResumenTabla');
    if (!tabla) return;
    const zona = agrupados.get(lugarId) || new Map();
    const base = mapaProductos();
    const actividad = p => p.contado || p.antes || p.despues;
    const global = creador(activa);
    const consulta = global ? conciliar(activa,filas,agrupados) : null;
    const completa = consulta?.completa;
    const productos = global
      ? consulta.resumen.filter(p => actividad(p) || (completa && p.diferencia !== 0))
      : [...zona.values()].filter(actividad);
    const totales = {cuadran:0,sobran:0,faltan:0,negativos:0,piezas:0,pesos:0,sinCosto:0,conCosto:0};
    for (const p of productos) {
      if (p.exis < 0) totales.negativos++;
      const diferencia = diferenciaVisible(p,completa);
      if (diferencia == null) continue;
      if (diferencia > 0) totales.sobran++;
      if (diferencia < 0) totales.faltan++;
      if (diferencia === 0) totales.cuadran++;
      totales.piezas += diferencia;
      if (diferencia === 0) continue;
      const importe = importeDeDiferencia(diferencia,valoresUnitarios(p).valorUnitario);
      if (importe == null) totales.sinCosto++;
      else {
        totales.conCosto++;
        totales.pesos += importe;
      }
    }
    const tarjeta = (titulo,valor,tono = '') => `<div class="inv-stat ${tono}"><div class="num">${valor}</div><div class="lbl">${titulo}</div></div>`;
    const signo = n => n > 0 ? '+' : '';
    const color = n => n > 0 ? 'ok' : n < 0 ? 'err' : '';
    const sinImporte = totales.sinCosto > 0 && totales.conCosto === 0;
    $('muebleResumenStats').innerHTML = global
      ? [
          tarjeta('Cuadran',totales.cuadran,totales.cuadran ? 'mueble-cuadra' : ''),
          tarjeta('Sobrantes',totales.sobran,totales.sobran ? 'ok' : ''),
          tarjeta('Faltantes',totales.faltan,totales.faltan ? 'err' : ''),
          tarjeta('Neg. sistema',totales.negativos,totales.negativos ? 'err' : ''),
          tarjeta('Dif $',!sinImporte ? `$${aMoneda(totales.pesos).toFixed(2)}` : '—',color(totales.pesos)),
          tarjeta('Dif piezas',signo(totales.piezas) + totales.piezas,color(totales.piezas))
        ].join('')
      : [
          tarjeta('Productos contados',productos.filter(p => p.contado).length,'ok'),
          tarjeta('Pz contadas',productos.reduce((n,p) => n + p.cantidad,0)),
          tarjeta('Pz vendidas',productos.reduce((n,p) => n + p.antes + p.despues,0)),
          tarjeta('Fuera del Excel',productos.filter(p => !base.has(p.sku)).length)
        ].join('');

    $('muebleResumenNota').textContent = global
      ? [
          completa ? 'Conciliación de toda la sucursal.' : 'Conciliación preliminar de la sucursal. Los faltantes se confirman al terminar todos los muebles.',
          totales.sinCosto ? `${totales.sinCosto} SKU con diferencia sin costo ni precio unitario.` : ''
        ].filter(Boolean).join(' ')
      : `Conteo de ${miLugar().nombre}. Las diferencias se calculan para toda la sucursal.`;

    const filtro = textoBusqueda($('muebleResumenFiltro').value);
    const verTodos = $('muebleResumenTodos');
    if (verTodos) verTodos.disabled = !completa;
    const todos = verTodos?.checked;
    const visibles = productos.filter(p => {
      if (global && completa && !todos && p.diferencia === 0) return false;
      const ficha = base.get(p.sku);
      return [p.sku,p.descripcion || ficha?.descripcion,...(ficha?.codigos || [])].some(v => textoBusqueda(v).includes(filtro));
    });
    tabla.querySelector('tbody').innerHTML = visibles.map(p => {
      const prod = base.get(p.sku);
      const diferencia = global ? diferenciaVisible(p,completa) : null;
      const valores = valoresUnitarios(p);
      const importe = importeDeDiferencia(diferencia,valores.valorUnitario);
      const clase = diferencia > 0 ? 'dif-pos' : diferencia < 0 ? 'dif-neg' : diferencia === 0 ? 'mueble-dif-cero' : '';
      const cuentas = global ? [...p.usuarios] : [...p.aportes.keys()];
      const editar = zona.get(p.sku)?.contado && puedeCapturar();
      const incidencia = !prod ? 'Fuera del Excel' : global && !completa ? p.estado : '';
      return `<tr>
        <td class="mueble-resumen-clave">${esc(p.sku)}</td>
        <td class="small">${esc(p.descripcion || prod?.descripcion)}${incidencia ? `<small class="mueble-resumen-estado">${esc(incidencia)}</small>` : ''}</td>
        ${global ? `<td class="${p.exis < 0 ? 'neg-num' : ''}">${p.exis ?? '—'}</td>` : ''}
        <td>${p.antes + p.despues}</td>
        ${global ? `<td>${p.sistema ?? '—'}</td>` : ''}
        <td><strong>${global ? p.observado ?? p.cantidad : p.cantidad}</strong></td>
        ${global ? `<td class="${clase}">${diferencia == null ? '—' : signo(diferencia) + diferencia}</td>
        <td class="${importe == null ? '' : clase}" title="${valores.origenValor}">${importe == null ? '—' : signo(importe) + '$' + importe.toFixed(2)}</td>` : ''}
        <td class="small">${cuentas.map(u => '@' + esc(u)).join(', ') || '—'}</td>
        <td>${editar ? boton('editar', '🗑', p.sku, 'rojo').replace('<button ', `<button aria-label="Editar o quitar conteo de ${esc(p.sku)}" `) : ''}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="${global ? 10 : 6}" class="small mueble-resumen-vacio">${!filtro && completa && !todos ? 'No hay diferencias.' : 'Sin productos que coincidan.'}</td></tr>`;
  }

  function buscarParaCaptura(consulta) {
    const q = textoBusqueda(consulta);
    const partes = q.split(/\s+/);
    const porSku = [], porCodigo = [], similares = [];
    for (const p of activa?.snapshot_base || []) {
      const sku = textoBusqueda(p.sku);
      const codigos = (p.codigos || []).map(textoBusqueda);
      const descripcion = textoBusqueda(p.descripcion);
      if (sku === q) porSku.push(p);
      else if (codigos.includes(q)) porCodigo.push(p);
      else if (similares.length < 30 && partes.every(t => [sku,descripcion,...codigos].some(valor => valor.includes(t)))) {
        similares.push(p);
      }
    }
    return {productos:[...porSku,...porCodigo,...similares].slice(0,30), codigoCompartido:!porSku.length && porCodigo.length > 1};
  }

  function actualizarSugerencia(moverVista = false) {
    const campo = $('muebleCodigo');
    const filasSugeridas = $('muebleOpciones').querySelectorAll('[role="option"]');
    filasSugeridas.forEach((fila, i) => {
      const seleccionada = i === sugerenciaActiva;
      fila.classList.toggle('sel',seleccionada);
      fila.setAttribute('aria-selected',String(seleccionada));
    });
    const filaActiva = filasSugeridas[sugerenciaActiva];
    if (filaActiva) {
      campo.setAttribute('aria-activedescendant',filaActiva.id);
      if (moverVista) filaActiva.scrollIntoView({block:'nearest'});
    } else campo.removeAttribute('aria-activedescendant');
  }

  function mostrarSugerencias() {
    const campo = $('muebleCodigo'), lista = $('muebleSugerencias');
    if (!campo || !lista) return;
    sugerencias = [];
    sugerenciaActiva = -1;
    lista.hidden = !campo.value.trim() || !puedeCapturar();
    campo.setAttribute('aria-expanded','false');
    campo.removeAttribute('aria-activedescendant');
    if (lista.hidden) {
      lista.replaceChildren();
      lista.classList.remove('tabla-scroll');
      return;
    }
    const resultados = buscarParaCaptura(campo.value);
    sugerencias = resultados.productos;
    lista.classList.toggle('tabla-scroll',sugerencias.length > 0);
    if (!sugerencias.length) {
      lista.innerHTML = modoPz ? '<p class="small" role="status">Sin coincidencias.</p>'
        : '<p class="small" role="status">Sin coincidencias. Presiona Enter para registrar el SKU fuera del Excel.</p>';
      return;
    }

    sugerenciaActiva = resultados.codigoCompartido ? -1 : 0;
    const verExistencia = puedeVerExistencia(activa);
    const conteos = agrupar(activa,filas).get(lugarId);
    lista.innerHTML = `<table id="muebleOpciones" role="listbox" aria-label="Productos encontrados">
      <thead aria-hidden="true"><tr><th>SKU</th><th>Descripción</th>${verExistencia ? '<th>Exis</th>' : ''}<th></th></tr></thead>
      <tbody role="presentation">${sugerencias.map((p,i) => {
        const conteo = conteos?.get(normalizar(p.sku));
        const indicador = conteo?.contado ? `<span class="chip-counted">✔ ${conteo.cantidad}</span>`
          : '<span class="chip-pending">pendiente</span>';
        return `<tr class="resultado" id="muebleOpcion${i}" role="option" data-sugerencia="${i}">
          <td role="presentation">${esc(p.sku)} ${indicador}</td>
          <td role="presentation">${esc(p.descripcion)}</td>
          ${verExistencia ? `<td role="presentation" class="mueble-opcion-exis${p.exis < 0 ? ' neg-num' : ''}">${esc(p.exis ?? '—')}</td>` : ''}
          <td role="presentation" aria-hidden="true">→</td></tr>`;
      }).join('')}</tbody></table>`;
    campo.setAttribute('aria-expanded','true');
    actualizarSugerencia();
  }

  function limpiarBusquedaCaptura() {
    const campo = $('muebleCodigo');
    if (!campo) return;
    campo.value = '';
    mostrarSugerencias();
  }

  async function elegirParaCaptura(p) {
    if (!p || ocupada || !puedeCapturar()) return;
    const sesion = activa.id, mueble = lugarId;
    limpiarBusquedaCaptura();
    existenciaDeCaptura(null,$('muebleExistenciaCaptura'));
    if (!modoPz) {
      abrirCantidad(p);
      return;
    }
    $('muebleCodigo')?.focus();
    try {
      const total = await guardar(p,1,'sumar');
      if (activa?.id !== sesion || lugarId !== mueble || !$('muebleAviso')) return;
      $('muebleAviso').textContent = p.sku + ' · ' + total + ' pz';
      existenciaDeCaptura(p,$('muebleExistenciaCaptura'));
      feedbackExito();
    } catch (error) {
      feedbackError();
      toast(error.message,'error');
    }
  }

  function etiqueta(op) {
    return {sumar:'Escaneo +1',fijar:'Corrección de total',quitar:'Conteo quitado','venta-antes':'Venta antes de contar','venta-despues':'Venta después de contar'}[op] || op;
  }

  function producto(codigo, aceptaDesconocido = false) {
    const sku = normalizar(codigo);
    const base = activa?.snapshot_base || [];
    const exacto = base.find(p => normalizar(p.sku) === sku);
    if (exacto) return exacto;
    const vinculados = base.filter(p => p.codigos?.some(c => normalizar(c) === sku));
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
      if (envio.sesion_id !== activa?.id || envio.usuario !== usuarioLogueado) return 0;
      if (!filas.some(f=>f.id === row.id)) filas = [...filas,row].sort(ordenCapturas);
      pendiente = null;
      mostrarProductos();
      return agrupar(activa,filas).get(lugarId)?.get(normalizar(p.sku))?.cantidad || 0;
    } catch (error) {
      if (envio.sesion_id === activa?.id && envio.usuario === usuarioLogueado && _esErrorRed(error)) {
        pendiente = {clave,id:envio.id,sku:p.sku};
        throw new Error('No se confirmó la captura. Repite la misma operación para verificarla sin duplicar.');
      }
      pendiente = null;
      throw error;
    } finally { ocupada = false; }
  }

  function avisarEscaneo(exito,mensaje,producto = null) {
    if ($('modalCamara')?.classList.contains('activo')) {
      existenciaDeCaptura(producto,$('cameraExistenciaSistema'));
    }
    feedbackResultadoConteo(exito,mensaje);
  }

  async function escanear(p) {
    const corrida = cameraRun;
    try {
      const total = await guardar(p,1,'sumar');
      if (corrida !== cameraRun) return;
      avisarEscaneo(true,`+1 ${p.descripcion || p.sku} · ${total} en ${miLugar()?.nombre || 'este mueble'}`,p);
    } catch (error) {
      if (corrida !== cameraRun) return;
      avisarEscaneo(false,error.message);
      if (!$('modalCamara')?.classList.contains('activo')) toast(error.message,'error');
    }
  }

  function buscarEscaneo(codigo) {
    const filtro = $('muebleFiltro');
    if (!filtro) return;
    filtro.value = codigo;
    mostrarProductos();
    const resultados = $('muebleProductos')?.querySelectorAll('details');
    if (resultados?.length === 1) resultados[0].open = true;
  }

  function abrirCantidad(codigo, editar = false, desdeContinuo = false) {
    try {
      if (!puedeCapturar()) throw new Error('Este mueble ya está terminado.');
      existenciaDeCaptura(null,$('cameraExistenciaSistema'));
      const desdeBusqueda = typeof codigo === 'object';
      const p = desdeBusqueda ? codigo : producto(codigo,editar || (!modoPz && !desdeContinuo));
      if (modoPz && !editar) { void escanear(p); return; }
      const actual = agrupar(activa,filas).get(lugarId)?.get(normalizar(p.sku));
      productoEdicion = {modo:editar ? 'editar' : 'contar',p,desdeBusqueda};
      $('muebleProductoCuerpo').innerHTML = `<h3>${esc(p.sku)}</h3><p>${esc(p.descripcion)}</p>
        <p class="small" id="muebleExistenciaSistema" hidden></p>
        <p class="small">Contado en ${esc(miLugar()?.nombre)} · ${actual?.cantidad || 0} pz</p>
        ${editar && actual?.historial.length ? `<details><summary>Aportaciones en esta sesión</summary><ul>${actual.historial.map(e=>`<li>@${esc(e.usuario)} · ${esc(momento(e.timestamp))} · ${esc(etiqueta(e.op))} · ${e.cantidad} pz</li>`).join('')}</ul></details>` : ''}
        <label>¿Cuántas piezas hay físicamente en este mueble?<input id="muebleCantidad" class="cant-grande" type="number" min="0" max="10000000" step="1" value="${actual?.cantidad ?? 0}" inputmode="numeric"></label>
        <div class="sesion-mueble-botones">${boton('guardar-producto','Guardar','','verde')}${boton('cancelar-producto','Cancelar')}
        ${editar ? boton('quitar-conteo','Quitar conteo de este producto','','rojo') : ''}</div>`;
      existenciaDeCaptura(p,$('muebleExistenciaSistema'));
      $('modalMuebleProducto').classList.add('activo');
      $('muebleCantidad').focus();
    } catch (error) { avisarEscaneo(false,error.message); toast(error.message,'error'); }
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

  function cerrarProducto(restaurarFoco = false) {
    $('modalMuebleProducto')?.classList.remove('activo');
    if (restaurarFoco && productoEdicion?.desdeBusqueda) $('muebleCodigo')?.focus();
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
    const conteo = productoEdicion.modo === 'contar';
    const camaraEnCurso = conteo && $('modalCamara')?.classList.contains('activo');
    const corrida = cameraRun;
    try {
      await guardar(p,cantidad,op);
    } catch (error) {
      if (camaraEnCurso && corrida === cameraRun) avisarEscaneo(false,error.message);
      throw error;
    }
    cerrarProducto(true);
    if (camaraEnCurso && corrida === cameraRun) avisarEscaneo(true,`Guardado · ${p.sku} · ${cantidad} pz`,p);
    limpiarBusquedaCaptura();
    toast(op.startsWith('venta-') ? 'Venta registrada en la sesión' : 'Conteo actualizado');
  }

  async function terminar() {
    if (!miLugar() || ocupada || pendiente) throw new Error('Resuelve la captura pendiente.');
    pausarCamara();
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
    if (accion !== 'abrir' && activa?.id === s.id && (ocupada || pendiente)) {
      throw new Error('Confirma la captura pendiente antes de cerrar o archivar la sesión.');
    }
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
    return JSON.stringify([eventos.length,eventos.at(-1)?.id,lugares(s),meta(s)?.valoresActualizadosEn]);
  }

  function aMoneda(valor) {
    return Math.round((valor + Number.EPSILON) * 100) / 100;
  }

  async function descargar(s, eventos, cuentaPersonal = '') {
    if (!window.XLSX) throw new Error('Excel no está disponible.');
    const baseReferencia = cuentaPersonal ? null : await baseParaReporte(s);
    if (!cuentaPersonal && !creador(s)) return;
    const ubicaciones = new Map(lugares(s).map(m => [m.id,m]));
    const base = new Map((s.snapshot_base || []).map(p => [normalizar(p.sku),p]));
    const porLugar = agrupar(s,eventos);
    const sucursal = getSucursal(s.sucursal_id)?.nombre || s.sucursal_id;
    const wb = XLSX.utils.book_new();
    const moneda = '"$"#,##0.00;-"$"#,##0.00';
    const diferenciaPositiva = {font:{bold:true,color:{rgb:'006100'}},fill:{fgColor:{rgb:'C6EFCE'}}};
    const diferenciaNegativa = {font:{bold:true,color:{rgb:'9C0006'}},fill:{fgColor:{rgb:'FFC7CE'}}};
    const diferenciaCero = {font:{bold:true,color:{rgb:'1E4E79'}},fill:{fgColor:{rgb:'DDEBF7'}}};
    const fecha = 'yyyy-mm-dd hh:mm:ss';
    const cabecera = {
      font:{bold:true,color:{rgb:'FFFFFF'}}, fill:{fgColor:{rgb:'1A3A6B'}},
      alignment:{vertical:'center',wrapText:true}
    };

    function agregarHoja(nombre, encabezados, registros, opciones = {}) {
      const filasHoja = [encabezados,...registros];
      const hoja = XLSX.utils.aoa_to_sheet(filasHoja, {cellDates:true,dateNF:fecha});
      const titulos = new Set(opciones.titulos || [0]);
      hoja['!cols'] = encabezados.map((_,c) => ({wch:opciones.anchos?.[c] ?? 22}));
      hoja['!rows'] = filasHoja.map((_,r) => titulos.has(r) ? {hpt:30} : {});
      for (let r = 0; r < filasHoja.length; r++) {
        for (let c = 0; c < filasHoja[r].length; c++) {
          const celda = hoja[XLSX.utils.encode_cell({r,c})];
          if (!celda) continue;
          if (titulos.has(r)) {
            celda.s = cabecera;
            continue;
          }
          celda.s = {alignment:{vertical:'center',wrapText:c === opciones.texto}};
          if (celda.t === 'n' && (opciones.moneda?.includes(c) || opciones.valorMoneda?.includes(r))) celda.z = moneda;
          const dif = filasHoja[r][opciones.columnaDiferencia];
          if (dif != null && opciones.destacar?.includes(c)) {
            const estilo = dif > 0 ? diferenciaPositiva : dif < 0 ? diferenciaNegativa : diferenciaCero;
            celda.s = {...celda.s,...estilo};
          }
        }
      }
      if (registros.length && opciones.filtro !== false) {
        hoja['!autofilter'] = {ref:XLSX.utils.encode_range({r:0,c:0},{r:registros.length,c:encabezados.length - 1})};
      }
      XLSX.utils.book_append_sheet(wb,hoja,nombre);
    }

    const movimientos = [...porLugar].flatMap(([lugar,items]) =>
      [...items.values()].map(p => ({...p, nombre:ubicaciones.get(lugar).nombre})));
    const fechaCorte = s.fecha_cierre || new Date().toISOString();
    const pendientes = lugares(s).filter(m => !m.terminado).length;
    const filasResumen = [
      ['Tipo de reporte',cuentaPersonal ? 'Mi conteo' : 'Reporte global de la sesión'],
      ['Sesión',s.nombre],['Sucursal',sucursal],['Creó la sesión',nombreUsuario(s.creada_por)],
      ['Estado de sesión',({borrador:'Borrador',abierta:'Abierta',cerrada:'Cerrada'})[s.estado] || s.estado],
      ['Fecha del inventario base',momento(meta(s).baseFecha) || 'Sin fecha registrada'],
      ['Fecha de apertura',momento(s.fecha_apertura)],['Fecha de corte',momento(fechaCorte)]
    ];
    const total = (items,campo) => items.reduce((n,p) => n + (p[campo] || 0),0);
    const ventas = eventos.flatMap(e => {
      const [tipo,lugar,op] = String(e.dispositivo || '').split(':');
      const m = ubicaciones.get(lugar);
      if (tipo !== 'mueble' || !m || !op?.startsWith('venta-')) return [];
      return [[m.nombre,nombreUsuario(e.usuario),e.usuario,normalizar(e.sku),
        base.get(normalizar(e.sku))?.descripcion || 'Fuera del Excel',etiqueta(op),e.cantidad,momento(e.timestamp),e.id]];
    });

    if (cuentaPersonal) {
      filasResumen.push(['Usuario',nombreUsuario(cuentaPersonal)],['Cuenta',cuentaPersonal],
        ['Áreas con capturas',new Set(movimientos.map(p => p.nombre)).size],
        ['SKU contados',new Set(movimientos.filter(p => p.contado).map(p => p.sku)).size],
        ['Piezas registradas',total(movimientos,'cantidad')],
        ['Piezas vendidas',total(movimientos,'antes')+total(movimientos,'despues')],
        ['Alcance','Capturas y ventas registradas por esta cuenta. La conciliación global considera también correcciones de otros usuarios.']);
      agregarHoja('Resumen',['Concepto','Resultado'],filasResumen,{anchos:[33,68],texto:1,filtro:false});
    } else {
      const snapshot = snapshotConValoresBase(s,baseReferencia,true);
      const {resumen,completa} = conciliar(s,eventos,porLugar,snapshot);
      const global = resumen.map(p => {
        const valores = valoresUnitarios(p);
        const difPiezas = diferenciaVisible(p,completa);
        const difImporte = importeDeDiferencia(difPiezas,valores.valorUnitario);
        return {...p,...valores,difPiezas,difImporte,
          faltante:difPiezas < 0 ? -difPiezas : null, sobrante:difPiezas > 0 ? difPiezas : null,
          valorFaltante:difPiezas < 0 && difImporte != null ? -difImporte : null,
          valorSobrante:difPiezas > 0 ? difImporte : null};
      });
      const diferencias = global.filter(p => p.difPiezas != null && p.difPiezas !== 0);
      const sinValor = diferencias.filter(p => p.valorUnitario == null).length;
      const valuadosConPrecio = diferencias.filter(p => p.costo == null && p.precio != null).length;
      const conIncidencias = global.filter(p => p.estado === 'Fuera del Excel');
      filasResumen.push(['Moneda de la valuación','MXN'],['Conciliación',completa ? 'Completa' : 'Preliminar. Los faltantes y sobrantes pueden cambiar al terminar los muebles.'],
        ['Áreas totales',lugares(s).length],['Áreas pendientes',pendientes],
        ['SKU en el inventario base',base.size],['SKU con conteo',global.filter(p => p.contado).length],
        ['Piezas vendidas',total(global,'antes')+total(global,'despues')],
        [completa ? 'Piezas faltantes' : 'Piezas faltantes preliminares',total(diferencias,'faltante')],
        [completa ? 'Piezas sobrantes' : 'Piezas sobrantes preliminares',total(diferencias,'sobrante')],
        ['SKU con diferencia valuados a precio',valuadosConPrecio],
        ['SKU con diferencia sin costo ni precio',sinValor],['SKU fuera del Excel',conIncidencias.length],
        ['Cálculo','Sistema ajustado = sistema al cargar menos ventas registradas. Físico al corte = conteo vigente menos ventas posteriores aún no reflejadas.'],
        ['Dif. pz','Con sistema ajustado negativo se suman las piezas físicas al saldo del sistema. Con saldo de cero o mayor se resta el sistema ajustado del físico.'],
        ['Valuación','Se usa el costo unitario si está disponible y, en su defecto, Precio U. La columna Base de valuación identifica qué se usó por SKU.'],
        ['Colores','Rojo = faltante. Verde = sobrante. Azul = cuadra. Las celdas vacías quedan pendientes o carecen de datos.']);
      if (global.some(p => p.precioDeBaseSucursal)) {
        filasResumen.push(['Inventario de referencia para precios',momento(baseReferencia?.fechaCargaBase)
          || 'Inventario cargado de la sucursal sin fecha registrada']);
      }
      const totalValuado = (items,campo) =>
        !items.length || items.some(p => p[campo] != null) ? aMoneda(total(items,campo)) : null;
      const valoresMoneda = [
        [completa ? 'Valor faltante' : 'Valor faltante preliminar',totalValuado(diferencias.filter(p => p.faltante),'valorFaltante')],
        [completa ? 'Valor sobrante' : 'Valor sobrante preliminar',totalValuado(diferencias.filter(p => p.sobrante),'valorSobrante')],
        ['Dif. $ neta',totalValuado(diferencias,'difImporte')]
      ];
      agregarHoja('Resumen',['Concepto','Resultado'],[...filasResumen,...valoresMoneda],
        {anchos:[37,82],texto:1,valorMoneda:valoresMoneda.map((_,i) => filasResumen.length+i+1),filtro:false});
      const columnas = ['SKU','Descripción','Estado','Sistema al cargar','Ventas antes','Ventas después','Sistema ajustado',
        'Conteo vigente','Físico al corte','Dif. pz','Faltan pz','Sobran pz','Costo unitario','Precio U.','Base de valuación',
        'Dif. $','Valor faltante','Valor sobrante','Áreas registradas','Quién contó'];
      const resultado = p => [p.sku,p.descripcion,p.estado,p.exis ?? null,p.antes,p.despues,p.sistema ?? null,p.cantidad,
        p.observado ?? null,p.difPiezas,p.faltante,p.sobrante,p.costo,p.precio,p.origenValor,p.difImporte,
        p.valorFaltante,p.valorSobrante,p.muebles.join(', '),[...p.usuarios].map(nombreUsuario).join(', ')];
      const opciones = {anchos:[17,42,29,16,14,14,16,15,15,12,12,12,16,14,31,15,16,16,34,30],
        moneda:[12,13,15,16,17],columnaDiferencia:9,destacar:[2,9,10,11,15,16,17]};
      agregarHoja('Diferencias',columnas,[
        ...diferencias.sort((a,b) => a.difPiezas - b.difPiezas || a.sku.localeCompare(b.sku)),...conIncidencias
      ].map(resultado),opciones);
      agregarHoja('Conciliación por SKU',columnas,global.map(resultado),opciones);
    }
    agregarHoja('Por mueble',['Mueble o área','SKU','Descripción','Estado del conteo','Pz registradas','Pz al corte','Ventas antes','Ventas después','Quién contó'],
      movimientos.map(p => [p.nombre,p.sku,base.get(p.sku)?.descripcion || 'Fuera del Excel',p.contado ? 'Contado' : 'Sin conteo vigente',
        p.cantidad,p.cantidad-p.descuentoFisico,p.antes,p.despues,[...p.aportes.keys()].map(nombreUsuario).join(', ')]),
      {anchos:[27,16,40,23,16,15,15,15,32]});
    agregarHoja('Aportaciones',['Mueble o área','SKU','Descripción','Usuario','Cuenta',cuentaPersonal ? 'Pz de tu conteo' : 'Pz de conteo vigente'],
      movimientos.flatMap(p => [...p.aportes].map(([usuario,cantidad]) => [
        p.nombre,p.sku,base.get(p.sku)?.descripcion || 'Fuera del Excel',nombreUsuario(usuario),usuario,cantidad])),
      {anchos:[27,16,40,26,20,20]});
    agregarHoja('Ventas',['Mueble o área','Usuario','Cuenta','SKU','Descripción','Movimiento','Piezas','Fecha y hora','ID del movimiento'],
      ventas,{anchos:[27,25,20,16,40,27,12,24,38]});
    agregarHoja('Historial de capturas',['Mueble o área','Usuario','Cuenta','SKU','Descripción','Movimiento','Piezas','Efecto en conteo','Fecha y hora','ID del movimiento'],
      movimientos.flatMap(p => {
        const ultimaCorreccion = p.historial.findLastIndex(e => e.op === 'fijar' || e.op === 'quitar');
        return p.historial.map((e,i) => [p.nombre,nombreUsuario(e.usuario),e.usuario,p.sku,
          base.get(p.sku)?.descripcion || 'Fuera del Excel',etiqueta(e.op),e.cantidad,
          e.op.startsWith('venta-') ? 'Registrada como salida' : i < ultimaCorreccion ? 'Sustituido' : e.op === 'quitar' ? 'Conteo quitado' : cuentaPersonal ? 'En tu conteo' : 'Vigente',
          momento(e.timestamp),e.id]);
      }),{anchos:[27,25,20,16,40,27,12,24,24,38]});
    if (!cuentaPersonal) agregarHoja('Avance',['Mueble o área','Asignado a','Cuenta','Estado','SKU contados','Pz registradas'],
      lugares(s).map(m => {
        const activos = [...porLugar.get(m.id).values()].filter(p => p.contado);
        return [m.nombre,nombreUsuario(m.usuario),m.usuario,m.terminado ? 'Terminado' : 'Pendiente',activos.length,total(activos,'cantidad')];
      }),{anchos:[28,26,20,18,16,16]});

    const tipoArchivo = cuentaPersonal ? `MI CONTEO - ${cuentaPersonal}`
      : `GLOBAL - ${s.estado === 'cerrada' ? 'CIERRE' : 'PRELIMINAR'}`;
    const fechaArchivo = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Mexico_City'}).format(new Date(fechaCorte));
    const prefijoArchivo = [tipoArchivo,s.nombre,sucursal].join(' - ')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-').slice(0,120);
    XLSX.writeFile(wb,`${prefijoArchivo} - ${fechaArchivo}.xlsx`);
    if (!cuentaPersonal) descargados.set(s.id,huella(eventos,s));
  }

  async function reporteGlobal(idSesion) {
    const s = await actual(idSesion);
    if (creador(s) && s.estado !== 'borrador' && !meta(s).archivada) await descargar(s,await capturas(s));
  }

  async function reportePersonal(idSesion) {
    const usuario = usuarioLogueado;
    if (activa?.id === idSesion && (ocupada || pendiente)) throw new Error('Confirma la captura pendiente antes de exportar.');
    const s = await actual(idSesion);
    const autorizado = () => usuario === usuarioLogueado && !meta(s).archivada &&
      ((abierta(s) && propios(s).length > 0) || (creador(s) && s.estado !== 'borrador'));
    if (!autorizado()) return;
    const propias = (await capturas(s,null,usuario)).filter(e => e.usuario === usuario && String(e.dispositivo).startsWith(prefijo));
    if (!autorizado()) return;
    if (!propias.length) throw new Error('Esta cuenta todavía no tiene capturas en la sesión.');
    await descargar(s,propias,usuario);
  }

  function pausarCamara() {
    if (!camaraMueble) return;
    cerrarCamara();
    camaraMueble = false;
  }

  function abrirCamaraMueble(origen) {
    camaraMueble = true;
    return abrirCamara(origen);
  }

  function salir() {
    pausarCamara();
    cerrarProducto();
    activa = null;
    lugarId = '';
    pendiente = null;
    filas = [];
  }

  function reiniciar() {
    salir();
    gestion = null;
    sesiones = [];
    refrescando = null;
    errorConexion = '';
    estadoVista = '';
    descargados.clear();
    generacion++;
    actualizarAcceso();
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
    pausarCamara();
    cerrarProducto();
    limpiarBusquedaCaptura();
    lugarId = nuevo;
    render();
  }

  document.addEventListener('DOMContentLoaded',()=>{
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-bg" id="modalMuebleGestion"><div class="modal" id="muebleGestionCuerpo"></div></div>
      <div class="modal-bg" id="modalMuebleProducto"><div class="modal" id="muebleProductoCuerpo"></div></div>
      <input type="file" id="muebleValoresArchivo" hidden accept=".xlsx,.xls,.csv">`);
    document.addEventListener('input',e=>{
      if (e.target.id === 'muebleTotal') $('muebleReparto').hidden = !e.target.value;
      if (e.target.id === 'muebleCodigo') mostrarSugerencias();
      if (e.target.id === 'muebleFiltro') mostrarProductos();
      if (e.target.id === 'muebleResumenFiltro') mostrarResumen();
    });
    document.addEventListener('keydown',e=>{
      if (e.target.id !== 'muebleCodigo' || e.isComposing) return;
      if (e.key === 'Escape' && e.target.value) {
        e.preventDefault();
        limpiarBusquedaCaptura();
      }
      if (!sugerencias.length || !['ArrowDown','ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      sugerenciaActiva = e.key === 'ArrowDown'
        ? Math.min(sugerenciaActiva + 1,sugerencias.length - 1) : Math.max(sugerenciaActiva - 1,0);
      actualizarSugerencia(true);
    });
    document.addEventListener('paste',e=>{
      if (e.target.id !== 'muebleCodigo' || !puedeCapturar() || ocupada || pendiente) return;
      const texto = e.clipboardData?.getData('text');
      const codigo = texto?.match(/(?:^|\s)(\d{8,14})(?=\s|$)/)?.[1];
      if (!codigo) return;
      const resultado = buscarParaCaptura(codigo);
      if (!resultado.productos.some(p => normalizar(p.sku) === codigo ||
        p.codigos?.some(c => normalizar(c) === codigo))) return;
      e.preventDefault();
      e.target.value = codigo;
      mostrarSugerencias();
      if (!resultado.codigoCompartido) e.target.form.requestSubmit();
    });
    document.addEventListener('change',e=>{
      if (e.target.id === 'muebleValoresArchivo') {
        const archivo = e.target.files[0];
        const sesion = e.target.dataset.sesion;
        e.target.value = '';
        if (archivo && sesion) void ejecutar(e.target,()=>cargarValoresSesion(sesion,archivo));
      }
      if (e.target.id === 'muebleResumenTodos') mostrarResumen();
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
          gestion.grupos.get(nuevo).push({...m,usuario:nuevo,terminado:false});
          renderGestion();
          break;
        }
      }
    });
    document.addEventListener('click',e=>{
      const opcion = e.target.closest('#muebleOpciones [data-sugerencia]');
      if (opcion) {
        void elegirParaCaptura(sugerencias[Number(opcion.dataset.sugerencia)]);
        return;
      }
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
        'reporte-global':()=>reporteGlobal(valor), 'reporte-personal':()=>reportePersonal(valor),
        'cargar-valores':()=>{
          const input = $('muebleValoresArchivo');
          input.dataset.sesion = valor;
          input.click();
        },
        modo:()=>{if (pendiente) throw new Error('Resuelve la captura pendiente.'); modoPz=!modoPz; render();},
        camara:()=>abrirCamaraMueble(continuo() ? 'mueble-captura' : 'mueble-captura-unica'),
        'buscar-camara':()=>abrirCamaraMueble('mueble-busqueda'),
        venta:()=>abrirVenta(), 'camara-venta':()=>abrirCamaraMueble('mueble-venta'),
        editar:()=>abrirCantidad(valor,true),'guardar-producto':()=>guardarProducto(),
        'quitar-conteo':()=>guardarProducto(true),'cancelar-producto':()=>cerrarProducto(true)
      };
      if (tareas[sm]) void ejecutar(control,tareas[sm]);
    });
    document.addEventListener('submit',e=>{
      if (e.target.id !== 'muebleCaptura') return;
      e.preventDefault();
      const codigo = $('muebleCodigo').value.trim();
      if (!codigo || ocupada || !puedeCapturar()) return;
      if (sugerenciaActiva >= 0) {
        void elegirParaCaptura(sugerencias[sugerenciaActiva]);
        return;
      }
      if (sugerencias.length) {
        toast('Selecciona un producto de la lista.');
        return;
      }
      if (modoPz) {
        feedbackError();
        toast('Código fuera del Excel. Verifica el SKU.','error');
        return;
      }
      const sku = normalizar(codigo);
      if (sku.length > 120) {
        toast('La clave debe tener hasta 120 caracteres.','error');
        return;
      }
      limpiarBusquedaCaptura();
      abrirCantidad({sku,descripcion:'Fuera del Excel'});
    });
    setInterval(()=>{ if (usuarioLogueado && !document.hidden) void refrescar(); },12000);
  });

  window.sesionesMueble = {render,refrescar,reiniciar,pausarCamara,puedeVer,actualizarAcceso,
    columnaCosto,leerCosto,buscarEscaneo,abrirCantidad,buscarVenta,
    pausarLectura:()=>ocupada || $('modalMuebleProducto')?.classList.contains('activo')};

})();
