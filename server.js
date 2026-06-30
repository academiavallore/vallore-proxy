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

// ═══════════════════════════════════════════
// GOOGLE DRIVE — subir Excel automáticamente
// ═══════════════════════════════════════════
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

async function getDriveToken() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if(!clientId || !clientSecret || !refreshToken) {
    console.error('❌ Faltan variables GOOGLE_OAUTH_*');
    return null;
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${refreshToken}`
  });
  const data = await r.json();
  if(!data.access_token) console.error('❌ Error obteniendo token OAuth:', JSON.stringify(data));
  else console.log('✅ Token OAuth obtenido correctamente');
  return data.access_token || null;
}

async function driveGetOrCreateFolder(token, name, parentId) {
  // Buscar si ya existe (incluyendo drives compartidos)
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await r.json();
  console.log(`🔍 Drive buscar carpeta "${name}" en parent ${parentId}:`, JSON.stringify(data));
  if(data.files && data.files.length > 0) {
    console.log(`📁 Carpeta "${name}" encontrada: ${data.files[0].id}`);
    return data.files[0].id;
  }
  
  // Crear nueva carpeta
  console.log(`📁 Creando carpeta "${name}" en parent ${parentId}...`);
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method:'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ name, mimeType:'application/vnd.google-apps.folder', parents:[parentId] })
  });
  const folder = await cr.json();
  console.log(`📁 Carpeta creada:`, JSON.stringify(folder));
  return folder.id;
}

async function driveUploadExcel(token, folderId, filename, buffer) {
  // Buscar si ya existe para reemplazar
  const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
  const sr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const sd = await sr.json();
  console.log(`🔍 Buscar Excel existente "${filename}":`, JSON.stringify(sd));

  const boundary = 'vallore_boundary_xyz';
  // Subir SIN parent primero (al Drive propio de la service account)
  const metaSinParent = JSON.stringify({ name: filename });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${metaSinParent}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`)
  ]);

  let fileId;
  if(sd.files && sd.files.length > 0) {
    // Actualizar contenido del existente
    fileId = sd.files[0].id;
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    console.log(`📊 Excel actualizado: ${fileId}`);
  } else {
    // Crear nuevo sin parent
    const ur = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const created = await ur.json();
    fileId = created.id;
    console.log(`📊 Excel creado sin parent: ${fileId}`, JSON.stringify(created));

    // Mover a la carpeta destino (addParents + removeParents)
    const moveR = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${folderId}&removeParents=root&supportsAllDrives=true&fields=id,parents`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const moved = await moveR.json();
    console.log(`📁 Excel movido a carpeta ${folderId}:`, JSON.stringify(moved));
  }
  return { id: fileId };
}

async function generarYSubirExcel(salonNombre, locationId, year, month, data) {
  if(!DRIVE_FOLDER_ID || !process.env.GOOGLE_OAUTH_REFRESH_TOKEN) return;
  try {
    const XLSX = require('xlsx');
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    
    const wb = XLSX.utils.book_new();
    const k = data.kpis || {};
    const workers = data.workers || [];
    const cats = data.categorias || [];
    const prods = data.productos || [];
    const gastRows = (data.gastos && data.gastos.filas) || [];
    const gastTotal = data.gastos && data.gastos.total || 0;
    const beneficio = (k.totalFac||0) - gastTotal;
    
    // Hoja 1: Resumen
    const resData = [
      ['INFORME', `${salonNombre} · ${meses[month]} ${year}`],
      [],
      ['MÉTRICA', 'VALOR'],
      ['Facturación total', k.totalFac||0],
      ['Facturación servicios', k.totalFacServ||0],
      ['Facturación producto', k.totalFacProd||0],
      ['% Servicios', (k.pctServicios||0)+'%'],
      ['% Producto', (k.pctProductos||0)+'%'],
      ['Clientes únicos', k.visitasReales||0],
      ['Nº servicios', k.totalSvcs||0],
      ['Nº productos vendidos', k.totalProds||0],
      ['Ticket medio €', k.ticketMedio||0],
      ['Media svc/cliente', k.svcPorVisita||0],
      ['Gastos totales', gastTotal],
      ['Beneficio neto', beneficio],
      ['Margen %', k.totalFac>0?((beneficio/(k.totalFac||1))*100).toFixed(1)+'%':'-'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resData), '📊 Resumen');

    // Hoja 2: Trabajadoras
    const trabData = [['TRABAJADORA','FAC. SERV €','FAC. PROD €','TOTAL €','% TOTAL','Nº SVCS','Nº PRODS','VISITAS','TICKET €','SVC/CLI']];
    const totFacW = workers.reduce((a,w)=>a+(w.facServ||0)+(w.facProd||0),0);
    workers.forEach(w => {
      const ft=(w.facServ||0)+(w.facProd||0);
      trabData.push([w.nombre||'Sin asignar', w.facServ||0, w.facProd||0, ft,
        totFacW>0?((ft/totFacW)*100).toFixed(1)+'%':'-',
        w.svcs||0, w.prod||0, w.visitasR||0, w.ticket||0, w.svcCli||0]);
    });
    const totW = workers.reduce((a,w)=>({fs:a.fs+(w.facServ||0),fp:a.fp+(w.facProd||0),sv:a.sv+(w.svcs||0),pr:a.pr+(w.prod||0),vi:a.vi+(w.visitasR||0)}),{fs:0,fp:0,sv:0,pr:0,vi:0});
    trabData.push(['TOTAL',totW.fs,totW.fp,totW.fs+totW.fp,'100%',totW.sv,totW.pr,totW.vi,
      totW.vi>0?((totW.fs+totW.fp)/totW.vi).toFixed(0):0, totW.vi>0?(totW.sv/totW.vi).toFixed(1):0]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trabData), '👩 Trabajadoras');

    // Hoja 3: Categorías
    const catData = [['CATEGORÍA','CANTIDAD','FACTURACIÓN €','% TOTAL']];
    const totCat = cats.reduce((a,c)=>a+(c.rev||0),0);
    cats.forEach(c => catData.push([c.n||'Sin nombre', c.qty||0, c.rev||0, totCat>0?((c.rev||0)/totCat*100).toFixed(1)+'%':'-']));
    catData.push(['TOTAL', cats.reduce((a,c)=>a+(c.qty||0),0), totCat, '100%']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(catData), '✂️ Servicios');

    // Hoja 4: Productos
    const prodData = [['PRODUCTO','UNIDADES','FACTURACIÓN €']];
    prods.forEach(p => prodData.push([p.n||'Sin nombre', p.qty||0, p.rev||0]));
    prodData.push(['TOTAL', prods.reduce((a,p)=>a+(p.qty||0),0), prods.reduce((a,p)=>a+(p.rev||0),0)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prodData), '🧴 Productos');

    // Hoja 5: Gastos
    const gastData = [['CATEGORÍA','CONCEPTO','BASE €','IVA %','IVA €','IRPF %','IRPF €']];
    gastRows.forEach(g => {
      const base=parseFloat(g.amount||0);
      gastData.push([g.catId||'otros', g.concept||'', base, g.ivaRate||0, base*(g.ivaRate||0)/100, g.irpfRate||0, base*(g.irpfRate||0)/100]);
    });
    gastData.push(['TOTAL','',gastTotal,'','','','']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(gastData), '💸 Gastos');

    // Generar buffer
    const buffer = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    
    // Subir a Drive
    const token = await getDriveToken();
    if(!token) { console.log('⚠️ No se pudo obtener token de Drive'); return; }
    
    // Crear estructura de carpetas: Vallore Dashboard / Salón / Año
    const salonFolder = await driveGetOrCreateFolder(token, salonNombre, DRIVE_FOLDER_ID);
    const yearFolder  = await driveGetOrCreateFolder(token, String(year), salonFolder);
    
    const filename = `${meses[month]}_${year}_${salonNombre.replace(/[^a-zA-Z0-9]/g,'_')}.xlsx`;
    await driveUploadExcel(token, yearFolder, filename, buffer);
    console.log(`📊 Excel subido a Drive: ${salonNombre}/${year}/${filename}`);
  } catch(e) {
    console.log('⚠️ Error subiendo a Drive:', e.message);
  }
}
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
    // Intentar actualizar primero si existe
    const existing = await sbQuery('location_keys','GET',null,
      `?location_id=eq.${encodeURIComponent(locationId)}&select=id`);
    
    if(existing && existing.length > 0) {
      // Actualizar
      await sbQuery('location_keys', 'PATCH', {
        salon_nombre: locationName || locationId,
        location_key: locationKey,
        active: true,
        updated_at: new Date().toISOString()
      }, `?location_id=eq.${encodeURIComponent(locationId)}`);
    } else {
      // Insertar nuevo
      await sbQuery('location_keys', 'POST', {
        location_id: locationId,
        salon_nombre: locationName || locationId,
        location_key: locationKey,
        active: true
      }, '');
    }
    console.log('✅ Location key guardada:', locationName, locationId);
    res.json({ ok: true });
  } catch(e) {
    console.log('❌ Error guardando key:', e.message);
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
      const key = `exp_${locationId}_${r.year}_${r.month}`;
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
    // key formato: exp_{locationId}_{year}_{month} — parsear desde el final
    const keyParts = key.split('_');
    const month = parseInt(keyParts[keyParts.length - 1]) ?? new Date().getMonth();
    const year = parseInt(keyParts[keyParts.length - 2]) || new Date().getFullYear();
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
async function procesarSalonMes(loc, locationKey, year, month, customStart, customEnd) {
  const pad = n => String(n).padStart(2,'0');
  const fmtD = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const start = customStart || fmtD(new Date(year, month, 1));
  const end   = customEnd   || fmtD(new Date(year, month+1, 0));

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
            // Subir Excel a Google Drive
            await generarYSubirExcel(loc.name, loc.id, year, month, {
              kpis: data.kpis, workers: data.workers, categorias: data.categorias,
              productos: data.productos, gastos: data.gastos
            });
            console.log(`  ✅ ${loc.name} ${year}/${month+1}: €${data.kpis.totalFac}`);
            results.push({ salon: loc.name, month: month+1, fac: data.kpis.totalFac, status: 'ok' });

            // Guardar también día a día — procesar cada día del mes
            const daysInMonth = new Date(year, month+1, 0).getDate();
            const today = new Date();
            const isCurrentMonth = (year === today.getFullYear() && month === today.getMonth());
            const lastDay = isCurrentMonth ? today.getDate() : daysInMonth;

            for(let day = 1; day <= lastDay; day++) {
              const pad = n => String(n).padStart(2,'0');
              const dayStart = `${year}-${pad(month+1)}-${pad(day)}`;
              const dayEnd   = dayStart;
              try {
                const dayData = await procesarSalonMes(loc, k.location_key, year, month, dayStart, dayEnd);
                if(dayData && dayData.kpis.totalFac > 0) {
                  const fecha = dayStart;
                  // KPIs diarios
                  await sbQuery('kpis_diario', 'POST', {
                    location_id: loc.id, salon_nombre: loc.name,
                    fecha, year, month, day,
                    total_fac: dayData.kpis.totalFac,
                    total_fac_serv: dayData.kpis.totalFacServ,
                    total_fac_prod: dayData.kpis.totalFacProd,
                    visitas_reales: dayData.kpis.visitasReales,
                    total_svcs: dayData.kpis.totalSvcs,
                    total_prods: dayData.kpis.totalProds,
                    ticket_medio: dayData.kpis.ticketMedio,
                    svc_por_visita: dayData.kpis.svcPorVisita,
                    beneficio: dayData.beneficio
                  }, '?on_conflict=location_id,fecha');

                  // Trabajadoras diario
                  await sbQuery('trabajadoras_diario', 'DELETE', null,
                    `?location_id=eq.${encodeURIComponent(loc.id)}&fecha=eq.${fecha}`);
                  for(const w of dayData.workers) {
                    if((w.facServ||0)+(w.facProd||0) > 0) {
                      await sbQuery('trabajadoras_diario', 'POST', {
                        location_id: loc.id, salon_nombre: loc.name, fecha,
                        trabajadora: w.nombre,
                        fac_servicios: w.facServ, fac_productos: w.facProd,
                        fac_total: w.facTotal, num_servicios: w.svcs,
                        visitas: w.visitasR, ticket_medio: w.ticket
                      }, '');
                    }
                  }

                  // Categorías diario
                  await sbQuery('categorias_diario', 'DELETE', null,
                    `?location_id=eq.${encodeURIComponent(loc.id)}&fecha=eq.${fecha}`);
                  for(const cat of dayData.categorias) {
                    if(cat.rev > 0) {
                      await sbQuery('categorias_diario', 'POST', {
                        location_id: loc.id, salon_nombre: loc.name, fecha,
                        categoria: cat.n, cantidad: cat.qty, facturacion: cat.rev
                      }, '');
                    }
                  }
                  console.log(`    📅 ${fecha}: €${dayData.kpis.totalFac}`);
                }
              } catch(e) { console.log(`    ⚠️ Día ${day}:`, e.message); }
            }
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

// ══════════════════════════════════════════════
// PROXY GHL — Dashboard Agencia Vallore
// Todas las llamadas a services.leadconnectorhq.com
// pasan por aquí para evitar CORS desde el navegador
// ══════════════════════════════════════════════
app.use('/ghl', async (req, res) => {
  try {
    // La API key viene en la cabecera x-ghl-key o en Authorization
    const apiKey = req.headers['x-ghl-key'] || (req.headers['authorization']||'').replace('Bearer ','');
    if(!apiKey) return res.status(401).json({ error: 'Falta API key (x-ghl-key)' });

    // El path GHL viene como query param ?path=/calendars/events?...
    // o directamente en la URL /ghl/calendars/events?...
    let ghlPath;
    if(req.query.path) {
      ghlPath = req.query.path;
    } else {
      // Reconstruir path + query sin el prefijo /ghl
      const qs = new URLSearchParams(req.query).toString();
      ghlPath = req.path + (qs ? '?' + qs : '');
    }

    const ghlUrl = 'https://services.leadconnectorhq.com' + ghlPath;
    console.log(`🔀 GHL proxy → ${req.method} ${ghlUrl}`);

    const ghlRes = await fetch(ghlUrl, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Version': req.headers['version'] || '2021-04-15',
        'Content-Type': 'application/json',
      },
      body: ['POST','PUT','PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });

    const data = await ghlRes.json();
    res.status(ghlRes.status).json(data);

  } catch(e) {
    console.error('Error proxy GHL:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
// GASTOS DE AGENCIA — Panel de Agencia Vallore
// Independiente de los gastos de salones (otra tabla)
// ══════════════════════════════════════════════

// GET /gastos-agencia — cargar todos los gastos y categorías custom
app.get('/gastos-agencia', async (req, res) => {
  try {
    const [gastosRows, catsRows] = await Promise.all([
      sbQuery('gastos_agencia', 'GET', null, '?select=id,fecha,concepto,cat,importe,tipo&order=fecha.desc'),
      sbQuery('categorias_agencia', 'GET', null, '?select=cats&id=eq.1')
    ]);
    const customCats = (catsRows||[])[0]?.cats || [];
    res.json({ gastos: gastosRows || [], customCats });
  } catch(e) {
    console.log('Error cargando gastos agencia:', e.message);
    res.json({ gastos: [], customCats: [] });
  }
});

// POST /gastos-agencia — añadir un gasto nuevo
app.post('/gastos-agencia', async (req, res) => {
  const { fecha, concepto, cat, importe, tipo } = req.body;
  if (!fecha || !concepto || importe === undefined) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const ok = await sbQuery('gastos_agencia', 'POST', { fecha, concepto, cat, importe, tipo }, '');
    res.json({ ok });
  } catch(e) {
    console.log('Error guardando gasto agencia:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /gastos-agencia/:id — eliminar un gasto
app.delete('/gastos-agencia/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id requerido' });
  try {
    const ok = await sbQuery('gastos_agencia', 'DELETE', null, `?id=eq.${encodeURIComponent(id)}`);
    res.json({ ok });
  } catch(e) {
    console.log('Error borrando gasto agencia:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /gastos-agencia/cats — guardar categorías personalizadas
app.post('/gastos-agencia/cats', async (req, res) => {
  const { cats } = req.body;
  try {
    await sbQuery('categorias_agencia', 'POST', { id: 1, cats: cats || [] }, '?on_conflict=id');
    res.json({ ok: true });
  } catch(e) {
    console.log('Error guardando cats agencia:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Vallore GHL Proxy' }));
app.listen(PORT, () => console.log(`Vallore proxy en puerto ${PORT}`));
