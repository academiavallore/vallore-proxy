const express = require('express');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// Helper Supabase REST API
async function sbQuery(table, method='GET', body=null, params='') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method==='POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=representation'
    }
  };
  if(body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if(method === 'GET') return r.json();
  return r.ok;
}
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;
const AGENCY_KEY = process.env.GHL_AGENCY_KEY || '';
const GHL_BASE   = 'https://services.leadconnectorhq.com';

app.use(cors());
app.use(express.json());

function ghlHeaders(key) {
  return {
    'Authorization': `Bearer ${key || AGENCY_KEY}`,
    'Content-Type':  'application/json',
    'Version':       '2021-07-28',
  };
}

function ghlHeadersV2(key) {
  return {
    'Authorization': `Bearer ${key || AGENCY_KEY}`,
    'Content-Type':  'application/json',
    'Version':       '2021-04-15',
  };
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// Guardar location key en Supabase
app.post('/location-key', async (req, res) => {
  const { locationId, locationName, locationKey } = req.body;
  if(!locationId || !locationKey) return res.status(400).json({ error: 'Faltan datos' });
  try {
    await sbQuery('location_keys', 'POST', {
      location_id: locationId,
      salon_nombre: locationName || locationId,
      location_key: locationKey,
      active: true
    }, '?on_conflict=location_id');
    console.log('Location key guardada:', locationName);
    res.json({ ok: true });
  } catch(e) {
    console.log('Error guardando key:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/locations', async (req, res) => {
  try {
    let r    = await fetch(`${GHL_BASE}/locations/search?limit=100`, { headers: ghlHeaders() });
    let json = await r.json();
    if (!json.locations || json.locations.length === 0) {
      r    = await fetch(`${GHL_BASE}/oauth/installedLocations?isInstalled=true&limit=100`, { headers: ghlHeadersV2() });
      json = await r.json();
      const locs = json.locations || json.data || [];
      return res.json({ locations: locs.map(l => ({ id: l._id || l.id, name: l.name, city: l.address?.city || '' })) });
    }
    res.json({ locations: (json.locations || []).map(l => ({ id: l.id, name: l.name, city: l.address?.city || '' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dashboard', async (req, res) => {
  const { locationId, startDate, endDate } = req.query;
  if (!locationId) return res.status(400).json({ error: 'locationId requerido' });

  const headers = ghlHeaders(req.headers['x-location-key']);

  try {
    console.log('Dashboard request:', { locationId, startDate, endDate });

    // Obtener TODAS las facturas paginando
    let allRawInvoices = [];
    let offset = 0;
    const pageLimit = 100;
    while(true) {
      const invUrl = `${GHL_BASE}/invoices/?altId=${locationId}&altType=location&limit=${pageLimit}&offset=${offset}`;
      const invRes = await fetch(invUrl, { headers: {...headers, 'Version': '2021-07-28'} });
      const invText = await invRes.text();
      let invJson = {};
      try { invJson = JSON.parse(invText); } catch(e) {}
      const page = invJson.invoices || invJson.data || [];
      allRawInvoices = allRawInvoices.concat(page);
      if(page.length < pageLimit) break; // última página
      offset += pageLimit;
      if(offset > 2000) break; // safety cap
    }
    const allInvoices = allRawInvoices;

    const invoices = allInvoices.filter(inv => {
      if (inv.status !== 'paid') return false;
      if (!startDate || !endDate) return true;
      // Usar fecha local España (UTC+2) para evitar desplazamiento de zona horaria
      const rawDate = inv.issueDate || inv.createdAt || '';
      if (!rawDate) return true;
      const d = new Date(rawDate);
      // Ajustar a UTC+2 (España)
      d.setHours(d.getHours() + 2);
      const invDate = d.toISOString().slice(0, 10);
      return invDate >= startDate && invDate <= endDate;
    });

    console.log('Total invoices a procesar:', invoices.length);

    // Log completo de todas las facturas para debug
    invoices.forEach((inv, i) => {
      console.log(`FACTURA ${i+1} COMPLETA:`, JSON.stringify(inv).slice(0, 1000));
    });

    let totFacInv = 0;
    const contactosSet = new Set();
    const workersMap   = {};
    const categoriasMap = {};
    const productosMap  = {};

    invoices.forEach(inv => {
      const paid = parseFloat(inv.amountPaid || inv.total || inv.amount || 0);
      totFacInv += paid;
      if (inv.contactId) contactosSet.add(inv.contactId);

      const items = inv.invoiceItems || inv.lineItems || inv.items || [];
      console.log('Factura:', inv._id, '| amountPaid:', paid, '| items:', items.length);

      const itemsConImporte = items.filter(item => parseFloat(item.amount || item.unitPrice || 0) > 0);
      const usarTotalFactura = items.length === 0 || itemsConImporte.length === 0;

      if (usarTotalFactura) {
        const trabajadora = 'Sin asignar';
        if (!workersMap[trabajadora]) {
          workersMap[trabajadora] = { nombre: trabajadora, facturas: new Set(), svcs: 0, facServ: 0, prod: 0, facProd: 0, prod_uds: 0, cats: {} };
        }
        workersMap[trabajadora].facturas.add(inv._id);
        workersMap[trabajadora].svcs += 1; // sin items = asumimos servicio
        workersMap[trabajadora].facServ += paid;
        const cat = 'Servicio';
        if (!workersMap[trabajadora].cats[cat]) workersMap[trabajadora].cats[cat] = { qty: 0, rev: 0 };
        workersMap[trabajadora].cats[cat].qty += 1;
        workersMap[trabajadora].cats[cat].rev += paid;
        if (!categoriasMap[cat]) categoriasMap[cat] = { qty: 0, rev: 0 };
        categoriasMap[cat].qty += 1;
        categoriasMap[cat].rev += paid;
      } else {
        items.forEach(item => {
          const nombre     = item.name || item.productName || 'Sin nombre';
          const qty        = parseFloat(item.qty || item.quantity || 1);
          const importe    = parseFloat(item.amount || (parseFloat(item.unitPrice || item.price || 0) * qty) || 0);
          const trabajadora = stripHtml(item.description || item.notes || item.memo || '') || 'Sin asignar';
          
          // Detectar si es producto: el nombre empieza por "Producto"
          const esProducto = nombre.toLowerCase().startsWith('producto');

          console.log('Item:', nombre, '| trabajadora:', trabajadora, '| esProducto:', esProducto, '| importe:', importe);

          if (!workersMap[trabajadora]) {
            workersMap[trabajadora] = { nombre: trabajadora, facturas: new Set(), svcs: 0, facServ: 0, prod: 0, facProd: 0, prod_uds: 0, cats: {} };
          }
          workersMap[trabajadora].facturas.add(inv._id);

          if (esProducto) {
            workersMap[trabajadora].prod_uds += qty;
            workersMap[trabajadora].prod    += qty;
            workersMap[trabajadora].facProd += importe;
            if (!productosMap[nombre]) productosMap[nombre] = { qty: 0, rev: 0 };
            productosMap[nombre].qty += qty;
            productosMap[nombre].rev += importe;
          } else {
            workersMap[trabajadora].svcs    += qty;
            workersMap[trabajadora].facServ += importe;
            if (!workersMap[trabajadora].cats[nombre]) workersMap[trabajadora].cats[nombre] = { qty: 0, rev: 0 };
            workersMap[trabajadora].cats[nombre].qty += qty;
            workersMap[trabajadora].cats[nombre].rev += importe;
            if (!categoriasMap[nombre]) categoriasMap[nombre] = { qty: 0, rev: 0 };
            categoriasMap[nombre].qty += qty;
            categoriasMap[nombre].rev += importe;
          }
        });
      }
    });

    const totalClientes  = contactosSet.size || invoices.length;
    const facturacionSvc = Object.values(workersMap).reduce((a, w) => a + w.facServ, 0);
    const facturacionProd = Object.values(workersMap).reduce((a, w) => a + w.facProd, 0);
    const totalSvcs      = Object.values(workersMap).reduce((a, w) => a + w.svcs, 0);
    const totalProds     = Object.values(workersMap).reduce((a, w) => a + w.prod, 0);
    const ticketMedio    = totalClientes > 0 ? totFacInv / totalClientes : 0;  // total (svc+prod) / clientes
    const svcPorVisita   = totalClientes > 0 ? totalSvcs / totalClientes : 0;
    const pctServicios   = totFacInv > 0 ? (facturacionSvc / totFacInv * 100).toFixed(1) : 0;
    const pctProductos   = totFacInv > 0 ? (facturacionProd / totFacInv * 100).toFixed(1) : 0;

    console.log('Total facturación invoices:', totFacInv);
    console.log('Clientes únicos:', totalClientes);
    console.log('Ticket medio:', ticketMedio);
    console.log('Trabajadoras detectadas:', Object.keys(workersMap).join(', '));

    const workers = Object.values(workersMap).map(w => {
      const clientes = w.facturas.size;
      const ticket   = clientes > 0 ? Math.round((w.facServ + w.facProd) / clientes) : 0;  // total / clientes únicos
      const svcCli   = clientes > 0 ? (w.svcs / clientes).toFixed(1) : '0';
      return {
        nombre:   w.nombre,
        role:     '',
        visitasR: clientes,
        citasGHL: 0,
        svcs:     Math.round(w.svcs),
        facServ:  Math.round(w.facServ * 100) / 100,
        prod:     Math.round(w.prod),
        prod_uds: Math.round(w.prod_uds || 0),
        facProd:  Math.round(w.facProd * 100) / 100,
        facTotal: Math.round((w.facServ + w.facProd) * 100) / 100,
        ticket,
        svcCli,
        cats: Object.entries(w.cats)
          .map(([n, v]) => ({ n, qty: Math.round(v.qty), rev: Math.round(v.rev) }))
          .sort((a, b) => b.rev - a.rev),
      };
    }).sort((a, b) => b.facTotal - a.facTotal);

    res.json({
      kpis: {
        visitasReales: totalClientes,
        totalCitas:    invoices.length,
        totalSvcs:     Math.round(totalSvcs),
        svcPorVisita:  parseFloat(svcPorVisita.toFixed(1)),
        ticketMedio:   Math.round(ticketMedio * 100) / 100,
        totalProds:    Math.round(totalProds),
        totalFacServ:  Math.round(facturacionSvc * 100) / 100,
        totalFacProd:  Math.round(facturacionProd * 100) / 100,
        totalFacInv:   Math.round(totFacInv * 100) / 100,
        totalFac:      Math.round(totFacInv * 100) / 100,
        pctServicios:  parseFloat(pctServicios),
        pctProductos:  parseFloat(pctProductos),
      },
      workers,
      productos: Object.entries(productosMap)
        .map(([n, d]) => ({ n, qty: Math.round(d.qty), rev: Math.round(d.rev) }))
        .sort((a, b) => b.rev - a.rev),
      categorias: Object.entries(categoriasMap)
        .map(([n, d]) => ({ n, qty: Math.round(d.qty), rev: Math.round(d.rev) }))
        .sort((a, b) => b.rev - a.rev),
    });

  } catch (e) {
    console.log('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
// PERSISTENCIA — Supabase (permanente, no se borra)
// ══════════════════════════════════════════════

// GET /gastos?locationId=xxx — cargar todos los gastos
app.get('/gastos', async (req, res) => {
  const { locationId } = req.query;
  if (!locationId) return res.status(400).json({ error: 'locationId requerido' });
  try {
    const [gastosRows, catsRows] = await Promise.all([
      sbQuery('gastos', 'GET', null, `?location_id=eq.${encodeURIComponent(locationId)}&select=year,month,rows`),
      sbQuery('categorias_custom', 'GET', null, `?location_id=eq.${encodeURIComponent(locationId)}&select=cats`)
    ]);
    // Convertir array de filas a objeto {key: rows}
    const gastos = {};
    (gastosRows||[]).forEach(r => {
      const key = `exp_0_${r.year}_${r.month}`; // clave normalizada, se remapea en cliente
      gastos[key] = r.rows || [];
    });
    const customCats = (catsRows||[])[0]?.cats || [];
    res.json({ gastos, customCats });
  } catch(e) {
    console.log('Error cargando gastos Supabase:', e.message);
    res.json({ gastos: {}, customCats: [] });
  }
});

// POST /gastos — guardar gastos de un mes
app.post('/gastos', async (req, res) => {
  const { locationId, key, rows } = req.body;
  if (!locationId || !key) return res.status(400).json({ error: 'locationId y key requeridos' });
  try {
    // key formato: exp_0_2026_4 → extraer año y mes
    const parts = key.split('_');
    const year = parseInt(parts[2]) || new Date().getFullYear();
    const month = parseInt(parts[3]) ?? new Date().getMonth();
    const salonIdx = parseInt(req.body.salonIdx) || 0;
    await sbQuery('gastos', 'POST', {
      location_id: locationId, salon_idx: salonIdx, year, month, rows: rows || []
    }, '?on_conflict=location_id,year,month');
    res.json({ ok: true });
  } catch(e) {
    console.log('Error guardando gasto:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /gastos/cats — guardar categorías custom
app.post('/gastos/cats', async (req, res) => {
  const { locationId, cats } = req.body;
  if (!locationId) return res.status(400).json({ error: 'locationId requerido' });
  try {
    await sbQuery('categorias_custom', 'POST', {
      location_id: locationId, cats: cats || []
    }, '?on_conflict=location_id');
    res.json({ ok: true });
  } catch(e) {
    console.log('Error guardando cats:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /snapshot — guardar snapshot completo en todas las tablas
app.post('/snapshot', async (req, res) => {
  const { locationId, year, month, data } = req.body;
  if (!locationId) return res.status(400).json({ error: 'locationId requerido' });
  try {
    const salonNombre = data.salon || locationId;
    const k = data.kpis || {};
    const gastosMes = data.gastos || {};

    // 1. Guardar snapshot JSON completo (backup)
    await sbQuery('kpis_snapshot', 'POST', {
      location_id: locationId, year, month, data
    }, '?on_conflict=location_id,year,month');

    // 2. KPIs globales en tabla estructurada
    const gastosTotal = gastosMes.total || 0;
    const totalFac = parseFloat(k.totalFac||0);
    const beneficio = totalFac - gastosTotal;
    await sbQuery('kpis_mensual', 'POST', {
      location_id: locationId,
      salon_nombre: salonNombre,
      year, month,
      total_fac: totalFac,
      total_fac_serv: parseFloat(k.totalFacServ||0),
      total_fac_prod: parseFloat(k.totalFacProd||0),
      pct_servicios: parseFloat(k.pctServicios||0),
      pct_productos: parseFloat(k.pctProductos||0),
      visitas_reales: parseInt(k.visitasReales||0),
      total_svcs: parseInt(k.totalSvcs||0),
      total_prods: parseInt(k.totalProds||0),
      ticket_medio: parseFloat(k.ticketMedio||0),
      svc_por_visita: parseFloat(k.svcPorVisita||0),
      gastos_total: gastosTotal,
      beneficio: beneficio,
      margen_pct: totalFac > 0 ? parseFloat(((beneficio/totalFac)*100).toFixed(2)) : 0
    }, '?on_conflict=location_id,year,month');

    // 3. Trabajadoras
    const workers = data.workers || [];
    const totalFacAll = workers.reduce((a,w)=>a+(w.facServ||0)+(w.facProd||0),0);
    if(workers.length > 0) {
      // Borrar primero las del mes para reescribir
      await sbQuery('trabajadoras_mensual', 'DELETE', null,
        `?location_id=eq.${encodeURIComponent(locationId)}&year=eq.${year}&month=eq.${month}`);
      for(const w of workers) {
        const facT = (w.facServ||0)+(w.facProd||0);
        await sbQuery('trabajadoras_mensual', 'POST', {
          location_id: locationId,
          salon_nombre: salonNombre,
          year, month,
          trabajadora: w.nombre || 'Sin asignar',
          fac_servicios: parseFloat(w.facServ||0),
          fac_productos: parseFloat(w.facProd||0),
          fac_total: parseFloat(facT),
          pct_del_total: totalFacAll > 0 ? parseFloat((facT/totalFacAll*100).toFixed(1)) : 0,
          num_servicios: parseInt(w.svcs||0),
          num_productos: parseInt(w.prod||0),
          visitas: parseInt(w.visitasR||0),
          ticket_medio: parseFloat(w.ticket||0),
          svc_por_cliente: parseFloat(w.svcCli||0)
        }, '');
      }
    }

    // 4. Categorías de servicios
    const cats = data.categorias || [];
    const totalCatRev = cats.reduce((a,c)=>a+(c.rev||0),0);
    if(cats.length > 0) {
      await sbQuery('categorias_mensual', 'DELETE', null,
        `?location_id=eq.${encodeURIComponent(locationId)}&year=eq.${year}&month=eq.${month}`);
      for(const cat of cats) {
        await sbQuery('categorias_mensual', 'POST', {
          location_id: locationId,
          salon_nombre: salonNombre,
          year, month,
          categoria: cat.n || 'Sin nombre',
          cantidad: parseInt(cat.qty||0),
          facturacion: parseFloat(cat.rev||0),
          pct_del_total: totalCatRev > 0 ? parseFloat(((cat.rev||0)/totalCatRev*100).toFixed(1)) : 0
        }, '');
      }
    }

    // 5. Productos vendidos
    const prods = data.productos || [];
    if(prods.length > 0) {
      await sbQuery('productos_mensual', 'DELETE', null,
        `?location_id=eq.${encodeURIComponent(locationId)}&year=eq.${year}&month=eq.${month}`);
      for(const p of prods) {
        await sbQuery('productos_mensual', 'POST', {
          location_id: locationId,
          salon_nombre: salonNombre,
          year, month,
          producto: p.n || 'Sin nombre',
          cantidad: parseInt(p.qty||0),
          facturacion: parseFloat(p.rev||0)
        }, '');
      }
    }

    // 6. Gastos detallados
    const gastosFilas = gastosMes.filas || [];
    if(gastosFilas.length > 0) {
      await sbQuery('gastos_detalle', 'DELETE', null,
        `?location_id=eq.${encodeURIComponent(locationId)}&year=eq.${year}&month=eq.${month}`);
      for(const g of gastosFilas) {
        const base = parseFloat(g.amount||0);
        const ivaP = parseFloat(g.ivaRate||0);
        const irpfP = parseFloat(g.irpfRate||0);
        await sbQuery('gastos_detalle', 'POST', {
          location_id: locationId,
          salon_nombre: salonNombre,
          year, month,
          categoria: g.catId || 'otros',
          concepto: g.concept || '',
          base_imponible: base,
          iva_pct: ivaP,
          iva_eur: parseFloat((base*ivaP/100).toFixed(2)),
          irpf_pct: irpfP,
          irpf_eur: parseFloat((base*irpfP/100).toFixed(2))
        }, '');
      }
    }

    console.log(`Snapshot completo guardado: ${salonNombre} ${year}/${month+1}`);
    res.json({ ok: true });
  } catch(e) {
    console.log('Error guardando snapshot:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /snapshot?locationId=xxx&year=2026
app.get('/snapshot', async (req, res) => {
  const { locationId, year } = req.query;
  if (!locationId) return res.status(400).json({ error: 'locationId requerido' });
  try {
    const rows = await sbQuery('kpis_snapshot', 'GET', null,
      `?location_id=eq.${encodeURIComponent(locationId)}&year=eq.${year}&select=month,data`);
    res.json({ snapshots: rows || [] });
  } catch(e) {
    res.json({ snapshots: [] });
  }
});

// ══════════════════════════════════════════════
// FUNCIÓN NÚCLEO — procesar un salón y un mes completo
// ══════════════════════════════════════════════
async function procesarSalonMes(loc, locationKey, year, month) {
  const pad = n => String(n).padStart(2,'0');
  const fmtD = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const start = fmtD(new Date(year, month, 1));
  const end   = fmtD(new Date(year, month+1, 0));

  const headers = ghlHeaders(locationKey);

  // Obtener todas las facturas del mes paginando
  let allRawInvoices = [];
  let offset = 0;
  while(true) {
    const invUrl = `${GHL_BASE}/invoices/?altId=${loc.id}&altType=location&limit=100&offset=${offset}`;
    const invRes = await fetch(invUrl, { headers: {...headers, 'Version': '2021-07-28'} });
    const invText = await invRes.text();
    let invJson = {};
    try { invJson = JSON.parse(invText); } catch(e) {}
    const page = invJson.invoices || invJson.data || [];
    allRawInvoices = allRawInvoices.concat(page);
    if(page.length < 100) break;
    offset += 100;
    if(offset > 2000) break;
  }

  function stripHtml(str) {
    if(!str) return '';
    return str.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim();
  }

  const invoices = allRawInvoices.filter(inv => {
    if(inv.status !== 'paid') return false;
    const rawDate = inv.issueDate || inv.createdAt || '';
    if(!rawDate) return true;
    const d = new Date(rawDate);
    d.setHours(d.getHours() + 2);
    const invDate = d.toISOString().slice(0,10);
    return invDate >= start && invDate <= end;
  });

  if(invoices.length === 0) return null; // sin datos este mes

  let totFacInv = 0;
  const contactosSet = new Set();
  const workersMap = {};
  const categoriasMap = {};
  const productosMap = {};

  invoices.forEach(inv => {
    const paid = parseFloat(inv.amountPaid || inv.total || 0);
    totFacInv += paid;
    if(inv.contactId) contactosSet.add(inv.contactId);

    const items = inv.invoiceItems || inv.lineItems || inv.items || [];
    const itemsConImporte = items.filter(item => parseFloat(item.amount || item.unitPrice || 0) > 0);
    const usarTotal = items.length === 0 || itemsConImporte.length === 0;

    if(usarTotal) {
      const t = 'Sin asignar';
      if(!workersMap[t]) workersMap[t] = { nombre:t, facturas:new Set(), svcs:0, facServ:0, prod:0, prod_uds:0, facProd:0, cats:{} };
      workersMap[t].facturas.add(inv._id);
      workersMap[t].svcs += 1;
      workersMap[t].facServ += paid;
      if(!workersMap[t].cats['Servicio']) workersMap[t].cats['Servicio'] = {qty:0,rev:0};
      workersMap[t].cats['Servicio'].qty += 1;
      workersMap[t].cats['Servicio'].rev += paid;
      if(!categoriasMap['Servicio']) categoriasMap['Servicio'] = {qty:0,rev:0};
      categoriasMap['Servicio'].qty += 1;
      categoriasMap['Servicio'].rev += paid;
    } else {
      items.forEach(item => {
        const nombre = item.name || item.productName || 'Sin nombre';
        const qty = parseFloat(item.qty || item.quantity || 1);
        const importe = parseFloat(item.amount || (parseFloat(item.unitPrice||0)*qty) || 0);
        const trabajadora = stripHtml(item.description || item.notes || '') || 'Sin asignar';
        const esProducto = nombre.toLowerCase().startsWith('producto');

        if(!workersMap[trabajadora]) workersMap[trabajadora] = { nombre:trabajadora, facturas:new Set(), svcs:0, facServ:0, prod:0, prod_uds:0, facProd:0, cats:{} };
        workersMap[trabajadora].facturas.add(inv._id);

        if(esProducto) {
          workersMap[trabajadora].prod_uds += qty;
          workersMap[trabajadora].prod += qty;
          workersMap[trabajadora].facProd += importe;
          if(!productosMap[nombre]) productosMap[nombre] = {qty:0,rev:0};
          productosMap[nombre].qty += qty;
          productosMap[nombre].rev += importe;
        } else {
          workersMap[trabajadora].svcs += qty;
          workersMap[trabajadora].facServ += importe;
          if(!workersMap[trabajadora].cats[nombre]) workersMap[trabajadora].cats[nombre] = {qty:0,rev:0};
          workersMap[trabajadora].cats[nombre].qty += qty;
          workersMap[trabajadora].cats[nombre].rev += importe;
          if(!categoriasMap[nombre]) categoriasMap[nombre] = {qty:0,rev:0};
          categoriasMap[nombre].qty += qty;
          categoriasMap[nombre].rev += importe;
        }
      });
    }
  });

  const totalClientes = contactosSet.size || invoices.length;
  const facServ = Object.values(workersMap).reduce((a,w)=>a+w.facServ,0);
  const facProd = Object.values(workersMap).reduce((a,w)=>a+w.facProd,0);
  const totalSvcs = Object.values(workersMap).reduce((a,w)=>a+w.svcs,0);
  const totalProds = Object.values(workersMap).reduce((a,w)=>a+w.prod_uds,0);
  const ticketMedio = totalClientes > 0 ? totFacInv/totalClientes : 0;
  const svcPorVisita = totalClientes > 0 ? totalSvcs/totalClientes : 0;

  const workers = Object.values(workersMap).map(w => {
    const clientes = w.facturas.size;
    const ticket = clientes > 0 ? Math.round((w.facServ+w.facProd)/clientes) : 0;
    const svcCli = clientes > 0 ? (w.svcs/clientes).toFixed(1) : '0';
    return {
      nombre: w.nombre, visitasR: clientes, svcs: Math.round(w.svcs),
      facServ: Math.round(w.facServ*100)/100, prod: Math.round(w.prod),
      prod_uds: Math.round(w.prod_uds), facProd: Math.round(w.facProd*100)/100,
      facTotal: Math.round((w.facServ+w.facProd)*100)/100,
      ticket, svcCli,
      cats: Object.entries(w.cats).map(([n,v])=>({n, qty:Math.round(v.qty), rev:Math.round(v.rev)})).sort((a,b)=>b.rev-a.rev)
    };
  }).sort((a,b)=>b.facTotal-a.facTotal);

  const categorias = Object.entries(categoriasMap).map(([n,d])=>({n, qty:Math.round(d.qty), rev:Math.round(d.rev)})).sort((a,b)=>b.rev-a.rev);
  const productos = Object.entries(productosMap).map(([n,d])=>({n, qty:Math.round(d.qty), rev:Math.round(d.rev)})).sort((a,b)=>b.rev-a.rev);

  // Cargar gastos de Supabase para este mes
  let gastosTotal = 0;
  let gastosFilas = [];
  try {
    const gastosRows = await sbQuery('gastos','GET',null,`?location_id=eq.${encodeURIComponent(loc.id)}&year=eq.${year}&month=eq.${month}&select=rows`);
    if(gastosRows && gastosRows[0]) {
      gastosFilas = gastosRows[0].rows || [];
      gastosTotal = gastosFilas.reduce((a,g)=>a+parseFloat(g.amount||0),0);
    }
  } catch(e) { console.log('Error cargando gastos:', e.message); }

  const beneficio = totFacInv - gastosTotal;
  const margen = totFacInv > 0 ? ((beneficio/totFacInv)*100).toFixed(1) : 0;

  return {
    kpis: {
      totalFac: Math.round(totFacInv*100)/100,
      totalFacServ: Math.round(facServ*100)/100,
      totalFacProd: Math.round(facProd*100)/100,
      pctServicios: totFacInv>0?(facServ/totFacInv*100).toFixed(1):0,
      pctProductos: totFacInv>0?(facProd/totFacInv*100).toFixed(1):0,
      visitasReales: totalClientes,
      totalSvcs: Math.round(totalSvcs),
      totalProds: Math.round(totalProds),
      ticketMedio: Math.round(ticketMedio*100)/100,
      svcPorVisita: parseFloat(svcPorVisita.toFixed(1)),
    },
    workers, categorias, productos,
    gastos: { total: gastosTotal, filas: gastosFilas },
    beneficio, margen,
    salon: loc.name,
    fechaSnapshot: new Date().toISOString()
  };
}

// ══════════════════════════════════════════════
// CRON JOB — guardar historial completo diario
// Se llama automáticamente cada día desde Render Cron
// ══════════════════════════════════════════════
app.get('/cron/snapshot', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if(secret !== (process.env.CRON_SECRET || 'vallore-cron-2026')) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  console.log('🕐 Cron job iniciado:', new Date().toISOString());
  const results = [];
  const year = new Date().getFullYear();
  const curMonth = new Date().getMonth();

  try {
    // Obtener todas las location keys guardadas en Supabase
    const keys = await sbQuery('location_keys','GET',null,'?active=eq.true&select=location_id,salon_nombre,location_key');
    if(!keys || keys.length === 0) {
      return res.json({ ok: true, msg: 'No hay salones configurados', results: [] });
    }

    console.log(`Procesando ${keys.length} salones...`);

    for(const k of keys) {
      const loc = { id: k.location_id, name: k.salon_nombre };
      console.log(`
📍 Salón: ${loc.name}`);

      for(let month = 0; month <= curMonth; month++) {
        try {
          console.log(`  📅 Mes ${month+1}/${curMonth+1}...`);
          const data = await procesarSalonMes(loc, k.location_key, year, month);

          if(data) {
            // Guardar snapshot completo en todas las tablas
            await fetch(`http://localhost:${process.env.PORT||3000}/snapshot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                locationId: loc.id, year, month,
                data: {
                  salon: loc.name,
                  kpis: data.kpis,
                  workers: data.workers,
                  categorias: data.categorias,
                  productos: data.productos,
                  gastos: data.gastos,
                  beneficio: data.beneficio,
                  margen: data.margen,
                  fechaSnapshot: data.fechaSnapshot
                }
              })
            });
            console.log(`  ✅ ${loc.name} ${year}/${month+1}: €${data.kpis.totalFac}`);
            results.push({ salon: loc.name, month: month+1, fac: data.kpis.totalFac, status: 'ok' });
          } else {
            console.log(`  ⬜ ${loc.name} ${year}/${month+1}: sin datos`);
            results.push({ salon: loc.name, month: month+1, status: 'sin_datos' });
          }
        } catch(e) {
          console.log(`  ❌ Error ${loc.name} mes ${month+1}:`, e.message);
          results.push({ salon: loc.name, month: month+1, status: 'error', msg: e.message });
        }
      }
    }

    const ok = results.filter(r=>r.status==='ok').length;
    console.log(`
🕐 Cron completado: ${ok}/${results.length} meses guardados`);
    res.json({ ok: true, processed: ok, total: results.length, results });
  } catch(e) {
    console.log('Error cron:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Vallore GHL Proxy' }));
app.listen(PORT, () => console.log(`Vallore proxy en puerto ${PORT}`));
