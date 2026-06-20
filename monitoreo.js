/* ═══════════════════════════════════════════════════════════════
   MONITOREO JURÍDICO — Dashboard de procesos Rama Judicial
   ───────────────────────────────────────────────────────────────
   Requiere: supabaseClient, currentUser, toast() — de app.js
   Llama directamente a la API pública de Rama Judicial (CORS: *)
   v2 — integra Publicaciones Procesales (Rama Judicial)
═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ── Constantes ──────────────────────────────────────────────*/
  const POLL_INTERVAL_MS  = 6 * 60 * 60 * 1000;  // polling pesado (consulta RJ) cada 6h
  const REFRESH_DB_MS     = 10 * 60 * 1000;       // polling ligero (sólo Supabase) cada 10 min
  const PAGE_SIZE         = 10;
  const INACTIVO_DIAS     = 90;
  const RJ_API    = "https://consultaprocesos.ramajudicial.gov.co:448/api/v2";
  const RJ_PORTAL = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const PP_PORTAL = "https://publicacionesprocesales.ramajudicial.gov.co/web/publicaciones-procesales";
  const RJ_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "es-CO,es;q=0.9",
    "Origin": "https://consultaprocesos.ramajudicial.gov.co",
    "Referer": "https://consultaprocesos.ramajudicial.gov.co/",
  };

  /* ── Estado ──────────────────────────────────────────────────*/
  let todosLosSeguimientos = [];
  let filtroActivo  = "todos";
  let busqueda      = "";
  let paginaActual  = 1;
  let pollingTimer  = null;
  let monitoreoActivo = false;
  let actuacionesCache  = {};   // id → actuaciones[]
  let publicacionesCache = {};  // id → publicaciones[]
    // Persistir estado abierto/cerrado de paneles de publicaciones entre navegaciones
    const _PUBS_KEY = "monitoreo_pubs_abiertos";
    let pubsAbiertos = new Set(
      (() => { try { return JSON.parse(sessionStorage.getItem(_PUBS_KEY) || "[]"); } catch { return []; } })()
    );
    function _syncPubsStorage() {
      try { sessionStorage.setItem(_PUBS_KEY, JSON.stringify([...pubsAbiertos])); } catch {}
    }
  let actsPagina        = {};   // id → página actual (1-indexed)
  let pubsPagina        = {};   // id → página actual (1-indexed)
  const PAGE_ITEMS      = 10;

  /* ── Notificaciones de consulta ──────────────────────────────*/
  let consultaLogs    = [];   // { ts, total, fallos, error }
  let consultaLogsPag = 1;
  const LOGS_PER_PAG  = 10;

  /* ── Accesores seguros a globales de app.js ─────────────────*/
  function getUser()       { try { return typeof currentUser         !== "undefined" ? currentUser         : null; } catch (_) { return null; } }
  function getClient()     { try { return typeof supabaseClient      !== "undefined" ? supabaseClient      : null; } catch (_) { return null; } }
  function getSuscripcion(){ try { return typeof suscripcionMonitoreo !== "undefined" ? suscripcionMonitoreo : null; } catch (_) { return null; } }
  function showToast(msg, type) { try { if (typeof toast === "function") toast(msg, type); } catch (_) {} }

  const LIMITE_BASICO = 20;

  /* ── Clasificación ───────────────────────────────────────────*/
  function clasificar(s) {
    if (s.tiene_cambios) return "novedad";
    if (!s.ultima_actuacion) return "inactivo";
    const dias = (Date.now() - new Date(s.ultima_actuacion)) / 86400000;
    return dias <= INACTIVO_DIAS ? "activo" : "inactivo";
  }

  /* ══════════════════════════════════════════════════════════════
     INICIALIZACIÓN
  ══════════════════════════════════════════════════════════════ */
  async function iniciarMonitoreo() {
    let user = getUser();
    if (!user) {
      const client = getClient();
      if (client) {
        try { const { data } = await client.auth.getSession(); user = data?.session?.user || null; } catch (_) {}
      }
    }
    if (!user) { renderNoAuth(); return; }

    if (!monitoreoActivo) {
      monitoreoActivo = true;
      renderShell();
      await cargarLogs();
      actualizarContadorLogs();
      await cargarTodos();
      iniciarPolling();
    }
  }

  /* ══════════════════════════════════════════════════════════════
     SHELL
  ══════════════════════════════════════════════════════════════ */
  function renderNoAuth() {
    const c = document.getElementById("monitoreo-content");
    if (!c) return;
    monitoreoActivo = false;
    c.innerHTML = `
      <div class="mon-empty">
        <div class="mon-empty-icon">${IC.scales}</div>
        <h3>Accede para usar el Monitoreo Jurídico</h3>
        <p>Necesitas una cuenta para guardar y monitorear tus procesos ante la Rama Judicial de Colombia.</p>
        <div class="mon-empty-actions">
          <button class="btn btn-accent" onclick="showSection('usuarios')">Iniciar sesión</button>
          <button class="btn btn-outline" onclick="iniciarMonitoreo()">Reintentar</button>
        </div>
      </div>`;
  }

  function renderShell() {
    const c = document.getElementById("monitoreo-content");
    if (!c) return;
    c.innerHTML = `
      <div class="mon-dashboard">
        <div class="mon-kpi-row" id="mon-kpi-row">${kpiSkeleton()}</div>
        <div class="mon-panel">
          <aside class="mon-sidebar">
            <nav class="mon-nav" id="mon-nav">
              ${navItem("todos",          IC.list,         "Todos")}
              ${navItem("novedad",        IC.bell,         "Con novedades RJ")}
              ${navItem("novedad_pp",     IC.newspaper,    "Con novedades PP")}
              ${navItem("activo",         IC.check,        "Activos")}
              ${navItem("inactivo",       IC.clock,        "Sin actividad")}
              ${navItem("notif_consulta", IC.alertCircle,  "Notificaciones de consulta")}
            </nav>
            <div class="mon-sidebar-divider"></div>
            <button class="mon-sidebar-add" id="btn-toggle-form">
              ${IC.plus} Agregar proceso
            </button>
            <button class="mon-sidebar-logout" id="mon-btn-logout">
              ${IC.logOut} Cerrar sesión
            </button>
          </aside>
          <div class="mon-main">
            <div class="mon-form-collapse" id="mon-form-wrap" style="display:none">
              <form id="form-add-radicado" class="mon-form-inner">
                <div class="mon-form-fields">
                  <div class="mon-add-field">
                    <label for="input-radicado">Número de radicado <span class="mon-req">*</span></label>
                    <input type="text" id="input-radicado"
                      placeholder="23 dígitos, sin espacios"
                      maxlength="27" autocomplete="off" inputmode="numeric" />
                  </div>
                  <div class="mon-add-field">
                    <label for="input-alias">Alias <span class="mon-opt">(opcional)</span></label>
                    <input type="text" id="input-alias"
                      placeholder="Ej: Demanda arrendamiento" maxlength="80" />
                  </div>
                </div>
                <div class="mon-form-actions">
                  <button type="submit" class="btn btn-accent" id="btn-add-radicado">${IC.plus} Agregar</button>
                  <button type="button" class="btn btn-outline" id="btn-cancel-form">Cancelar</button>
                </div>
              </form>
            </div>
            <div class="mon-toolbar">
              <div class="mon-search-wrap">
                ${IC.search}
                <input type="search" id="mon-search" class="mon-search"
                  placeholder="Buscar por radicado o alias…" autocomplete="off" />
              </div>
              <button class="mon-btn-refresh-all" id="btn-refresh-all">
                ${IC.refresh} Actualizar todos
              </button>
            </div>
            <div id="mon-list"><div class="mon-skeleton-list">${skeletonCards(3)}</div></div>
            <div class="mon-pagination" id="mon-pagination"></div>
          </div>
        </div>
      </div>`;
    bindShellEvents();
  }

  function bindShellEvents() {
    document.getElementById("btn-toggle-form").addEventListener("click", toggleForm);
    document.getElementById("btn-cancel-form").addEventListener("click", toggleForm);
    document.getElementById("form-add-radicado").addEventListener("submit", onAgregarRadicado);
    document.getElementById("btn-refresh-all").addEventListener("click", () => actualizarTodos(true));
    document.getElementById("mon-btn-logout")?.addEventListener("click", async () => {
      const client = getClient();
      if (client) await client.auth.signOut();
      window.location.reload();
    });
    const searchEl = document.getElementById("mon-search");
    let searchTimer;
    searchEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        busqueda = searchEl.value.trim().toLowerCase();
        paginaActual = 1;
        renderLista();
      }, 250);
    });
    document.getElementById("mon-nav").addEventListener("click", e => {
      const item = e.target.closest(".mon-nav-item");
      if (!item) return;
      filtroActivo = item.dataset.filter;
      paginaActual = 1;
      document.querySelectorAll(".mon-nav-item").forEach(el => el.classList.toggle("active", el === item));
      renderLista();
    });
  }

  function navItem(filter, icon, label) {
    return `<button class="mon-nav-item${filter === "todos" ? " active" : ""}" data-filter="${filter}">
      <span class="mon-nav-icon">${icon}</span>
      <span class="mon-nav-label">${label}</span>
      <span class="mon-nav-count" id="nav-count-${filter}">—</span>
    </button>`;
  }

  function toggleForm() {
    const wrap = document.getElementById("mon-form-wrap");
    const open = wrap.style.display !== "none";
    wrap.style.display = open ? "none" : "block";
    document.getElementById("btn-toggle-form").classList.toggle("active", !open);
    if (!open) document.getElementById("input-radicado")?.focus();
  }

  /* ══════════════════════════════════════════════════════════════
     CARGA DE DATOS — sin actuaciones ni publicaciones (performance)
  ══════════════════════════════════════════════════════════════ */
  async function cargarTodos() {
    const client = getClient();
    const user   = getUser();
    if (!client || !user) return;

    const SEL_BASE = "id, radicado, alias, despacho, sujetos, id_proceso, ultima_actuacion, tiene_cambios, ultimo_chequeo, created_at, tiene_publicacion_nueva, pub_count";
    let rq = await client
      .from("seguimientos")
      .select(SEL_BASE + ", ultima_publicacion")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    // Si la columna ultima_publicacion aún no existe en la BD, reintentamos sin ella
    if (rq.error && (rq.error.code === "42703" || (rq.error.message || "").includes("ultima_publicacion"))) {
      rq = await client
        .from("seguimientos")
        .select(SEL_BASE)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
    }

    const { data, error } = rq;
    if (error) { console.error(error); return; }

    todosLosSeguimientos = data || [];
    actuacionesCache  = {};
    publicacionesCache = {};
    renderKPIs();
    renderNavCounts();
    renderLista();
  }

  /* ══════════════════════════════════════════════════════════════
     KPI CARDS
  ══════════════════════════════════════════════════════════════ */
  function renderKPIs() {
    const total      = todosLosSeguimientos.length;
    const novedad    = todosLosSeguimientos.filter(s => s.tiene_cambios).length;
    const conPub     = todosLosSeguimientos.filter(s => s.tiene_publicacion_nueva).length;
    const activos    = todosLosSeguimientos.filter(s => clasificar(s) === "activo").length;
    const inactivos  = todosLosSeguimientos.filter(s => clasificar(s) === "inactivo").length;

    const el = document.getElementById("mon-kpi-row");
    if (!el) return;
    el.innerHTML = `
      ${kpiCard("Total procesos",           total,    IC.folder,    "",          () => setFiltro("todos"))}
      ${kpiCard("Con novedades (RJ)",        novedad,  IC.bell,      "kpi-accent",() => setFiltro("novedad"))}
      ${kpiCard("Publicaciones nuevas",      conPub,   IC.newspaper, "kpi-pub",  () => {})}
      ${kpiCard("Sin actividad +90 días",    inactivos,IC.clockOff,  "kpi-warn", () => setFiltro("inactivo"))}`;

    el.querySelectorAll(".mon-kpi").forEach((card, i) => {
      card.addEventListener("click", [
        () => setFiltro("todos"),
        () => setFiltro("novedad"),
        () => {},
        () => setFiltro("inactivo"),
      ][i]);
    });
  }

  function kpiCard(label, value, icon, cls, _onClick) {
    return `<div class="mon-kpi ${cls}" role="button" tabindex="0">
      <div class="mon-kpi-icon">${icon}</div>
      <div class="mon-kpi-body">
        <div class="mon-kpi-value">${value}</div>
        <div class="mon-kpi-label">${label}</div>
      </div>
    </div>`;
  }

  function kpiSkeleton() {
    return `<div class="mon-kpi mon-skel"></div>`.repeat(4);
  }

  function setFiltro(f) {
    filtroActivo = f;
    paginaActual = 1;
    document.querySelectorAll(".mon-nav-item").forEach(el =>
      el.classList.toggle("active", el.dataset.filter === f));
    renderLista();
  }

  /* ══════════════════════════════════════════════════════════════
     CONTADORES SIDEBAR
  ══════════════════════════════════════════════════════════════ */
  function renderNavCounts() {
    const counts = { todos: 0, novedad: 0, novedad_pp: 0, activo: 0, inactivo: 0 };
    todosLosSeguimientos.forEach(s => {
      counts.todos++;
      counts[clasificar(s)]++;
      if (s.tiene_publicacion_nueva) counts.novedad_pp++;
    });
    Object.keys(counts).forEach(k => {
      const el = document.getElementById(`nav-count-${k}`);
      if (el) el.textContent = counts[k];
    });
    actualizarContadorLogs();
  }

  /* ══════════════════════════════════════════════════════════════
     FILTRAR + PAGINAR + RENDERIZAR LISTA
  ══════════════════════════════════════════════════════════════ */
  function datosFiltrados() {
    return todosLosSeguimientos.filter(s => {
      if (filtroActivo === "novedad_pp") {
        if (!s.tiene_publicacion_nueva) return false;
      } else if (filtroActivo !== "todos" && clasificar(s) !== filtroActivo) return false;
      if (busqueda) {
        const hay = (s.radicado + (s.alias || "") + (s.despacho || "")).toLowerCase();
        if (!hay.includes(busqueda)) return false;
      }
      return true;
    });
  }

  function renderLista() {
    const el = document.getElementById("mon-list");
    if (!el) return;

    if (filtroActivo === "notif_consulta") {
      renderLogs();
      return;
    }

    const filtrados = datosFiltrados();
    const totalPags = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
    if (paginaActual > totalPags) paginaActual = totalPags;
    const desde = (paginaActual - 1) * PAGE_SIZE;
    const pagina = filtrados.slice(desde, desde + PAGE_SIZE);

    if (filtrados.length === 0) {
      el.innerHTML = `<div class="mon-empty mon-empty-inline">
        ${todosLosSeguimientos.length === 0
          ? `${IC.scales}<p>Aún no tienes procesos. Usa <strong>Agregar proceso</strong> para comenzar.</p>`
          : `${IC.search}<p>Ningún proceso coincide con tu búsqueda o filtro.</p>`}
      </div>`;
      renderPaginacion(0, 0);
      return;
    }

    el.innerHTML = pagina.map(s => renderTarjeta(s)).join("");
    bindTarjetaEvents(pagina);
    renderPaginacion(filtrados.length, totalPags);
    renderNavCounts();
  }

  /* ══════════════════════════════════════════════════════════════
     TARJETA
  ══════════════════════════════════════════════════════════════ */
  function renderTarjeta(s) {
    const clase = clasificar(s);
    const fecha = s.ultimo_chequeo
      ? new Date(s.ultimo_chequeo).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
      : "Nunca";
    const ultimaAct = s.ultima_actuacion
      ? new Date(s.ultima_actuacion).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" })
      : null;
    const diasDesde = s.ultima_actuacion
      ? Math.floor((Date.now() - new Date(s.ultima_actuacion)) / 86400000)
      : null;

    const diasDesdePP = s.ultima_publicacion
      ? Math.floor((Date.now() - new Date(s.ultima_publicacion)) / 86400000)
      : null;

    const estadoLabel = { novedad: "Con novedad", activo: "Activo", inactivo: "Sin actividad" }[clase];
    const estadoCls   = { novedad: "mon-estado-novedad", activo: "mon-estado-activo", inactivo: "mon-estado-inactivo" }[clase];
    const pubCount    = s.pub_count || 0;

    return `
    <div class="mon-card mon-card-${clase}" id="moncard-${s.id}">
      <div class="mon-card-body">
        <div class="mon-card-left">
          <div class="mon-card-top-row">
            <span class="mon-estado ${estadoCls}">${estadoLabel}</span>
            ${s.tiene_cambios         ? `<span class="mon-badge-new">Nueva actuación</span>` : ""}
            ${s.tiene_publicacion_nueva ? `<span class="mon-badge-pub">${IC.newspaper} Publicación nueva</span>` : ""}
          </div>
          <div class="mon-card-radicado">${escHtml(s.radicado)}</div>
          ${s.alias ? `<div class="mon-card-alias">${escHtml(s.alias)}</div>` : ""}
          <div class="mon-card-details">
            ${s.despacho ? `<span class="mon-detail">${IC.building} ${escHtml(s.despacho.trim())}</span>` : ""}
            ${s.sujetos  ? `<span class="mon-detail">${IC.users} ${escHtml(s.sujetos.replace(/\r?\n\t+/g, " · ").trim())}</span>` : ""}
          </div>
        </div>

        <div class="mon-card-right">
          <div class="mon-card-metrics">
            <div class="mon-metric">
              <span class="mon-metric-value${!ultimaAct ? " mon-metric-empty" : ""}">${ultimaAct || "—"}</span>
              <span class="mon-metric-label">Último movimiento</span>
            </div>
            <div class="mon-metric">
              <span class="mon-metric-value${diasDesde === null ? " mon-metric-empty" : (diasDesde > INACTIVO_DIAS ? " mon-metric-warn" : "")}">${diasDesde !== null ? diasDesde : "—"}</span>
              <span class="mon-metric-label">días sin act. RJ <i class="mon-info-icon" data-tip="Días transcurridos desde la última actuación registrada en el portal Consulta Procesos de la Rama Judicial.">i</i></span>
            </div>
            ${diasDesdePP !== null ? `
            <div class="mon-metric">
              <span class="mon-metric-value ${diasDesdePP > INACTIVO_DIAS ? "mon-metric-warn" : ""}">${diasDesdePP}</span>
              <span class="mon-metric-label">días sin pub. PP</span>
            </div>` : ""}
          </div>
          <div class="mon-card-actions">
            <a class="mon-action-btn" href="${RJ_PORTAL}" target="_blank" rel="noopener" title="Ver en Rama Judicial">
              ${IC.link}<span>Rama Judicial</span>
            </a>
            <button class="mon-action-btn" id="btn-refresh-${s.id}" title="Actualizar proceso">
              ${IC.refresh}
            </button>
            <button class="mon-action-btn mon-action-danger" id="btn-delete-${s.id}" title="Eliminar">
              ${IC.trash}
            </button>
          </div>
        </div>
      </div>

      <div class="mon-card-foot">
        <span class="mon-foot-meta">${IC.clockSm} Última consulta: ${fecha}</span>
        <div class="mon-foot-toggles">
          <button class="mon-toggle-acts" id="btn-ver-${s.id}" data-id="${s.id}">
            Ver actuaciones ${IC.chevron}
          </button>
          ${pubCount > 0 ? `
          <button class="mon-toggle-pubs ${pubsAbiertos.has(s.id) ? "mon-toggle-open" : ""} ${s.tiene_publicacion_nueva ? "mon-toggle-pubs-new" : ""}" id="btn-pubs-${s.id}" data-id="${s.id}">
            ${IC.newspaper} Publicaciones ${s.tiene_publicacion_nueva ? `<span class="mon-pub-count">1</span>` : ""} ${IC.chevron}
          </button>` : ""}
        </div>
      </div>

      <div class="mon-actuaciones" id="actuaciones-${s.id}" style="display:none">
        <div class="mon-acts-loading" id="acts-loading-${s.id}">
          <div class="loading-spinner" style="width:24px;height:24px;margin:20px auto;display:block;"></div>
        </div>
      </div>

      ${pubCount > 0 ? `
      <div class="mon-publicaciones-panel" id="pubs-panel-${s.id}" style="display:${pubsAbiertos.has(s.id) ? 'block' : 'none'}">
        <div class="mon-pubs-loading" id="pubs-loading-${s.id}">
          <div class="loading-spinner" style="width:24px;height:24px;margin:20px auto;display:block;"></div>
        </div>
      </div>` : ""}
    </div>`;
  }

  function bindTarjetaEvents(pagina) {
    pagina.forEach(s => {
      document.getElementById(`btn-refresh-${s.id}`)?.addEventListener("click", () => actualizarUno(s, true));
      document.getElementById(`btn-delete-${s.id}`)?.addEventListener("click",  () => eliminar(s.id));
      document.getElementById(`btn-ver-${s.id}`)?.addEventListener("click",     () => toggleActuaciones(s));
      document.getElementById(`btn-pubs-${s.id}`)?.addEventListener("click",    () => togglePublicaciones(s));

      // Restaurar panel si estaba abierto antes de re-renderizar
      if (pubsAbiertos.has(s.id)) {
        if (publicacionesCache[s.id]) {
          renderPublicaciones(s.id, publicacionesCache[s.id]);
        } else {
          cargarPublicacionesDemanda(s);
        }
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════
     ACTUACIONES — carga bajo demanda
  ══════════════════════════════════════════════════════════════ */
  async function toggleActuaciones(s) {
    const panel = document.getElementById(`actuaciones-${s.id}`);
    const btn   = document.getElementById(`btn-ver-${s.id}`);
    if (!panel) return;

    const abierto = panel.style.display !== "none";
    panel.style.display = abierto ? "none" : "block";
    btn?.classList.toggle("mon-toggle-open", !abierto);

    if (!abierto) {
      if (!actuacionesCache[s.id] || actuacionesCache[s.id].length === 0) {
        await cargarActuacionesDemanda(s);
      } else {
        renderActuaciones(s.id, actuacionesCache[s.id]);
      }
    }
  }

  async function cargarActuacionesDemanda(s) {
    const client = getClient();
    if (!client) return;
    const { data } = await client
      .from("seguimientos")
      .select("actuaciones, id_proceso")
      .eq("id", s.id)
      .single();

    let acts = Array.isArray(data?.actuaciones) ? data.actuaciones : [];

    // Si la DB tiene la lista vacía pero el proceso existe en RJ, ir a buscarlo
    if (acts.length === 0 && (data?.id_proceso || s.id_proceso)) {
      const panel = document.getElementById(`actuaciones-${s.id}`);
      if (panel) panel.innerHTML = `<p class="mon-acts-empty" style="color:var(--text-muted)">Obteniendo actuaciones desde Rama Judicial…</p>`;
      try {
        const idProceso = data?.id_proceso || s.id_proceso;
        const rAct = await fetch(`${RJ_API}/Proceso/Actuaciones/${idProceso}?pagina=1`, { headers: RJ_HEADERS });
        if (rAct.ok) {
          const dAct = await rAct.json();
          const fetched = Array.isArray(dAct.actuaciones) ? dAct.actuaciones
                        : Array.isArray(dAct) ? dAct : [];
          if (fetched.length > 0) {
            acts = fetched;
            const ultimaAct = fetched[0]?.fechaActuacion || null;
            await client.from("seguimientos").update({
              actuaciones:      acts,
              ultima_actuacion: ultimaAct,
              ultimo_chequeo:   new Date().toISOString(),
            }).eq("id", s.id);
            // Actualizar estado local
            const idx = todosLosSeguimientos.findIndex(x => x.id === s.id);
            if (idx !== -1) {
              todosLosSeguimientos[idx].ultima_actuacion = ultimaAct;
              todosLosSeguimientos[idx].ultimo_chequeo   = new Date().toISOString();
            }
            renderKPIs();
            renderNavCounts();
            renderLista();
          }
        }
      } catch (_) { /* si falla la consulta a RJ, muestra vacío */ }
    }

    actuacionesCache[s.id] = acts;
    renderActuaciones(s.id, acts);
  }

  function renderActuaciones(id, acts) {
    const loading = document.getElementById(`acts-loading-${id}`);
    if (loading) loading.remove();

    const panel = document.getElementById(`actuaciones-${id}`);
    if (!panel) return;

    if (acts.length === 0) {
      panel.innerHTML = `<p class="mon-acts-empty">Sin actuaciones registradas para este proceso.</p>`;
      return;
    }

    const pag       = actsPagina[id] || 1;
    const totalPags = Math.ceil(acts.length / PAGE_ITEMS);
    const slice     = acts.slice((pag - 1) * PAGE_ITEMS, pag * PAGE_ITEMS);

    panel.innerHTML = `
      <div class="mon-acts-header">
        <span>${IC.fileText} ${acts.length} actuación${acts.length !== 1 ? "es" : ""}</span>
      </div>
      <div class="mon-acts-list">
        ${slice.map((a, i) => `
          <div class="mon-act-row ${a.esNueva ? "mon-act-new" : ""}">
            <div class="mon-act-timeline">
              <div class="mon-act-dot ${a.esNueva ? "mon-act-dot-new" : ""}"></div>
              ${i < slice.length - 1 ? '<div class="mon-act-line"></div>' : ""}
            </div>
            <div class="mon-act-body">
              <div class="mon-act-fecha">${a.fechaActuacion ? new Date(a.fechaActuacion).toLocaleDateString("es-CO", { day:"2-digit", month:"short", year:"numeric" }) : ""}</div>
              <div class="mon-act-nombre">${escHtml(a.actuacion || "")}</div>
              ${a.anotacion ? `<div class="mon-act-anot">${escHtml(a.anotacion)}</div>` : ""}
            </div>
          </div>`).join("")}
      </div>
      ${totalPags > 1 ? `<div class="mon-item-pager">
        <button class="mon-pager-btn" ${pag <= 1 ? "disabled" : `onclick="window._cambiarPaginaItem('acts','${id}',${pag - 1})"`}>‹ Ant.</button>
        <span class="mon-pager-info">${pag} / ${totalPags}</span>
        <button class="mon-pager-btn" ${pag >= totalPags ? "disabled" : `onclick="window._cambiarPaginaItem('acts','${id}',${pag + 1})"`}>Sig. ›</button>
      </div>` : ""}`;
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLICACIONES PROCESALES — carga bajo demanda
  ══════════════════════════════════════════════════════════════ */
  async function togglePublicaciones(s) {
    const panel = document.getElementById(`pubs-panel-${s.id}`);
    const btn   = document.getElementById(`btn-pubs-${s.id}`);
    if (!panel) return;

    const abierto = panel.style.display !== "none";
    panel.style.display = abierto ? "none" : "block";
    btn?.classList.toggle("mon-toggle-open", !abierto);
    if (abierto) pubsAbiertos.delete(s.id); else pubsAbiertos.add(s.id);
      _syncPubsStorage();

    if (!abierto) {
      if (!publicacionesCache[s.id]) {
        await cargarPublicacionesDemanda(s);
      } else {
        renderPublicaciones(s.id, publicacionesCache[s.id]);
        if (s.tiene_publicacion_nueva) await marcarPPVista(s.id);
      }
    }
  }

  async function cargarPublicacionesDemanda(s) {
    const client = getClient();
    if (!client) return;
    const { data } = await client
      .from("seguimientos")
      .select("publicaciones_procesales, tiene_publicacion_nueva")
      .eq("id", s.id)
      .single();

    const pubs = Array.isArray(data?.publicaciones_procesales) ? data.publicaciones_procesales : [];
    publicacionesCache[s.id] = pubs;
    renderPublicaciones(s.id, pubs);
    if (data?.tiene_publicacion_nueva) await marcarPPVista(s.id);
  }

  async function marcarPPVista(segId) {
    const client = getClient();
    if (!client) return;
    await client
      .from("seguimientos")
      .update({ tiene_publicacion_nueva: false })
      .eq("id", segId);
    const idx = todosLosSeguimientos.findIndex(x => x.id === segId);
    if (idx !== -1) todosLosSeguimientos[idx].tiene_publicacion_nueva = false;
    const badge = document.querySelector(`#moncard-${segId} .mon-badge-pub`);
    if (badge) badge.remove();
    const btn = document.getElementById(`btn-pubs-${segId}`);
    if (btn) {
      btn.classList.remove("mon-toggle-pubs-new");
      const cntBadge = btn.querySelector(".mon-pub-count");
      if (cntBadge) cntBadge.remove();
    }
    renderKPIs();
    renderNavCounts();
  }
  window._marcarPPVista = marcarPPVista;

  function renderPublicaciones(id, pubs) {
    const loading = document.getElementById(`pubs-loading-${id}`);
    if (loading) loading.remove();

    const panel = document.getElementById(`pubs-panel-${id}`);
    if (!panel) return;

    if (!pubs.length) {
      panel.innerHTML = `<p class="mon-acts-empty">No se han detectado publicaciones procesales para este proceso.</p>`;
      return;
    }

    const ppBase = "https://publicacionesprocesales.ramajudicial.gov.co";

    const pagPub       = pubsPagina[id] || 1;
    const totalPagsPub = Math.ceil(pubs.length / PAGE_ITEMS);
    const slicePub     = pubs.slice((pagPub - 1) * PAGE_ITEMS, pagPub * PAGE_ITEMS);

    panel.innerHTML = `
      <div class="mon-pub-header">
        ${IC.newspaper}
        <span>${pubs.length} publicación${pubs.length !== 1 ? "es" : ""} detectada${pubs.length !== 1 ? "s" : ""} en tu juzgado</span>
        <span class="mon-pub-header-hint">Las marcadas con ${IC.checkCircle} contienen tu radicado</span>
      </div>
      <div class="mon-pub-list">
        ${slicePub.map(p => {
          const pdfHref = p.pdfUrl
            ? (p.pdfUrl.startsWith("http") ? p.pdfUrl : `${ppBase}${p.pdfUrl}`)
            : null;
          const portalHref = pdfHref || PP_PORTAL;
          const fecha = p.fecha || p.fechaRadicado || "";
          const fechaStr = fecha
            ? new Date(fecha).toLocaleDateString("es-CO", { day:"2-digit", month:"short", year:"numeric" })
            : "";
          return `
          <div class="mon-pub-item ${p.radicadoEncontrado ? "mon-pub-item-match" : ""}">
            <div class="mon-pub-item-top">
              ${p.radicadoEncontrado
                ? `<span class="mon-pub-found">${IC.checkCircle} Radicado encontrado</span>`
                : `<span class="mon-pub-court">${IC.building2} En tu juzgado</span>`}
              ${fechaStr ? `<span class="mon-pub-date">${fechaStr}</span>` : ""}
            </div>
            <div class="mon-pub-title">${escHtml(p.title || "Sin título")}</div>
            ${p.nomDespacho ? `<div class="mon-pub-despacho">${escHtml(p.nomDespacho)}</div>` : ""}
            <div class="mon-pub-item-actions">
              <button class="mon-action-btn mon-action-pp" onclick="window._abrirPortalPP('${escHtml(portalHref)}', '${id}')" title="${pdfHref ? 'Abrir PDF de la publicación' : 'Ir al portal de Publicaciones Procesales'}">
                ${pdfHref ? IC.filePdf : IC.link}<span>${pdfHref ? 'Ver publicación (PDF)' : 'Ir al portal'}</span>
              </button>
            </div>
          </div>`;
        }).join("")}
      </div>
      ${totalPagsPub > 1 ? `<div class="mon-item-pager">
        <button class="mon-pager-btn" ${pagPub <= 1 ? "disabled" : `onclick="window._cambiarPaginaItem('pubs','${id}',${pagPub - 1})"`}>‹ Ant.</button>
        <span class="mon-pager-info">${pagPub} / ${totalPagsPub}</span>
        <button class="mon-pager-btn" ${pagPub >= totalPagsPub ? "disabled" : `onclick="window._cambiarPaginaItem('pubs','${id}',${pagPub + 1})"`}>Sig. ›</button>
      </div>` : ""}`;
  }

  /* ══════════════════════════════════════════════════════════════
     PAGINACIÓN
  ══════════════════════════════════════════════════════════════ */
  function renderPaginacion(total, totalPags) {
    const el = document.getElementById("mon-pagination");
    if (!el) return;

    if (totalPags <= 1) { el.innerHTML = ""; return; }

    const desde = (paginaActual - 1) * PAGE_SIZE + 1;
    const hasta = Math.min(paginaActual * PAGE_SIZE, total);

    let pagBtns = "";
    paginasVisibles(paginaActual, totalPags).forEach(p => {
      if (p === "…") pagBtns += `<span class="mon-pag-ellipsis">…</span>`;
      else pagBtns += `<button class="mon-pag-btn ${p === paginaActual ? "active" : ""}" data-pag="${p}">${p}</button>`;
    });

    el.innerHTML = `
      <div class="mon-pag-info">${desde}–${hasta} de ${total}</div>
      <div class="mon-pag-controls">
        <button class="mon-pag-btn mon-pag-nav" id="pag-prev" ${paginaActual === 1 ? "disabled" : ""}>${IC.chevLeft}</button>
        ${pagBtns}
        <button class="mon-pag-btn mon-pag-nav" id="pag-next" ${paginaActual === totalPags ? "disabled" : ""}>${IC.chevRight}</button>
      </div>`;

    el.querySelectorAll(".mon-pag-btn[data-pag]").forEach(btn =>
      btn.addEventListener("click", () => { paginaActual = +btn.dataset.pag; renderLista(); scroll2List(); }));
    el.querySelector("#pag-prev")?.addEventListener("click", () => { paginaActual--; renderLista(); scroll2List(); });
    el.querySelector("#pag-next")?.addEventListener("click", () => { paginaActual++; renderLista(); scroll2List(); });
  }

  function paginasVisibles(actual, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [1];
    if (actual > 3) pages.push("…");
    for (let p = Math.max(2, actual - 1); p <= Math.min(total - 1, actual + 1); p++) pages.push(p);
    if (actual < total - 2) pages.push("…");
    pages.push(total);
    return pages;
  }

  function scroll2List() {
    document.getElementById("mon-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ══════════════════════════════════════════════════════════════
     AGREGAR
  ══════════════════════════════════════════════════════════════ */
  async function onAgregarRadicado(e) {
    e.preventDefault();
    const raw   = (document.getElementById("input-radicado")?.value || "").replace(/\s/g, "");
    const alias = (document.getElementById("input-alias")?.value || "").trim();

    if (!/^\d{23}$/.test(raw)) { showToast("El radicado debe tener exactamente 23 dígitos.", "error"); return; }
    if (todosLosSeguimientos.some(s => s.radicado === raw)) { showToast("Ya tienes ese radicado en seguimiento.", "error"); return; }

    const suscripcion = getSuscripcion();
    if (suscripcion?.plan === "basico" && todosLosSeguimientos.length >= LIMITE_BASICO) {
      showToast(`El Plan Básico permite hasta ${LIMITE_BASICO} procesos. Actualiza a Premium para agregar más.`, "error");
      return;
    }

    const btn = document.getElementById("btn-add-radicado");
    btn.disabled = true; btn.innerHTML = `${IC.spinner} Consultando…`;

    try {
      const resultado = await consultarRamaJudicial(raw);
      if (!resultado) return;

      const { proceso, actuaciones } = resultado;
      const client = getClient();
      const user   = getUser();

      const { data, error } = await client
        .from("seguimientos")
        .insert({
          user_id:         user.id,
          radicado:        raw,
          alias:           alias || null,
          nombre_proceso:  proceso.tipoProceso   || null,
          despacho:        proceso.despacho      || null,
          sujetos:         proceso.sujetosProcesales || null,
          id_proceso:      String(proceso.idProceso),
          actuaciones,
          ultima_actuacion: actuaciones[0]?.fechaActuacion || null,
          tiene_cambios:   false,
          ultimo_chequeo:  new Date().toISOString(),
        })
        .select("id, radicado, alias, despacho, sujetos, id_proceso, ultima_actuacion, tiene_cambios, ultimo_chequeo, created_at, tiene_publicacion_nueva, pub_count")
        .single();

      if (error) throw error;

      actuacionesCache[data.id]   = actuaciones;
      publicacionesCache[data.id] = [];
      todosLosSeguimientos.unshift(data);
      document.getElementById("input-radicado").value = "";
      document.getElementById("input-alias").value    = "";
      toggleForm();
      renderKPIs();
      renderNavCounts();
      renderLista();
      showToast("Proceso agregado al monitoreo.", "ok");
    } catch (err) {
      console.error(err);
      showToast("Error al agregar el proceso. Intenta de nuevo.", "error");
    } finally {
      btn.disabled = false; btn.innerHTML = `${IC.plus} Agregar`;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     CONSULTAR Rama Judicial
  ══════════════════════════════════════════════════════════════ */
  async function consultarRamaJudicial(radicado) {
    try {
      const r = await fetch(
        `${RJ_API}/Procesos/Consulta/NumeroRadicacion?numero=${radicado}&SoloActivos=false&pagina=1`,
        { headers: RJ_HEADERS }
      );
      if (!r.ok) { showToast("Error consultando la Rama Judicial.", "error"); return null; }
      const d = await r.json();
      if (!d.procesos?.length) { showToast("No se encontró ningún proceso con ese radicado.", "error"); return null; }

      // Iterar todos los procesos del resultado; algunos radicados devuelven varios
      // y solo uno de ellos tiene actuaciones indexadas en la API.
      let proceso = d.procesos[0];
      let actuaciones = [];
      for (const proc of d.procesos) {
        const rAct = await fetch(`${RJ_API}/Proceso/Actuaciones/${proc.idProceso}?pagina=1`, { headers: RJ_HEADERS });
        const dAct = rAct.ok ? await rAct.json() : {};
        const acts = Array.isArray(dAct.actuaciones) ? dAct.actuaciones
                   : Array.isArray(dAct) ? dAct : [];
        proceso = proc;
        actuaciones = acts;
        if (acts.length > 0) break; // Encontramos el proceso con actuaciones
      }
      return { proceso, actuaciones };
    } catch (err) {
      console.error(err);
      showToast("No se pudo conectar con la Rama Judicial.", "error");
      return null;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     CONSULTAR PUBLICACIONES PROCESALES (vía API de Rama Judicial)
  ══════════════════════════════════════════════════════════════ */
  async function consultarPublicacionesProcesales(s) {
    if (!s.id_proceso) return { pubs: [], error: null };
    try {
      const r = await fetch(
        `${RJ_API}/Proceso/Publicaciones/${s.id_proceso}?pagina=1`,
        { headers: RJ_HEADERS }
      );
      // 404 = el proceso no tiene publicaciones procesales indexadas — no es un error real
      if (!r.ok) return { pubs: [], error: null };

      // Intentar parsear como JSON; si el servidor devuelve HTML de error, lo detectamos
      let d;
      try {
        d = await r.json();
      } catch (_jsonErr) {
        return { pubs: [], error: "PP: respuesta inválida del servidor (no es JSON)" };
      }

      const pubs = Array.isArray(d.publicaciones) ? d.publicaciones
                 : Array.isArray(d) ? d : [];
      return { pubs, error: null };
   } catch (_) {
  return { pubs: [], error: null };
}
  }

  /* ══════════════════════════════════════════════════════════════
     ACTUALIZAR UNO — consulta RJ + Publicaciones Procesales
  ══════════════════════════════════════════════════════════════ */
  async function actualizarUno(s, manual = false) {
    const btnR = document.getElementById(`btn-refresh-${s.id}`);
    const orig = btnR?.innerHTML;
    if (btnR) { btnR.disabled = true; btnR.innerHTML = IC.spinner; }

    let ppError = null;

    try {
      let prevActs = actuacionesCache[s.id];
      if (!prevActs) {
        const { data } = await getClient().from("seguimientos").select("actuaciones").eq("id", s.id).single();
        prevActs = data?.actuaciones || [];
        actuacionesCache[s.id] = prevActs;
      }

      // ── Consultar Rama Judicial ──
      const resultado = await consultarRamaJudicial(s.radicado);
      if (!resultado) return { ok: false, error: "No se obtuvo respuesta de la Rama Judicial" };

      const { proceso, actuaciones } = resultado;
      const cambio = actuaciones[0]?.fechaActuacion !== prevActs[0]?.fechaActuacion;
      // Si la API devuelve vacío pero teníamos datos, conservar los previos (evita borrado por fallo de red)
      const actsBase = actuaciones.length > 0 ? actuaciones : prevActs;
      const acts     = actsBase.map((a, i) => ({ ...a, esNueva: i === 0 && cambio && actuaciones.length > 0 }));
      const ahora  = new Date().toISOString();

      // ── Consultar Publicaciones Procesales ──
      const { pubs, error: errPP } = await consultarPublicacionesProcesales(s);
      ppError = errPP;

      // Detectar publicación nueva comparando cantidad con lo que había
      let prevPubs = publicacionesCache[s.id];
      if (!prevPubs) {
        const { data: dpub } = await getClient()
          .from("seguimientos")
          .select("publicaciones_procesales")
          .eq("id", s.id)
          .single();
        prevPubs = Array.isArray(dpub?.publicaciones_procesales) ? dpub.publicaciones_procesales : [];
        publicacionesCache[s.id] = prevPubs;
      }
      const pubNueva   = pubs.length > (prevPubs?.length || 0);
      const ultimaPub  = pubs[0]?.fecha || pubs[0]?.fechaRadicado || null;

      // ── Actualizar Supabase con RJ + PP ──
      // Solo sobreescribir actuaciones si la API devolvió datos; si devuelve vacío, conservar las previas
      const actsParaGuardar = actuaciones.length > 0 ? acts : prevActs;
      const updatePayload = {
        despacho:                 proceso.despacho            || s.despacho,
        sujetos:                  proceso.sujetosProcesales   || s.sujetos,
        actuaciones:              actsParaGuardar,
        ultima_actuacion:         actuaciones[0]?.fechaActuacion || (prevActs[0]?.fechaActuacion || null),
        tiene_cambios:            cambio,
        ultimo_chequeo:           ahora,
        publicaciones_procesales: pubs,
        pub_count:                pubs.length,
        tiene_publicacion_nueva:  pubNueva || (s.tiene_publicacion_nueva && !pubNueva ? s.tiene_publicacion_nueva : pubNueva),
      };
      if (ultimaPub) updatePayload.ultima_publicacion = ultimaPub;

      await getClient().from("seguimientos").update(updatePayload).eq("id", s.id);

      actuacionesCache[s.id]   = acts;
      publicacionesCache[s.id] = pubs;

      const idx = todosLosSeguimientos.findIndex(x => x.id === s.id);
      if (idx !== -1) Object.assign(todosLosSeguimientos[idx], {
        despacho:                proceso.despacho          || s.despacho,
        sujetos:                 proceso.sujetosProcesales || s.sujetos,
        ultima_actuacion:        actuaciones[0]?.fechaActuacion || null,
        tiene_cambios:           cambio,
        ultimo_chequeo:          ahora,
        pub_count:               pubs.length,
        tiene_publicacion_nueva: pubNueva,
        ultima_publicacion:      ultimaPub || todosLosSeguimientos[idx].ultima_publicacion,
      });

      renderKPIs();
      renderNavCounts();
      renderLista();

      // ── Guardar log en actualización individual manual ──
      if (manual) {
        const fallos = errPP ? 1 : 0;
        await guardarLog({
          ts:     ahora,
          total:  1,
          fallos,
          error:  errPP
            ? `PP: ${errPP}`
            : null,
        });
        const msgs = [];
        if (cambio)   msgs.push(`Nueva actuación en ${s.alias || s.radicado.slice(-6)}`);
        if (pubNueva) msgs.push("Nueva publicación procesal detectada");
        if (errPP)    msgs.push(`Error PP: ${errPP}`);
        if (!msgs.length) msgs.push("Sin cambios en RJ ni en Publicaciones Procesales.");
        showToast(msgs.join(" · "), errPP ? "error" : (cambio || pubNueva) ? "ok" : "");
      } else {
        if (cambio)   showToast(`Nuevo movimiento: ${s.alias || s.radicado.slice(-6)}`, "ok");
        else if (pubNueva) showToast(`Nueva publicación PP: ${s.alias || s.radicado.slice(-6)}`, "ok");
      }
      return { ok: true, ppError };
    } catch (err) {
      console.error(err);
      if (manual) showToast("Error al actualizar.", "error");
      return { ok: false, error: err?.message || "Error de conexión" };
    } finally {
      if (btnR) { btnR.disabled = false; btnR.innerHTML = orig || IC.refresh; }
    }
  }

  /* ══════════════════════════════════════════════════════════════
     ACTUALIZAR TODOS — consulta RJ + PP para cada proceso
  ══════════════════════════════════════════════════════════════ */
  async function actualizarTodos(manual = false) {
    if (!todosLosSeguimientos.length) {
      if (manual) showToast("No tienes procesos en seguimiento.", "");
      return;
    }
    const btn = document.getElementById("btn-refresh-all");
    if (btn) { btn.disabled = true; btn.innerHTML = `${IC.spinner} Consultando…`; }

    const lista = [...todosLosSeguimientos];
    let rjErrCount  = 0;
    let ppErrCount  = 0;
    let lastRjErr   = null;
    let lastPpErr   = null;

    for (let i = 0; i < lista.length; i += 5) {
      const resultados = await Promise.allSettled(lista.slice(i, i + 5).map(s => actualizarUno(s, false)));
      resultados.forEach(r => {
        const val = r.status === "fulfilled" ? r.value : { ok: false, error: r.reason?.message };
        if (!val?.ok)     { rjErrCount++; if (val?.error)   lastRjErr = val.error; }
        if (val?.ppError) { ppErrCount++; lastPpErr = val.ppError; }
      });
    }

    const totalFallos = rjErrCount + ppErrCount;
    const ahora = new Date().toISOString();

    // Construir mensaje de error descriptivo para el log
    let errorMsg = null;
    if (rjErrCount > 0 && ppErrCount > 0) {
      errorMsg = `RJ: ${rjErrCount} error(es) (${lastRjErr}). PP: ${ppErrCount} error(es) (${lastPpErr}).`;
    } else if (rjErrCount > 0) {
      errorMsg = `Consulta RJ: ${lastRjErr}`;
    } else if (ppErrCount > 0) {
      errorMsg = `Publicaciones PP: ${lastPpErr}`;
    }

    // Guardar log con resultados de RJ y PP
    await guardarLog({ ts: ahora, total: lista.length, fallos: totalFallos, error: errorMsg });

    // Refrescar desde Supabase
    try { await cargarTodos(); } catch(_) {}

    if (btn) { btn.disabled = false; btn.innerHTML = `${IC.refresh} Actualizar todos`; }
    if (manual) showToast(
      totalFallos > 0
        ? `${totalFallos} consulta(s) fallida(s). Revisa las Notificaciones de consulta.`
        : "Rama Judicial y Publicaciones Procesales actualizados.",
      totalFallos > 0 ? "error" : "ok"
    );
  }

  /* ══════════════════════════════════════════════════════════════
     ELIMINAR
  ══════════════════════════════════════════════════════════════ */
  async function eliminar(id) {
    if (!confirm("¿Eliminar este proceso del monitoreo?")) return;
    const { error } = await getClient().from("seguimientos").delete().eq("id", id);
    if (error) { showToast("Error al eliminar.", "error"); return; }
    todosLosSeguimientos = todosLosSeguimientos.filter(s => s.id !== id);
    delete actuacionesCache[id];
    delete publicacionesCache[id];
    delete actsPagina[id];
    delete pubsPagina[id];
    renderKPIs();
    renderNavCounts();
    renderLista();
    showToast("Proceso eliminado.", "");
  }

  /* ══════════════════════════════════════════════════════════════
     POLLING
  ══════════════════════════════════════════════════════════════ */
  let refreshDbTimer = null;

  function iniciarPolling() {
    if (pollingTimer)   clearInterval(pollingTimer);
    if (refreshDbTimer) clearInterval(refreshDbTimer);

    // Polling pesado: consulta la Rama Judicial cada 6 horas
    pollingTimer = setInterval(() => {
      if (getUser() && todosLosSeguimientos.length) actualizarTodos(false);
    }, POLL_INTERVAL_MS);

    // Polling ligero: refresca sólo desde Supabase cada 10 minutos
    // (recoge cambios del cron automático sin llamar a la API de la RJ)
    refreshDbTimer = setInterval(async () => {
      if (getUser() && monitoreoActivo) {
        await cargarTodos();
        await cargarLogs();
        actualizarContadorLogs();
        if (filtroActivo === "notif_consulta") renderLogs();
      }
    }, REFRESH_DB_MS);

    // Refrescar también cuando el usuario vuelve a la pestaña
    document.addEventListener("visibilitychange", _onVisibilityChange);
  }

  async function _onVisibilityChange() {
    if (!document.hidden && getUser() && monitoreoActivo) {
      await cargarTodos();
      await cargarLogs();
      actualizarContadorLogs();
      if (filtroActivo === "notif_consulta") renderLogs();
    }
  }

  /* ══════════════════════════════════════════════════════════════
     SKELETONS
  ══════════════════════════════════════════════════════════════ */
  function skeletonCards(n) {
    return `<div class="mon-skeletons">${`<div class="mon-skel-card"><div class="mon-skel mon-skel-line w60"></div><div class="mon-skel mon-skel-line w40"></div><div class="mon-skel mon-skel-line w80"></div></div>`.repeat(n)}</div>`;
  }

  /* ══════════════════════════════════════════════════════════════
     UTILIDADES
  ══════════════════════════════════════════════════════════════ */
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ══════════════════════════════════════════════════════════════
     ICON SET — SVG Lucide inline
  ══════════════════════════════════════════════════════════════ */
  const IC = {
    list:        `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
    bell:        `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    check:       `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    clock:       `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    clockOff:    `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><line x1="2" y1="2" x2="22" y2="22" stroke-width="1.5"/></svg>`,
    clockSm:     `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    folder:      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    search:      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    refresh:     `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
    trash:       `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
    link:        `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    plus:        `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    chevron:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    chevLeft:    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    chevRight:   `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    building:    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/><path d="M15 9h3"/><path d="M15 15h3"/></svg>`,
    building2:   `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/><path d="M15 9h3"/><path d="M15 15h3"/></svg>`,
    users:       `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    fileText:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    filePdf:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
    newspaper:   `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg>`,
    checkCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    scales:      `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><path d="M3 9h18"/><path d="M3 9l4.5 9S3 18 3 9z"/><path d="M21 9l-4.5 9S21 18 21 9z"/><path d="M9 21h6"/></svg>`,
    spinner:     `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:mon-spin 0.8s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
    logOut:      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
    alertCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  /* ══════════════════════════════════════════════════════════════
     NOTIFICACIONES DE CONSULTA — Supabase
  ══════════════════════════════════════════════════════════════ */
  async function cargarLogs() {
    const user = getUser();
    if (!user) return;
    try {
      const { data, error } = await getClient()
        .from("consulta_logs")
        .select("id, ts, total, fallos, error_msg")
        .eq("user_id", user.id)
        .order("ts", { ascending: false })
        .limit(200);
      if (!error) consultaLogs = (data || []).map(r => ({
        id: r.id, ts: r.ts, total: r.total, fallos: r.fallos, error: r.error_msg
      }));
    } catch(_) {}
  }

  async function guardarLog(entry) {
    const user = getUser();
    if (!user) return;
    // Actualización optimista: muestra en UI inmediatamente, sin esperar a Supabase
    const localEntry = { id: null, ts: entry.ts, total: entry.total, fallos: entry.fallos, error: entry.error || null };
    consultaLogs.unshift(localEntry);
    if (consultaLogs.length > 200) consultaLogs = consultaLogs.slice(0, 200);
    actualizarContadorLogs();
    if (filtroActivo === "notif_consulta") renderLogs();
    // Persistir en Supabase (en segundo plano — requiere que exista la tabla consulta_logs)
    try {
      const { data, error } = await getClient()
        .from("consulta_logs")
        .insert({
          user_id:   user.id,
          ts:        entry.ts,
          total:     entry.total,
          fallos:    entry.fallos,
          error_msg: entry.error || null,
        })
        .select("id, ts, total, fallos, error_msg")
        .single();
      if (!error && data) {
        localEntry.id = data.id;
        localEntry.ts = data.ts;
      }
    } catch(_) {}
  }

  function actualizarContadorLogs() {
    const el = document.getElementById("nav-count-notif_consulta");
    if (!el) return;
    // No mostrar números — solo mostrar "—" siempre (el historial sigue visible al entrar)
    el.textContent = "—";
    el.classList.remove("mon-nav-count-error");
  }

  function renderLogs() {
    const listEl  = document.getElementById("mon-list");
    const pagEl   = document.getElementById("mon-pagination");
    if (!listEl) return;

    if (consultaLogs.length === 0) {
      listEl.innerHTML = `
        <div class="mon-empty mon-empty-inline">
          ${IC.alertCircle}
          <p>No hay notificaciones de consulta registradas aún.<br>
          <small>El historial se guarda cada vez que se ejecuta una verificación de procesos.</small></p>
        </div>`;
      if (pagEl) pagEl.innerHTML = "";
      return;
    }

    const totalPags = Math.max(1, Math.ceil(consultaLogs.length / LOGS_PER_PAG));
    if (consultaLogsPag > totalPags) consultaLogsPag = totalPags;
    const desde = (consultaLogsPag - 1) * LOGS_PER_PAG;
    const pagina = consultaLogs.slice(desde, desde + LOGS_PER_PAG);

    listEl.innerHTML = `
      <div class="mon-logs-header">
        ${IC.alertCircle}
        <span>Historial de verificaciones — ${consultaLogs.length} registros</span>
        <button class="mon-logs-clear" id="btn-logs-clear" title="Limpiar historial">Limpiar todo</button>
      </div>
      <div class="mon-logs-list">
        ${pagina.map(log => {
          const fecha = new Date(log.ts).toLocaleString("es-CO", {
            dateStyle: "medium", timeStyle: "short"
          });
          const hayError = log.fallos > 0 || log.error;
          const clsFila  = hayError ? "mon-log-row mon-log-row-error" : "mon-log-row mon-log-row-ok";
          const dotCls   = hayError ? "mon-log-dot mon-log-dot-error" : "mon-log-dot mon-log-dot-ok";
          const titulo   = hayError
            ? `${log.fallos} de ${log.total} proceso(s) no pudieron verificarse`
            : `${log.total} proceso(s) verificados correctamente`;
          const detalle  = log.error
            ? `${log.error}`
            : (hayError ? "Uno o más procesos no se pudieron verificar (RJ o Publicaciones Procesales)." : "");
          return `
            <div class="${clsFila}">
              <div class="${dotCls}"></div>
              <div class="mon-log-body">
                <div class="mon-log-fecha">${fecha}</div>
                <div class="mon-log-titulo">${escHtml(titulo)}</div>
                ${detalle ? `<div class="mon-log-detalle">${escHtml(detalle)}</div>` : ""}
              </div>
              <div class="mon-log-badge ${hayError ? "mon-log-badge-error" : "mon-log-badge-ok"}">
                ${hayError ? "Error" : "OK"}
              </div>
            </div>`;
        }).join("")}
      </div>`;

    document.getElementById("btn-logs-clear")?.addEventListener("click", async () => {
      if (!confirm("¿Limpiar todo el historial de notificaciones de consulta?")) return;
      const user = getUser();
      if (user) {
        try { await getClient().from("consulta_logs").delete().eq("user_id", user.id); } catch(_) {}
      }
      consultaLogs = [];
      consultaLogsPag = 1;
      actualizarContadorLogs();
      renderLogs();
    });

    if (!pagEl) return;
    if (totalPags <= 1) { pagEl.innerHTML = ""; return; }

    const desde2 = desde + 1;
    const hasta  = Math.min(consultaLogsPag * LOGS_PER_PAG, consultaLogs.length);
    let pagBtns  = "";
    paginasVisibles(consultaLogsPag, totalPags).forEach(p => {
      if (p === "…") pagBtns += `<span class="mon-pag-ellipsis">…</span>`;
      else pagBtns += `<button class="mon-pag-btn ${p === consultaLogsPag ? "active" : ""}" data-logpag="${p}">${p}</button>`;
    });
    pagEl.innerHTML = `
      <div class="mon-pag-info">${desde2}–${hasta} de ${consultaLogs.length}</div>
      <div class="mon-pag-controls">
        <button class="mon-pag-btn mon-pag-nav" id="logpag-prev" ${consultaLogsPag === 1 ? "disabled" : ""}>${IC.chevLeft}</button>
        ${pagBtns}
        <button class="mon-pag-btn mon-pag-nav" id="logpag-next" ${consultaLogsPag === totalPags ? "disabled" : ""}>${IC.chevRight}</button>
      </div>`;
    pagEl.querySelectorAll(".mon-pag-btn[data-logpag]").forEach(btn =>
      btn.addEventListener("click", () => { consultaLogsPag = +btn.dataset.logpag; renderLogs(); scroll2List(); }));
    pagEl.querySelector("#logpag-prev")?.addEventListener("click", () => { consultaLogsPag--; renderLogs(); scroll2List(); });
    pagEl.querySelector("#logpag-next")?.addEventListener("click", () => { consultaLogsPag++; renderLogs(); scroll2List(); });
  }

  /* ── Portal de Publicaciones Procesales con aviso de posible caída ─*/
  window._cambiarPaginaItem = function(type, id, page) {
    if (type === "acts") {
      actsPagina[id] = page;
      renderActuaciones(id, actuacionesCache[id] || []);
    } else {
      pubsPagina[id] = page;
      renderPublicaciones(id, publicacionesCache[id] || []);
    }
  };

  /* ── Tooltip flotante global (evita clipping por overflow:hidden del card) ── */
  (function() {
    let tip;
    function getTip() {
      if (!tip) {
        tip = document.createElement("div");
        tip.id = "mon-tooltip-global";
        tip.style.cssText = "position:fixed;z-index:9999;background:#1e293b;color:#fff;font-size:0.72rem;line-height:1.45;font-weight:400;font-style:normal;padding:8px 11px;border-radius:7px;max-width:250px;pointer-events:none;opacity:0;transition:opacity 0.15s;text-transform:none;letter-spacing:0";
        document.body.appendChild(tip);
      }
      return tip;
    }
    document.addEventListener("mouseover", e => {
      const el = e.target.closest("[data-tip]");
      if (!el) return;
      const t = getTip();
      t.textContent = el.dataset.tip;
      t.style.opacity = "1";
    });
    document.addEventListener("mousemove", e => {
      const el = e.target.closest("[data-tip]");
      if (!el) { if (tip) tip.style.opacity = "0"; return; }
      const t = getTip();
      t.style.left = Math.max(8, Math.min(e.clientX - 125, window.innerWidth - 260)) + "px";
      t.style.top  = Math.max(8, e.clientY - t.offsetHeight - 12) + "px";
    });
    document.addEventListener("mouseout", e => { if (tip && !e.relatedTarget?.closest("[data-tip]")) tip.style.opacity = "0"; });
  })();

  window._abrirPortalPP = function (url, segId) {
    showToast(
      "Abriendo portal externo de Publicaciones Procesales. Si la página no carga, es un problema temporal del servidor de la Rama Judicial, no de nuestra plataforma.",
      ""
    );
    setTimeout(() => window.open(url || PP_PORTAL, "_blank", "noopener"), 800);
    if (segId && typeof window._marcarPPVista === "function") window._marcarPPVista(segId);
  };

  /* ── Exposición global ──────────────────────────────────────*/
  window.iniciarMonitoreo   = iniciarMonitoreo;
  window.reiniciarMonitoreo = function () {
    monitoreoActivo       = false;
    todosLosSeguimientos  = [];
    actuacionesCache      = {};
    publicacionesCache    = {};
    filtroActivo          = "todos";
    busqueda              = "";
    paginaActual          = 1;
    consultaLogsPag       = 1;
    iniciarMonitoreo();
  };
})();
