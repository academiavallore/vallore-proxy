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
      const key = `exp_0_${r.year}_${r.month}`;
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
    await sbQuery('gastos', 'POST', {
      location_id: locationId, year, month, rows: rows || []
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

// POST /snapshot — guardar snapshot de KPIs de GHL por mes
app.post('/snapshot', async (req, res) => {
  const { locationId, year, month, data } = req.body;
  if (!locationId) return res.status(400).json({ error: 'locationId requerido' });
  try {
    await sbQuery('kpis_snapshot', 'POST', {
      location_id: locationId, year, month, data
    }, '?on_conflict=location_id,year,month');
    res.json({ ok: true });
  } catch(e) {
    console.log('Error guardando snapshot:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /snapshot?locationId=xxx&year=2026 — cargar snapshots del año
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

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Vallore GHL Proxy' }));
app.listen(PORT, () => console.log(`Vallore proxy en puerto ${PORT}`));
