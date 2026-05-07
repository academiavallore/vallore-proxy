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

// Limpia HTML y devuelve texto plano
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

    const invUrl = `${GHL_BASE}/invoices/?altId=${locationId}&altType=location&limit=100&offset=0`;
    const invRes = await fetch(invUrl, { headers: {...headers, 'Version': '2021-07-28'} });
    const invText = await invRes.text();
    let invJson = {};
    try { invJson = JSON.parse(invText); } catch(e) {}
    const invoices = (invJson.invoices || invJson.data || []).filter(i => i.status === 'paid');

    console.log('Total invoices a procesar:', invoices.length);

    let totFacInv = 0;
    const workersMap = {};
    const categoriasMap = {};
    const productosMap = {};

    invoices.forEach(inv => {
      const paid = parseFloat(inv.amountPaid || inv.total || inv.amount || 0);
      totFacInv += paid;

      const items = inv.invoiceItems || inv.lineItems || inv.items || [];
      console.log('Factura:', inv._id, '| amountPaid:', paid, '| items:', items.length);

      items.forEach(item => {
        const nombre = item.name || item.productName || 'Sin nombre';
        const qty = parseFloat(item.qty || item.quantity || 1);
        const importe = parseFloat(item.amount || (parseFloat(item.unitPrice || item.price || 0) * qty) || 0);
        const esProducto = !!item.productId;
        
        // Limpiar HTML del campo description para obtener nombre trabajadora
        const trabajadora = stripHtml(item.description || item.notes || item.memo || '') || 'Sin asignar';

        console.log('Item:', nombre, '| trabajadora:', trabajadora, '| esProducto:', esProducto, '| importe:', importe);

        if (!workersMap[trabajadora]) {
          workersMap[trabajadora] = { nombre: trabajadora, facServ: 0, facProd: 0, svcs: [], prods: [] };
        }

        if (esProducto) {
          workersMap[trabajadora].facProd += importe;
          workersMap[trabajadora].prods.push({ nombre, qty, importe });
          if (!productosMap[nombre]) productosMap[nombre] = { qty: 0, rev: 0 };
          productosMap[nombre].qty += qty;
          productosMap[nombre].rev += importe;
        } else {
          workersMap[trabajadora].facServ += importe;
          workersMap[trabajadora].svcs.push({ nombre, qty, importe });
          if (!categoriasMap[nombre]) categoriasMap[nombre] = { qty: 0, rev: 0 };
          categoriasMap[nombre].qty += qty;
          categoriasMap[nombre].rev += importe;
        }
      });
    });

    console.log('Total facturación invoices:', totFacInv);
    console.log('Trabajadoras detectadas:', Object.keys(workersMap).join(', '));

    const facturacionSvc = Object.values(workersMap).reduce((a, w) => a + w.facServ, 0);
    const facturacionProd = Object.values(workersMap).reduce((a, w) => a + w.facProd, 0);

    const workers = Object.values(workersMap).map(w => ({
      nombre: w.nombre,
      facServ: Math.round(w.facServ * 100) / 100,
      facProd: Math.round(w.facProd * 100) / 100,
      facTotal: Math.round((w.facServ + w.facProd) * 100) / 100,
      svcs: w.svcs,
      prods: w.prods
    }));

    res.json({
      kpis: {
        visitasReales: 0,
        totalCitas:    0,
        totalSvcs:     Object.values(workersMap).reduce((a, w) => a + w.svcs.length, 0),
        svcPorVisita:  0,
        ticketMedio:   0,
        totalProds:    Math.round(Object.values(productosMap).reduce((a, p) => a + p.qty, 0)),
        totalFacServ:  Math.round(facturacionSvc * 100) / 100,
        totalFacProd:  Math.round(facturacionProd * 100) / 100,
        totalFacInv:   Math.round(totFacInv * 100) / 100,
        totalFac:      Math.round(totFacInv * 100) / 100,
      },
      workers,
      productos: Object.entries(productosMap)
        .map(([n, d]) => ({ n, qty: Math.round(d.qty), rev: Math.round(d.rev) }))
        .sort((a, b) => b.rev - a.rev),
      categorias: Object.entries(categoriasMap)
        .map(([n, d]) => ({ n, qty: Math.round(d.qty), rev: Math.round(d.rev) }))
        .sort((a, b) => b.rev - a.rev),
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Vallore GHL Proxy' }));
app.listen(PORT, () => console.log(`Vallore proxy en puerto ${PORT}`));
