// ══════════════════════════════════════════════
//  Vallore · GHL Proxy Server
//  Despliega en Railway — añade tu Agency API Key
//  en Settings → Variables → GHL_AGENCY_KEY
// ══════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 8080;

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

async function fetchAll(url, headers, dataKey) {
  let results = [];
  let nextUrl = url;
  while (nextUrl) {
    const res  = await fetch(nextUrl, { headers });
    const json = await res.json();
    results    = results.concat(json[dataKey] || []);
    nextUrl    = json?.meta?.nextPageUrl || json?.nextPageUrl || null;
  }
  return results;
}

// ── GET /locations ─────────────────────────────
// Devuelve todas las subcuentas de la agencia
app.get('/locations', async (req, res) => {
  try {
    const r    = await fetch(`${GHL_BASE}/locations/search?limit=100`, { headers: ghlHeaders() });
    const json = await r.json();
    res.json({
      locations: (json.locations || []).map(l => ({
        id:   l.id,
        name: l.name,
        city: l.address?.city || '',
      }))
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
    // 1. Citas showed
    const appointments = await fetchAll(
      `${GHL_BASE}/appointments/?locationId=${locationId}&startDate=${startDate}&endDate=${endDate}&status=showed&limit=100`,
      headers, 'appointments'
    );

    // 2. Facturas pagadas
    const invoices = await fetchAll(
      `${GHL_BASE}/invoices/?locationId=${locationId}&startDate=${startDate}&endDate=${endDate}&status=paid&limit=100`,
      headers, 'invoices'
    );

    // ── Procesar appointments ──────────────────
    const visitaKeys = new Set();
    const workers    = {};

    appointments.forEach(apt => {
      const fecha   = apt.startTime?.slice(0, 10) || '';
      visitaKeys.add(`${apt.contactId}_${fecha}`);

      const uid  = apt.userId || 'sin_asignar';
      const nom  = apt.assignedUserName || apt.calendarTitle || uid;
      const prec = parseFloat(apt.price || apt.servicePrice || 0);
      const svc  = apt.title || 'Servicio';

      if (!workers[uid]) workers[uid] = { id: uid, nombre: nom, citas: 0, svcs: 0, facServ: 0, cats: {} };
      workers[uid].citas++;
      workers[uid].svcs++;
      workers[uid].facServ += prec;
      workers[uid].cats[svc] = (workers[uid].cats[svc] || 0) + prec;
    });

    const totFacServ = appointments.reduce((a, apt) => a + parseFloat(apt.price || apt.servicePrice || 0), 0);
    const visitasR   = visitaKeys.size;

    // ── Procesar invoices — solo productos inventario ──
    let totProds = 0, totFacProd = 0;
    const prodMap = {};

    invoices.forEach(inv => {
      (inv.lineItems || inv.items || []).forEach(item => {
        if (item.type !== 'product' && !item.productId) return;
        const qty  = parseFloat(item.qty || item.quantity || 1);
        const rev  = parseFloat(item.amount || item.unitPrice * qty || 0);
        const nom  = item.name || item.productName || 'Producto';
        totProds   += qty;
        totFacProd += rev;
        if (!prodMap[nom]) prodMap[nom] = { qty: 0, rev: 0 };
        prodMap[nom].qty += qty;
        prodMap[nom].rev += rev;
      });
    });

    res.json({
      kpis: {
        visitasReales:  visitasR,
        totalCitas:     appointments.length,
        totalSvcs:      appointments.length,
        svcPorVisita:   visitasR ? +(appointments.length / visitasR).toFixed(1) : 0,
        ticketMedio:    visitasR ? +(totFacServ / visitasR).toFixed(2) : 0,
        totalProds:     Math.round(totProds),
        totalFacServ:   Math.round(totFacServ),
        totalFacProd:   Math.round(totFacProd),
        totalFac:       Math.round(totFacServ + totFacProd),
      },
      workers: Object.values(workers).map(w => ({
        ...w,
        facServ:   Math.round(w.facServ),
        ticket:    w.citas ? Math.round(w.facServ / w.citas) : 0,
        svcVisita: w.citas ? (w.svcs / w.citas).toFixed(1) : '0',
        cats:      Object.entries(w.cats)
                     .map(([n, rev]) => ({ n, rev: Math.round(rev) }))
                     .sort((a, b) => b.rev - a.rev).slice(0, 5),
      })),
      productos: Object.entries(prodMap)
        .map(([n, d]) => ({ n, qty: Math.round(d.qty), rev: Math.round(d.rev) }))
        .sort((a, b) => b.rev - a.rev),
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Vallore GHL Proxy' }));
app.listen(PORT, () => console.log(`Vallore proxy en puerto ${PORT}`));
