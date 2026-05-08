// ══════════════════════════════════════════════
//  Vallore · GHL Proxy Server - Versión definitiva
// ══════════════════════════════════════════════

const express = require('express');
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

// Limpia etiquetas HTML y devuelve texto plano
function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// ── GET /locations ─────────────────────────────
app.get('/locations', async (req, res) => {
  try {
    let r    = await fetch(`${GHL_BASE}/locations/search?limit=100`, { headers: ghlHeaders() });
    let json = await r.json();
    if (!json.locations || json.locations.length === 0) {
      r    = await fetch(`${GHL_BASE}/oauth/installedLocations?isInstalled=true&limit=100`, { headers: ghlHeadersV2() });
      json = await r.json();
      const locs = json.locations || json.data || [];
      return res.json({
        locations: locs.map(l => ({ id: l._id || l.id, name: l.name, city: l.address?.city || '' }))
      });
    }
    res.json({
      locations: (json.locations || []).map(l => ({ id: l.id, name: l.name, city: l.address?.city || '' }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /dashboard ─────────────────────────────
// ?locationId=XXX&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get('/dashboard', async (req, res) => {
  const { locationId, startDate, endDate } = req.query;
  if (!locationId) return res.status(400).json({ error: 'locationId requerido' });

  const headers = ghlHeaders(req.headers['x-location-key']);

  try {
    console.log('Dashboard request:', { locationId, startDate, endDate });

    // ── Obtener todas las facturas pagadas ──────
    const invUrl = `${GHL_BASE}/invoices/?altId=${locationId}&altType=location&limit=100&offset=0`;
    const invRes = await fetch(invUrl, { headers: {...headers, 'Version': '2021-07-28'} });
    const invText = await invRes.text();
    let invJson = {};
    try { invJson = JSON.parse(invText); } catch(e) {}

    const allInvoices = invJson.invoices || invJson.data || [];

    // Filtrar por fecha si se especifica
    const invoices = allInvoices.filter(inv => {
      if (inv.status !== 'paid') return false;
      if (!startDate || !endDate) return true;
      const invDate = inv.issueDate || inv.createdAt || inv.updatedAt || '';
      if (!invDate) return true;
      const d = invDate.slice(0, 10);
      return d >= startDate && d <= endDate;
    });

    console.log('Total invoices a procesar:', invoices.length);
    // Log completo de todas las facturas para debug
    invoices.forEach((inv, i) => {
      console.log(`FACTURA ${i+1} COMPLETA:`, JSON.stringify(inv));
    });

    // ── Estructuras de datos ────────────────────
    let totFacInv  = 0;
    const contactosSet = new Set(); // clientes únicos por contactId
    const workersMap   = {};        // trabajadora → acumulados
    const categoriasMap = {};       // categoria servicio → {qty, rev}
    const productosMap  = {};       // producto inventario → {qty, rev}

    invoices.forEach(inv => {
      const paid = parseFloat(inv.amountPaid || inv.total || inv.amount || 0);
      totFacInv += paid;

      // Contacto = cliente atendido
      if (inv.contactId) contactosSet.add(inv.contactId);

      const items = inv.invoiceItems || inv.lineItems || inv.items || [];
      console.log('Factura:', inv._id, '| amountPaid:', paid, '| items:', items.length);

      // Si no hay items o todos tienen importe 0, tratar la factura completa como 1 servicio
      const itemsConImporte = items.filter(item => parseFloat(item.amount || item.unitPrice || 0) > 0);
      const usarTotalFactura = items.length === 0 || itemsConImporte.length === 0;

      if (usarTotalFactura) {
        // Factura sin desglose de items — contar como 1 servicio genérico
        const trabajadora = 'Sin asignar';
        if (!workersMap[trabajadora]) {
          workersMap[trabajadora] = { nombre: trabajadora, facturas: new Set(), svcs: 0, facServ: 0, prod: 0, facProd: 0, cats: {} };
        }
        workersMap[trabajadora].facturas.add(inv._id);
        workersMap[trabajadora].svcs    += 1;
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
          const nombre   = item.name || item.productName || 'Sin nombre';
          const qty      = parseFloat(item.qty || item.quantity || 1);
          const importe  = parseFloat(item.amount || (parseFloat(item.unitPrice || item.price || 0) * qty) || 0);
          const esProducto = !!item.productId;
          const trabajadora = stripHtml(item.description || item.notes || item.memo || '') || 'Sin asignar';

          console.log('Item:', nombre, '| trabajadora:', trabajadora, '| esProducto:', esProducto, '| importe:', importe);

          if (!workersMap[trabajadora]) {
            workersMap[trabajadora] = { nombre: trabajadora, facturas: new Set(), svcs: 0, facServ: 0, prod: 0, facProd: 0, cats: {} };
          }
          workersMap[trabajadora].facturas.add(inv._id);

          if (esProducto) {
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

    // ── Calcular métricas globales ──────────────
    const totalClientes  = contactosSet.size || invoices.length; // fallback a nº facturas
    const facturacionSvc = Object.values(workersMap).reduce((a, w) => a + w.facServ, 0);
    const facturacionProd = Object.values(workersMap).reduce((a, w) => a + w.facProd, 0);
    const totalSvcs      = Object.values(workersMap).reduce((a, w) => a + w.svcs, 0);
    const totalProds     = Object.values(workersMap).reduce((a, w) => a + w.prod, 0);
    const ticketMedio    = totalClientes > 0 ? facturacionSvc / totalClientes : 0;
    const svcPorVisita   = totalClientes > 0 ? totalSvcs / totalClientes : 0;
    const pctServicios   = totFacInv > 0 ? (facturacionSvc / totFacInv * 100).toFixed(1) : 0;
    const pctProductos   = totFacInv > 0 ? (facturacionProd / totFacInv * 100).toFixed(1) : 0;

    console.log('Total facturación invoices:', totFacInv);
    console.log('Clientes únicos:', totalClientes);
    console.log('Ticket medio:', ticketMedio);
    console.log('Trabajadoras detectadas:', Object.keys(workersMap).join(', '));

    // ── Construir array workers para el dashboard ──
    const workers = Object.values(workersMap).map(w => {
      const clientes = w.facturas.size;
      const ticket   = clientes > 0 ? Math.round(w.facServ / clientes) : 0;
      const svcCli   = clientes > 0 ? (w.svcs / clientes).toFixed(1) : '0';
      return {
        nombre:    w.nombre,
        role:      '',
        visitasR:  clientes,           // clientes atendidos (facturas)
        citasGHL:  0,
        svcs:      Math.round(w.svcs),
        facServ:   Math.round(w.facServ * 100) / 100,
        prod:      Math.round(w.prod),
        facProd:   Math.round(w.facProd * 100) / 100,
        facTotal:  Math.round((w.facServ + w.facProd) * 100) / 100,
        ticket,
        svcCli,
        cats: Object.entries(w.cats)
          .map(([n, v]) => ({ n, qty: Math.round(v.qty), rev: Math.round(v.rev) }))
          .sort((a, b) => b.rev - a.rev),
      };
    }).sort((a, b) => b.facTotal - a.facTotal);

    res.json({
      kpis: {
        visitasReales:  totalClientes,
        totalCitas:     invoices.length,
        totalSvcs:      Math.round(totalSvcs),
        svcPorVisita:   parseFloat(svcPorVisita.toFixed(1)),
        ticketMedio:    Math.round(ticketMedio * 100) / 100,
        totalProds:     Math.round(totalProds),
        totalFacServ:   Math.round(facturacionSvc * 100) / 100,
        totalFacProd:   Math.round(facturacionProd * 100) / 100,
        totalFacInv:    Math.round(totFacInv * 100) / 100,
        totalFac:       Math.round(totFacInv * 100) / 100,
        pctServicios:   parseFloat(pctServicios),
        pctProductos:   parseFloat(pctProductos),
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

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Vallore GHL Proxy' }));
app.listen(PORT, () => console.log(`Vallore proxy en puerto ${PORT}`));
