// =====================================================================
// PRICING INTELLIGENCE PLATFORM · app.js
// Procesamiento 100% en el navegador. Tus datos nunca salen del cliente.
// =====================================================================

const App = (() => {
  // ============ STATE ============
  let RAW = null;
  let MAPPING = null;
  let DATASET_BASE = null;       // dataset procesado SIN filtros (cache para secciones no-filtrables)
  let DATASET_OPTIONS = null;    // opciones disponibles (categorias, marcas, tiendas)
  let charts = {};
  let recFilter = 'all';
  let showInheritedElast = false;
  const DECAY_LAMBDA = 0.08;
  let currentPromo = { spec: 'none', discount: 0, label: 'Sin promo' };

  // Filtros LOCALES por sección. Cada sección filtrable tiene su propio set.
  const DEFAULT_FILTERS = () => ({ window: 'all', category: 'all', brand: 'all', store: 'all', decay: false });
  const SECTION_FILTERS = {
    dashboard: DEFAULT_FILTERS(),
    predictive: DEFAULT_FILTERS(),
    elasticity: DEFAULT_FILTERS(),
  };
  function isDefaultFilters(f) {
    return f.window === 'all' && f.category === 'all' && f.brand === 'all' && f.store === 'all' && !f.decay;
  }

  // ============ COLUMN DETECTION HEURISTICS ============
  const COL_PATTERNS = {
    sku: [/^sku$/i, /prod[_\s]?nbr/i, /product[_\s]?id/i, /^codigo$/i, /id[_\s]?prod/i, /item[_\s]?id/i, /article/i],
    nombre: [/^name$/i, /product[_\s]?name/i, /class[_\s]?nm/i, /nombre[_\s]?prod/i, /descripcion/i, /producto/i, /^item$/i],
    categoria: [/^category$/i, /categoria/i, /^class$/i, /dept[_\s]?nm/i, /subdept/i, /^group/i],
    marca: [/^brand$/i, /marca/i, /fabricante/i, /manufacturer/i],
    precio: [/^price$/i, /precio[_\s]?unit/i, /^precio$/i, /unit[_\s]?price/i, /^sale[_\s]?price/i],
    costo: [/apparent[_\s]?unit[_\s]?cost/i, /unit[_\s]?cost/i, /^cost$/i, /^costo$/i, /costo[_\s]?unit/i],
    qty: [/^qty$/i, /^quantity$/i, /^cantidad$/i, /^unidades$/i, /^units$/i, /^vol/i],
    revenue: [/net[_\s]?sale/i, /^revenue$/i, /^ventas$/i, /^sales$/i, /venta[_\s]?total/i],
    margen: [/^margen$/i, /^margin$/i, /margin[_\s]?pct/i, /margen[_\s]?pct/i],
    utilidad: [/^utilidad$/i, /^profit$/i, /^gross[_\s]?profit/i, /utilidad[_\s]?bruta/i],
    fecha: [/^date$/i, /^fecha$/i, /fecha[_\s]?venta/i, /transaction[_\s]?date/i],
    año: [/^year$/i, /^año$/i, /^anio$/i, /^ano$/i],
    mes: [/^month$/i, /^mes$/i],
    dia: [/^day$/i, /^dia$/i, /^día$/i],
    tienda: [/store[_\s]?nm/i, /store[_\s]?nbr/i, /^tienda$/i, /^store$/i, /^sucursal$/i],
    proveedor: [/vendor[_\s]?nm/i, /^vendor$/i, /^proveedor$/i, /^supplier$/i],
  };

  function detectColumns(headers) {
    const mapping = {};
    for (const [field, patterns] of Object.entries(COL_PATTERNS)) {
      for (const h of headers) {
        if (mapping[field]) break;
        for (const p of patterns) {
          if (p.test(h)) { mapping[field] = h; break; }
        }
      }
    }
    return mapping;
  }

  // ============ UTILS ============
  const fmt = {
    money: n => {
      if (!Number.isFinite(n)) return '$0';
      const abs = Math.abs(n);
      const sign = n < 0 ? '-' : '';
      return sign + '$' + (abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(1)+'K' : abs.toFixed(0));
    },
    money2: n => '$' + (Number.isFinite(n) ? n : 0).toLocaleString('es-MX', {minimumFractionDigits: 2, maximumFractionDigits: 2}),
    num: n => (Number.isFinite(n) ? n : 0).toLocaleString('es-MX'),
    signed: n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%'
  };

  function groupBy(arr, keyFn) {
    const m = new Map();
    for (const item of arr) {
      const k = keyFn(item);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(item);
    }
    return m;
  }

  function quantile(arr, q) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a,b) => a-b);
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base+1] - sorted[base]) : sorted[base];
  }

  // ============ ELASTICITY: LOG-LOG REGRESSION (con WLS opcional) ============
  // weights: array opcional. Si null, equivale a OLS.
  function calcElasticity(prices, qtys, weights) {
    if (prices.length < 5) return { e: null, r2: 0 };
    const filtered = prices.map((p,i) => [p, qtys[i], weights ? weights[i] : 1])
                           .filter(([p,q,w]) => p > 0 && q > 0 && w > 0);
    if (filtered.length < 5) return { e: null, r2: 0 };
    const logP = filtered.map(x => Math.log(x[0]));
    const logQ = filtered.map(x => Math.log(x[1]));
    const w = filtered.map(x => x[2]);
    const sumW = w.reduce((a,b) => a+b, 0);
    if (sumW <= 0) return { e: null, r2: 0 };

    const meanP = logP.reduce((a,b,i) => a + b * w[i], 0) / sumW;
    const meanQ = logQ.reduce((a,b,i) => a + b * w[i], 0) / sumW;

    let stdPw = 0;
    for (let i = 0; i < logP.length; i++) stdPw += w[i] * (logP[i] - meanP) ** 2;
    stdPw = Math.sqrt(stdPw / sumW);
    if (stdPw < 0.01) return { e: null, r2: 0 };

    let num = 0, den = 0;
    for (let i = 0; i < logP.length; i++) {
      num += w[i] * (logP[i] - meanP) * (logQ[i] - meanQ);
      den += w[i] * (logP[i] - meanP) ** 2;
    }
    const slope = num / den;
    const intercept = meanQ - slope * meanP;

    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < logP.length; i++) {
      const pred = slope * logP[i] + intercept;
      ssRes += w[i] * (logQ[i] - pred) ** 2;
      ssTot += w[i] * (logQ[i] - meanQ) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    return { e: slope, r2 };
  }

  // ============ TEMPORAL HELPERS ============
  const MONTH_MAP = {
    enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11,
    january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11
  };
  function recordToDate(r) {
    if (r.fecha) {
      const d = new Date(r.fecha);
      if (Number.isFinite(d.getTime())) return d;
    }
    if (r.año && r.mes !== null && r.mes !== undefined) {
      const mLower = String(r.mes).toLowerCase().trim().replace('.','');
      let mNum = MONTH_MAP[mLower];
      if (mNum === undefined) {
        const parsed = parseInt(r.mes);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 12) mNum = parsed - 1;
      }
      if (mNum !== undefined) {
        const y = parseInt(r.año);
        if (Number.isFinite(y)) return new Date(y, mNum, r.dia || 1);
      }
    }
    return null;
  }

  function applyTemporalFilter(records, windowMonths, useDecay) {
    // Adjunta `_date` y `_weight` a cada record
    records.forEach(r => { r._date = recordToDate(r); r._weight = 1; });
    const datedRecords = records.filter(r => r._date !== null);
    if (!datedRecords.length) {
      // Sin fechas → no aplica filtro ni decay; todos pesan 1
      return { records, maxDate: null, filtered: false };
    }
    // ¡NO usar Math.max(...arr) con arrays grandes! → RangeError
    let maxTs = -Infinity;
    for (const r of datedRecords) {
      const t = r._date.getTime();
      if (t > maxTs) maxTs = t;
    }
    const maxDate = new Date(maxTs);
    let filtered = records;
    let didFilter = false;
    if (windowMonths !== 'all') {
      const months = parseInt(windowMonths);
      const cutoff = new Date(maxDate);
      cutoff.setMonth(cutoff.getMonth() - months);
      filtered = records.filter(r => r._date === null || r._date >= cutoff);
      didFilter = true;
    }
    if (useDecay) {
      filtered.forEach(r => {
        if (r._date === null) { r._weight = 0.5; return; }
        const ageMonths = (maxDate.getTime() - r._date.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
        r._weight = Math.exp(-DECAY_LAMBDA * ageMonths);
      });
    }
    return { records: filtered, maxDate, filtered: didFilter };
  }

  // ============ RECOMMENDATION ENGINE (con demanda) ============
  // Devuelve { accion, pct, razon }
  // Lógica de 3 dimensiones: elasticidad, margen y demanda (rotación).
  // La demanda matiza la urgencia y el tipo de acción.
  function recommendAction(s) {
    const el = s.elasticidad;
    const mg = s.margen;
    const dem = s.demanda || 'media';   // 'muy_alta' | 'alta' | 'media' | 'baja'
    const absE = Math.abs(el);
    const conf = s.confianza;
    const mgPct = (mg * 100).toFixed(1);
    const eFmt = el.toFixed(2);
    const demLabel = { muy_alta: 'muy alta', alta: 'alta', media: 'media', baja: 'baja' }[dem];

    // ===== 1. CRÍTICOS — margen muy bajo =====
    // Demanda alta + margen crítico = impacto desproporcionado en P&L → URGENTE
    if (mg < 0.05 && (dem === 'muy_alta' || dem === 'alta')) return {
      accion: 'REVISAR COSTO', pct: 0,
      razon: `Margen crítico ${mgPct}% en producto de demanda ${demLabel} → impacto grande en P&L. Renegociación urgente con proveedor.`
    };
    if (mg < 0.05 && dem === 'baja') return {
      accion: 'DISCONTINUAR', pct: 0,
      razon: `Margen crítico ${mgPct}% + baja rotación. Evaluar discontinuar; el costo de mantener no se justifica.`
    };
    if (mg < 0.05) return {
      accion: 'REVISAR COSTO', pct: 0,
      razon: `Margen crítico ${mgPct}%. Renegociar con proveedor o reformular precio.`
    };
    if (mg < 0.10 && absE > 1) return {
      accion: 'REVISAR COSTO', pct: 0,
      razon: `Margen ${mgPct}% bajo + elasticidad ${eFmt}. Producto de demanda ${demLabel}: reformular antes de tocar precio.`
    };

    // ===== 2. PROMOCIONES — elasticidad alta + margen amplio =====
    // Demanda alta amplifica el ROI de las promos; demanda baja la limita
    if (absE > 2.0 && mg > 0.45 && (dem === 'muy_alta' || dem === 'alta')) return {
      accion: 'PROMO 2X1', pct: -50,
      razon: `Demanda ${demLabel} + elasticidad ${eFmt} + margen ${mgPct}%. 2x1 explota volumen incremental con ROI alto.`
    };
    if (absE > 2.0 && mg > 0.45) return {
      accion: 'PROMO 3X2', pct: -33,
      razon: `Elasticidad muy alta + margen amplio. En demanda ${demLabel}, 3x2 prueba el potencial con menor exposición que 2x1.`
    };
    if (absE > 1.8 && mg > 0.38 && dem !== 'baja') return {
      accion: 'PROMO 3X2', pct: -33,
      razon: `Demanda ${demLabel} + sensibilidad alta (${eFmt}). 3x2 dispara volumen incremental rentable.`
    };
    if (absE > 1.5 && mg > 0.30 && (dem === 'muy_alta' || dem === 'alta')) return {
      accion: 'PROMO 4X3', pct: -25,
      razon: `Producto elástico de alta rotación (demanda ${demLabel}). Promo 4x3 mantiene margen y acelera tickets.`
    };
    if (absE > 1.5 && mg > 0.30) return {
      accion: 'BUNDLE', pct: -10,
      razon: `Elasticidad ${eFmt} en producto de demanda ${demLabel}. Bundle con producto complementario sube ticket sin descuento directo.`
    };
    if (absE > 1.3 && mg > 0.25 && dem !== 'baja') return {
      accion: 'BUNDLE', pct: -10,
      razon: `Sensibilidad media-alta. Bundle es la palanca correcta dado el nivel de demanda ${demLabel}.`
    };
    if (absE > 1.2 && mg > 0.20 && dem === 'baja') return {
      accion: 'CROSS-SELL', pct: 0,
      razon: `Elastico pero baja rotación. Empujar via cross-sell desde productos de alto tráfico antes de bajar precio.`
    };
    if (absE > 1.2 && mg > 0.20) return {
      accion: 'BAJAR PRECIO', pct: -5,
      razon: `Elasticidad ${eFmt} y demanda ${demLabel}. Bajar 5% activa volumen con ROI positivo.`
    };

    // ===== 3. EVITAR PROMO — elasticidad alta sin margen =====
    if (absE > 1.2 && mg < 0.18) return {
      accion: 'EVITAR PROMO', pct: 0,
      razon: `Elast ${eFmt} alta sin margen para absorber descuento (margen ${mgPct}%). Promo destruye utilidad neta.`
    };

    // ===== 4. SUBIR PRECIO — escala con demanda + margen + elasticidad =====
    // Demanda alta + inelástico + margen amplio = la oportunidad más jugosa
    if (absE < 0.3 && mg > 0.35 && (dem === 'muy_alta' || dem === 'alta')) return {
      accion: 'SUBIR PRECIO', pct: 12,
      razon: `Combinación ideal: demanda ${demLabel} + inelástico (${eFmt}) + margen ${mgPct}%. Captura agresiva justificada.`
    };
    if (absE < 0.3 && mg > 0.35) return {
      accion: 'SUBIR PRECIO', pct: 10,
      razon: `Demanda ${demLabel} pero margen y elasticidad excelentes (${eFmt}). Captura sostenida.`
    };
    if (absE < 0.5 && mg > 0.30 && (dem === 'muy_alta' || dem === 'alta')) return {
      accion: 'SUBIR PRECIO', pct: 8,
      razon: `Alta rotación (demanda ${demLabel}) + baja sensibilidad. +8% multiplica utilidad sin afectar volumen.`
    };
    if (absE < 0.5 && mg > 0.30) return {
      accion: 'SUBIR PRECIO', pct: 6,
      razon: `Elasticidad muy baja (${eFmt}) + margen amplio. +6% conservador dado nivel de demanda ${demLabel}.`
    };
    if (absE < 0.6 && mg > 0.25 && (dem === 'muy_alta' || dem === 'alta')) return {
      accion: 'SUBIR PRECIO', pct: 5,
      razon: `Demanda ${demLabel} + poco sensible. Incremento moderado de +5% captura margen extra.`
    };
    if (absE < 0.6 && mg > 0.25) return {
      accion: 'SUBIR PRECIO', pct: 3,
      razon: `Demanda ${demLabel} + elasticidad baja. +3% prudente para mejorar utilidad.`
    };
    if (absE < 0.7 && mg > 0.20) return {
      accion: 'SUBIR PRECIO', pct: 3,
      razon: `Elasticidad ${eFmt} permite ajuste suave dado margen ${mgPct}%.`
    };
    if (absE < 0.5 && mg > 0.15) return {
      accion: 'SUBIR PRECIO', pct: 2,
      razon: `Elast baja pero margen ajustado. +2% gradual para mejorar utilidad.`
    };

    // ===== 5. Segmentos específicos =====
    if (s.segmento === 'Hero Product') return {
      accion: 'MANTENER', pct: 0,
      razon: `Hero Product · demanda ${demLabel} · margen ${mgPct}% balanceado. Defender posición sin cambios.`
    };
    if (s.segmento === 'Premium Product' && mg > 0.30) return {
      accion: 'CROSS-SELL', pct: 0,
      razon: `Premium con demanda ${demLabel}. Empujar via cross-sell desde productos hero antes de tocar precio.`
    };
    if (s.segmento === 'Traffic Driver' && (dem === 'muy_alta' || dem === 'alta')) return {
      accion: 'MANTENER', pct: 0,
      razon: `Traffic Driver con demanda ${demLabel}. Usar como gancho; el valor está en cross-sell de premium.`
    };

    // ===== 6. Confianza baja =====
    if (conf === 'Baja') return {
      accion: 'A/B TEST', pct: 0,
      razon: `Baja confianza estadística (R²<0.2) en elasticidad. Test A/B en muestra controlada antes de decidir.`
    };

    // ===== 7. Default =====
    if (dem === 'baja') return {
      accion: 'MANTENER', pct: 0,
      razon: `Baja rotación + performance estable. Monitorear; sin oportunidad clara de pricing.`
    };
    return {
      accion: 'MANTENER', pct: 0,
      razon: `Performance estable · demanda ${demLabel} · sin palanca de pricing identificada.`
    };
  }

  // ============ MAIN PIPELINE ============
  // Procesa el dataset aplicando los filtros que se le pasen.
  // Si no se pasan filtros, equivale a "sin filtros" (DATASET_BASE).
  function processData(filters) {
    if (!RAW || !MAPPING) return null;
    const f = filters || DEFAULT_FILTERS();
    const m = MAPPING;

    let records = RAW.map(r => {
      const precio = parseFloat(r[m.precio]);
      const qty = parseFloat(r[m.qty]);
      const costo = m.costo ? parseFloat(r[m.costo]) : null;
      const revenue = m.revenue ? parseFloat(r[m.revenue]) : (precio * qty);
      const utilidad = m.utilidad ? parseFloat(r[m.utilidad]) : (costo ? (precio - costo) * qty : null);
      const margen = m.margen ? parseFloat(r[m.margen]) : (costo && precio ? (precio - costo) / precio : null);
      return {
        sku: r[m.sku],
        nombre: m.nombre ? r[m.nombre] : 'SKU ' + r[m.sku],
        categoria: m.categoria ? r[m.categoria] : 'General',
        marca: m.marca ? r[m.marca] : 'Sin marca',
        tienda: m.tienda ? r[m.tienda] : null,
        proveedor: m.proveedor ? r[m.proveedor] : null,
        precio, qty, costo, revenue, utilidad, margen,
        año: m.año ? parseInt(r[m.año]) : null,
        mes: m.mes ? r[m.mes] : null,
        dia: m.dia ? parseInt(r[m.dia]) : null,
        fecha: m.fecha ? r[m.fecha] : null,
      };
    }).filter(r => Number.isFinite(r.precio) && Number.isFinite(r.qty) && r.precio > 0 && r.qty > 0 && r.sku);

    if (!records.length) return null;

    // ===== Filtros categóricos (categoría, marca, tienda) =====
    if (f.category !== 'all') records = records.filter(r => r.categoria === f.category);
    if (f.brand !== 'all') records = records.filter(r => r.marca === f.brand);
    if (f.store !== 'all') records = records.filter(r => r.tienda === f.store);
    if (!records.length) return null;

    // ===== Filtro temporal y pesos =====
    const tempResult = applyTemporalFilter(records, f.window, f.decay);
    records = tempResult.records;
    if (!records.length) return null;

    const periodoActivo = (() => {
      const dated = records.filter(r => r._date);
      if (!dated.length) return 'sin fechas';
      let minTs = Infinity, maxTs = -Infinity;
      for (const r of dated) {
        const t = r._date.getTime();
        if (t < minTs) minTs = t;
        if (t > maxTs) maxTs = t;
      }
      const fmtMD = ts => new Date(ts).toISOString().substring(0,7);
      return `${fmtMD(minTs)} → ${fmtMD(maxTs)}`;
    })();

    // ===== Aggregation por SKU =====
    const skuGroups = groupBy(records, r => r.sku);
    const skus = [];
    for (const [sku, items] of skuGroups) {
      const prices = items.map(i => i.precio);
      const qtys = items.map(i => i.qty);
      const costs = items.map(i => i.costo).filter(Number.isFinite);
      const margens = items.map(i => i.margen).filter(Number.isFinite);
      const rev = items.reduce((a,i) => a + (Number.isFinite(i.revenue) ? i.revenue : 0), 0);
      const util = items.reduce((a,i) => a + (Number.isFinite(i.utilidad) ? i.utilidad : 0), 0);
      const units = items.reduce((a,i) => a + i.qty, 0);
      const precioAvg = prices.reduce((a,b) => a+b, 0) / prices.length;
      const costoAvg = costs.length ? costs.reduce((a,b) => a+b, 0) / costs.length : null;
      const margenAvg = margens.length ? margens.reduce((a,b) => a+b, 0) / margens.length :
                        (costoAvg && precioAvg ? (precioAvg - costoAvg) / precioAvg : 0);
      const priceStd = (() => {
        const mn = precioAvg;
        return Math.sqrt(prices.reduce((a,p) => a + (p-mn)**2, 0) / prices.length);
      })();
      let minP = Infinity, maxP = -Infinity;
      for (const p of prices) { if (p < minP) minP = p; if (p > maxP) maxP = p; }
      const priceSpread = precioAvg > 0 ? (maxP - minP) / precioAvg : 0;

      const { e, r2 } = calcElasticity(prices, qtys, items.map(i => i._weight));
      const tiendas = new Set(items.map(i => i.tienda).filter(Boolean)).size;

      skus.push({
        sku: String(sku),
        nombre: items[0].nombre || ('SKU ' + sku),
        marca: items[0].marca || 'Sin marca',
        categoria: items[0].categoria || 'General',
        precio: +precioAvg.toFixed(2),
        costo: costoAvg ? +costoAvg.toFixed(2) : null,
        margen: +margenAvg.toFixed(4),
        revenue: +rev.toFixed(2),
        unidades: units,
        utilidad: +util.toFixed(2),
        elasticidad: null,
        r2,
        confianza: 'Baja',
        segmento: null,
        accion: null,
        accion_pct: 0,
        razon: '',
        tiendas,
        priceVar: precioAvg > 0 ? +(priceStd/precioAvg).toFixed(4) : 0,
        priceSpread,
        minP, maxP,
        transacciones: items.length,
        _rawElast: e
      });
    }

    // Elasticidad por categoría como fallback
    const catElast = {};
    for (const [cat, items] of groupBy(records, r => r.categoria)) {
      const { e } = calcElasticity(items.map(i => i.precio), items.map(i => i.qty), items.map(i => i._weight));
      catElast[cat] = e !== null ? e : -1.0;
    }

    for (const s of skus) {
      if (s._rawElast !== null) {
        s.elasticidad = +s._rawElast.toFixed(3);
        s.elastSource = 'propia';
      } else {
        s.elasticidad = +(catElast[s.categoria] !== undefined ? catElast[s.categoria] : -1).toFixed(3);
        s.elastSource = 'categoria';
      }
      if (s.transacciones < 5) s.confianza = 'Baja';
      else if (s.r2 > 0.5) s.confianza = 'Alta';
      else if (s.r2 > 0.2) s.confianza = 'Media';
      else s.confianza = 'Baja';
      delete s._rawElast;
    }

    // ===== Demanda (clasificación por cuartil de unidades) =====
    // Permite que recomendaciones consideren rotación, no solo elasticidad+margen
    const unitsArr = skus.map(s => s.unidades);
    const dQ33 = quantile(unitsArr, 0.33);
    const dQ66 = quantile(unitsArr, 0.66);
    const dQ90 = quantile(unitsArr, 0.90);
    for (const s of skus) {
      if (s.unidades >= dQ90) s.demanda = 'muy_alta';
      else if (s.unidades >= dQ66) s.demanda = 'alta';
      else if (s.unidades >= dQ33) s.demanda = 'media';
      else s.demanda = 'baja';
    }

    // ===== Segmentación =====
    const revs = skus.map(s => s.revenue);
    const mgs = skus.map(s => s.margen);
    const precios = skus.map(s => s.precio);
    const revQ75 = quantile(revs, 0.75);
    const revQ50 = quantile(revs, 0.50);
    const mgQ50 = quantile(mgs, 0.50);
    const mgQ25 = quantile(mgs, 0.25);
    const precioMed = quantile(precios, 0.50);

    for (const s of skus) {
      const rev = s.revenue, mg = s.margen, el = s.elasticidad;
      if (rev >= revQ75 && mg >= mgQ50) s.segmento = 'Hero Product';
      else if (rev >= revQ75 && mg < mgQ50) s.segmento = 'Traffic Driver';
      else if (mg >= mgQ50 && rev < revQ50 && s.precio > precioMed) s.segmento = 'Premium Product';
      else if (mg < mgQ25) s.segmento = 'Margin Killer';
      else if (Math.abs(el) > 1.5) s.segmento = 'Sensitive Product';
      else s.segmento = 'Standard';
    }

    // ===== Recomendaciones (nueva lógica) =====
    for (const s of skus) {
      const r = recommendAction(s);
      s.accion = r.accion; s.accion_pct = r.pct; s.razon = r.razon;
    }

    // ===== Agregaciones para dashboard =====
    const totalRev = records.reduce((a,r) => a + (r.revenue || 0), 0);
    const totalUtil = records.reduce((a,r) => a + (r.utilidad || 0), 0);
    const totalUnits = records.reduce((a,r) => a + r.qty, 0);
    const avgMg = (() => {
      const arr = records.map(r => r.margen).filter(Number.isFinite);
      return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
    })();

    const kpis = {
      revenue_total: totalRev,
      utilidad_total: totalUtil,
      margen_avg: avgMg,
      unidades: totalUnits,
      transacciones: records.length,
      skus: skus.length,
      marcas: new Set(records.map(r => r.marca)).size,
      tiendas: new Set(records.map(r => r.tienda).filter(Boolean)).size,
      ticket_promedio: records.length ? totalRev / records.length : 0
    };

    // Tendencia temporal
    let monthly = [];
    if (MAPPING.año && MAPPING.mes) {
      const monthMap = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12,
                          january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
      const grouped = groupBy(records, r => {
        let mNum;
        const mLower = String(r.mes).toLowerCase().replace('.','').replace('trim','').trim();
        mNum = monthMap[mLower] || (parseInt(r.mes) || 0);
        return r.año + '-' + String(mNum).padStart(2, '0');
      });
      monthly = [...grouped.entries()]
        .filter(([k]) => !k.includes('NaN') && !k.includes('undefined'))
        .map(([k, items]) => ({
          periodo: k,
          revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
          unidades: items.reduce((a,i) => a + i.qty, 0),
          utilidad: items.reduce((a,i) => a + (i.utilidad || 0), 0)
        }))
        .sort((a,b) => a.periodo.localeCompare(b.periodo));
    } else if (MAPPING.fecha) {
      const grouped = groupBy(records, r => {
        const d = new Date(r.fecha);
        return Number.isFinite(d.getTime()) ? d.toISOString().substring(0,7) : null;
      });
      monthly = [...grouped.entries()].filter(([k]) => k).map(([k, items]) => ({
        periodo: k,
        revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
        unidades: items.reduce((a,i) => a + i.qty, 0),
        utilidad: items.reduce((a,i) => a + (i.utilidad || 0), 0)
      })).sort((a,b) => a.periodo.localeCompare(b.periodo));
    }

    // Top categorías
    const categorias = [...groupBy(records, r => r.categoria).entries()].map(([nombre, items]) => ({
      nombre,
      revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
      unidades: items.reduce((a,i) => a + i.qty, 0),
      skus: new Set(items.map(i => i.sku)).size
    })).sort((a,b) => b.revenue - a.revenue);

    // Elasticidad por categoría (para predictivo)
    const elastByCat = {};
    for (const cat of categorias) {
      const items = records.filter(r => r.categoria === cat.nombre);
      const { e } = calcElasticity(items.map(i => i.precio), items.map(i => i.qty), items.map(i => i._weight));
      elastByCat[cat.nombre] = e !== null ? e : -1.0;
    }

    // Top marcas
    const marcas = [...groupBy(records, r => r.marca).entries()].map(([nombre, items]) => ({
      nombre,
      revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
      unidades: items.reduce((a,i) => a + i.qty, 0)
    })).sort((a,b) => b.revenue - a.revenue);

    // Top tiendas
    const tiendas = [...groupBy(records.filter(r => r.tienda), r => r.tienda).entries()].map(([nombre, items]) => ({
      nombre,
      revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
      unidades: items.reduce((a,i) => a + i.qty, 0),
      margen: (() => { const arr = items.map(i => i.margen).filter(Number.isFinite); return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; })()
    })).sort((a,b) => b.revenue - a.revenue).slice(0, 20);

    // Curvas (para vista de elasticidad)
    // Umbrales relajados: 3 transacciones mínimo (antes 5), 2 niveles de precio distintos (antes 3)
    // Bucketing aproximado: agrupa precios cercanos en ±2% para tolerar redondeos
    const skuTopByRev = [...skus].sort((a,b) => b.revenue - a.revenue).slice(0, 200);
    const elastCurves = {};
    for (const s of skuTopByRev) {
      const items = skuGroups.get(s.sku) || skuGroups.get(parseInt(s.sku)) || [];
      if (items.length < 3) continue;
      // Bucketing: redondear al múltiplo más cercano de 2% del precio promedio del SKU
      const avgP = items.reduce((a,i) => a + i.precio, 0) / items.length;
      const bucketSize = Math.max(0.01, avgP * 0.02);
      const buckets = new Map();
      for (const i of items) {
        const key = Math.round(i.precio / bucketSize) * bucketSize;
        if (!buckets.has(key)) buckets.set(key, 0);
        buckets.set(key, buckets.get(key) + i.qty);
      }
      const sorted = [...buckets.entries()].sort((a,b) => a[0] - b[0]);
      if (sorted.length >= 2) {
        elastCurves[s.sku] = {
          precios: sorted.map(x => +x[0].toFixed(2)),
          cantidades: sorted.map(x => x[1])
        };
      }
    }

    // ===== Análisis post-promoción =====
    // SKUs con alta variación de precio (proxy de promo)
    const promoSkus = skus.filter(s => s.priceSpread > 0.15).map(s => s.sku);
    let postPromo = null;
    if (promoSkus.length && monthly.length >= 3) {
      // Para cada SKU con variación, comparar volumen en precio "alto" (antes/después) vs "bajo" (durante)
      let antes = 0, durante = 0, despues = 0, baseline = 0;
      let n = 0;
      for (const sku of promoSkus.slice(0, 100)) {
        const items = (skuGroups.get(sku) || skuGroups.get(parseInt(sku)) || []).slice().sort((a,b) => {
          const fa = (a.año*100 + (parseInt(a.mes)||0)); const fb = (b.año*100 + (parseInt(b.mes)||0));
          return fa - fb;
        });
        if (items.length < 6) continue;
        const median = quantile(items.map(i => i.precio), 0.5);
        // Identifica el primer "valle" de precio
        let promoIdx = items.findIndex(i => i.precio < median * 0.9);
        if (promoIdx < 1 || promoIdx >= items.length - 1) continue;
        const a = items.slice(Math.max(0, promoIdx - 2), promoIdx);
        const d = items.slice(promoIdx, promoIdx + 1);
        const p = items.slice(promoIdx + 1, promoIdx + 3);
        const aQ = a.reduce((x,y) => x + y.qty, 0) / (a.length || 1);
        const dQ = d.reduce((x,y) => x + y.qty, 0) / (d.length || 1);
        const pQ = p.reduce((x,y) => x + y.qty, 0) / (p.length || 1);
        antes += aQ; durante += dQ; despues += pQ; baseline += aQ;
        n++;
      }
      if (n > 0) {
        antes /= n; durante /= n; despues /= n; baseline /= n;
        const liftDurante = baseline > 0 ? (durante / baseline - 1) * 100 : 0;
        const liftDespues = baseline > 0 ? (despues / baseline - 1) * 100 : 0;
        postPromo = { antes, durante, despues, liftDurante, liftDespues, samples: n };
      }
    }

    // ===== Anomalías =====
    const anomalias = [];
    for (const s of skus.filter(s => s.margen < 0.05).slice(0, 8)) {
      anomalias.push({ tipo: 'critico', sku: s.sku, marca: s.marca, mensaje: `Margen crítico ${(s.margen*100).toFixed(1)}% — riesgo destrucción de margen` });
    }
    for (const s of skus.filter(s => s.priceVar > 0.3).slice(0, 8)) {
      anomalias.push({ tipo: 'warning', sku: s.sku, marca: s.marca, mensaje: `Variación de precio anormal (${(s.priceVar*100).toFixed(1)}%) entre tiendas/fechas` });
    }
    if (!anomalias.length) {
      anomalias.push({ tipo: 'info', sku: '—', marca: '—', mensaje: 'Sin anomalías críticas detectadas en este dataset.' });
    }

    // ===== Insights ejecutivos =====
    const oppSkus = skus.filter(s => s.accion === 'SUBIR PRECIO');
    const oppRev = oppSkus.reduce((a,s) => a + s.revenue * (s.accion_pct/100), 0);
    const promoOpp = skus.filter(s => s.accion.startsWith('PROMO') || s.accion === 'BUNDLE');
    const pctSubir = (oppSkus.length / Math.max(skus.length,1) * 100);
    const topCat = categorias[0];
    const topMarca = marcas[0];
    const marcaShare = topMarca && totalRev ? (topMarca.revenue / totalRev * 100) : 0;

    const insights = [
      {
        titulo: `${pctSubir.toFixed(0)}% de los SKUs tienen oportunidad de incremento de precio`,
        descripcion: `Identificamos ${oppSkus.length} productos con elasticidad baja donde un ajuste al alza captura margen sin sacrificar volumen significativo.`,
        tipo: 'oportunidad',
        valor: '+' + fmt.money(Math.abs(oppRev))
      },
      promoOpp.length ? {
        titulo: `${promoOpp.length} SKUs son candidatos a promoción (2X1 / 3X2 / Bundle)`,
        descripcion: `Productos con elasticidad alta y margen amplio permiten activar volumen con mecánicas promocionales sin comprometer utilidad neta.`,
        tipo: 'estrategico',
        valor: promoOpp.length + ' SKUs'
      } : null,
      topMarca ? {
        titulo: `${topMarca.nombre} es la marca dominante con ${marcaShare.toFixed(0)}% del revenue`,
        descripcion: `Concentra el mayor volumen de ventas. Optimizar pricing en esta marca tiene impacto desproporcionado en utilidad.`,
        tipo: 'estrategico',
        valor: fmt.money(topMarca.revenue)
      } : null,
      topCat ? {
        titulo: `${topCat.nombre} es la categoría #1 con ${fmt.money(topCat.revenue)} en revenue`,
        descripcion: `Concentra ${topCat.skus} SKUs activos. Categoría prioritaria para estrategia de pricing dinámico.`,
        tipo: 'categoria',
        valor: (totalRev ? (topCat.revenue/totalRev*100).toFixed(0) : '0') + '% share'
      } : null,
      anomalias.length && anomalias[0].tipo !== 'info' ? {
        titulo: `${anomalias.length} anomalías de pricing detectadas`,
        descripcion: `Productos con márgenes críticos o variación inconsistente de precio entre tiendas requieren intervención inmediata.`,
        tipo: 'riesgo',
        valor: `${anomalias.length} SKUs`
      } : null,
    ].filter(Boolean);

    return {
      kpis, skus, monthly, categorias, marcas, tiendas,
      elastCurves, elastByCat,
      insights, anomalias, postPromo,
      meta: {
        filasTotales: records.length,
        skusTotales: skus.length,
        periodo: monthly.length ? `${monthly[0].periodo} → ${monthly[monthly.length-1].periodo}` : '—',
        periodoActivo,
        windowFilter: f.window,
        decayActive: f.decay,
        promoCandidatos: promoOpp.length,
        revOportunidad: Math.abs(oppRev),
      }
    };
  }

  // ============ COLORES Y CONSTANTES ============
  const segColors = {
    'Hero Product': '#FFD100', 'Traffic Driver': '#4d9fff',
    'Premium Product': '#b388ff', 'Margin Killer': '#ff4d6d',
    'Sensitive Product': '#00d68f', 'Standard': '#6b6b78',
  };
  const segClass = { 'Hero Product':'hero','Traffic Driver':'traffic','Premium Product':'premium','Margin Killer':'killer','Sensitive Product':'sensitive','Standard':'standard' };
  const segDefs = {
    'Hero Product': { icon: '★', desc: 'Alto revenue + margen saludable. Producto estrella. Estrategia: mantener precio, defender posición.' },
    'Traffic Driver': { icon: '↗', desc: 'Alto volumen pero margen bajo. Atrae tráfico. Estrategia: usar para promo, cross-sell con premium.' },
    'Premium Product': { icon: '◆', desc: 'Margen alto, volumen menor. Posicionamiento aspiracional. Estrategia: defender pricing, comunicar valor.' },
    'Margin Killer': { icon: '⚠', desc: 'Margen crítico. Drena rentabilidad. Estrategia: renegociar costo, subir precio o discontinuar.' },
    'Sensitive Product': { icon: '⚡', desc: 'Demanda altamente elástica. Estrategia: evitar cambios bruscos, promo selectiva.' },
    'Standard': { icon: '•', desc: 'Performance estable, sin oportunidad clara. Mantener bajo monitoreo.' },
  };
  const actionPill = {
    'SUBIR PRECIO': 'pill-green', 'BAJAR PRECIO': 'pill-blue',
    'PROMO 2X1': 'pill-purple', 'PROMO 3X2': 'pill-purple', 'PROMO 4X3': 'pill-purple',
    'BUNDLE': 'pill-blue', 'CROSS-SELL': 'pill-blue',
    'EVITAR PROMO': 'pill-yellow', 'REVISAR COSTO': 'pill-red', 'DISCONTINUAR': 'pill-red',
    'A/B TEST': 'pill-gray', 'MANTENER': 'pill-gray'
  };
  const actionArrow = {
    'SUBIR PRECIO': '↑', 'BAJAR PRECIO': '↓',
    'PROMO 2X1': '2×1', 'PROMO 3X2': '3×2', 'PROMO 4X3': '4×3',
    'BUNDLE': '⊕', 'CROSS-SELL': '⇄',
    'EVITAR PROMO': '⊘', 'REVISAR COSTO': '⚙', 'DISCONTINUAR': '✕',
    'A/B TEST': 'A/B', 'MANTENER': '='
  };
  const insightIcons = { oportunidad: '↗', riesgo: '⚠', estrategico: '◆', categoria: '★' };

  // ============ RENDER ============
  // Devuelve el dataset filtrado para una sección. Si los filtros son default,
  // devuelve el DATASET_BASE cacheado para evitar recomputar.
  function getDatasetForSection(section) {
    const f = SECTION_FILTERS[section];
    if (!f || isDefaultFilters(f)) return DATASET_BASE;
    return processData(f);
  }

  function renderAll() {
    if (!DATASET_BASE) return;
    renderDescriptive();
    renderPredictive();
    renderElasticity();
    renderSimulator();
    renderSegmentation();
    renderRecommendations();
    renderInsights();
    renderAnomalies();
    renderSkuTable();
    renderExecutive();
  }

  // ============ CHARTS BASE ============
  const baseScale = {
    grid: { color: 'rgba(42,42,53,0.6)', drawTicks: false },
    ticks: { color: '#6b6b78', font: { size: 10 } },
    border: { display: false }
  };
  const tooltipStyle = { backgroundColor: '#131318', borderColor: '#2a2a35', borderWidth: 1, titleColor: '#fff', bodyColor: '#a8a8b3', padding: 10 };

  function destroyChart(name) {
    if (charts[name]) {
      try { charts[name].destroy(); } catch(e){}
      delete charts[name];
    }
  }
  function destroyAllCharts() {
    Object.keys(charts).forEach(destroyChart);
  }

  // ============ DASHBOARD DESCRIPTIVO ============
  function renderDescriptive() {
    const DATASET = getDatasetForSection('dashboard');
    syncFilterBarForSection('dashboard');
    if (!DATASET) { showSectionEmpty('view-dashboard', 'dashboard'); return; }
    const k = DATASET.kpis;
    const meta = DATASET.meta;

    document.getElementById('kpiGrid').innerHTML = [
      { label: 'Revenue total', value: fmt.money(k.revenue_total), meta: 'Periodo completo', accent: true },
      { label: 'Utilidad total', value: fmt.money(k.utilidad_total), meta: 'Profit acumulado' },
      { label: 'Margen promedio', value: (k.margen_avg*100).toFixed(1) + '%', meta: 'Ponderado' },
      { label: 'Unidades vendidas', value: fmt.num(k.unidades), meta: `${fmt.num(k.transacciones)} transacciones` },
      { label: 'SKUs activos', value: fmt.num(k.skus), meta: `${k.marcas} marcas` },
      ...(k.tiendas ? [{ label: 'Tiendas / canales', value: fmt.num(k.tiendas), meta: 'Cobertura' }] : []),
      { label: 'Ticket promedio', value: fmt.money2(k.ticket_promedio), meta: 'Por transacción' },
    ].map(it => `
      <div class="kpi ${it.accent ? 'accent' : ''}">
        <div class="kpi-label">${it.label}</div>
        <div class="kpi-value">${it.value}</div>
        <div class="kpi-meta"><span>${it.meta}</span></div>
      </div>
    `).join('');

    document.getElementById('periodPill').textContent = DATASET.meta.periodo;

    // Revenue mensual
    destroyChart('monthly');
    if (DATASET.monthly.length) {
      charts.monthly = new Chart(document.getElementById('chartMonthly'), {
        type: 'line',
        data: {
          labels: DATASET.monthly.map(m => m.periodo),
          datasets: [
            { label: 'Revenue', data: DATASET.monthly.map(m => m.revenue),
              borderColor: '#FFD100',
              backgroundColor: ctx => { const g = ctx.chart.ctx.createLinearGradient(0,0,0,300); g.addColorStop(0,'rgba(255,209,0,0.3)'); g.addColorStop(1,'rgba(255,209,0,0)'); return g; },
              borderWidth: 2, tension: 0.4, fill: true, pointRadius: 0, pointHoverRadius: 5 },
            { label: 'Utilidad', data: DATASET.monthly.map(m => m.utilidad),
              borderColor: '#00d68f', borderWidth: 2, tension: 0.4, fill: false, pointRadius: 0, pointHoverRadius: 5 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8 } }, tooltip: { ...tooltipStyle, callbacks: { label: c => c.dataset.label + ': ' + fmt.money2(c.parsed.y) } } },
          scales: { x: baseScale, y: { ...baseScale, ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } } }
        }
      });
    }

    // Post-promo
    destroyChart('postPromo');
    const ppCanvas = document.getElementById('chartPostPromo');
    let ppPlaceholder = document.getElementById('postPromoPlaceholder');
    if (!ppPlaceholder) {
      ppPlaceholder = document.createElement('div');
      ppPlaceholder.id = 'postPromoPlaceholder';
      ppPlaceholder.style.cssText = 'display:none;position:absolute;inset:0;place-items:center;color:var(--text-3);font-size:12px;text-align:center;padding:20px;background:var(--surface);';
      ppCanvas.parentElement.style.position = 'relative';
      ppCanvas.parentElement.appendChild(ppPlaceholder);
    }
    const pp = DATASET.postPromo;
    if (pp) {
      ppCanvas.style.display = '';
      ppPlaceholder.style.display = 'none';
      charts.postPromo = new Chart(ppCanvas, {
        type: 'line',
        data: {
          labels: ['Antes', 'Durante promo', 'Después'],
          datasets: [{
            data: [pp.antes, pp.durante, pp.despues],
            borderColor: '#FFD100',
            backgroundColor: ctx => { const g = ctx.chart.ctx.createLinearGradient(0,0,0,300); g.addColorStop(0,'rgba(255,209,0,0.4)'); g.addColorStop(1,'rgba(255,209,0,0)'); return g; },
            borderWidth: 3, tension: 0.4, fill: true,
            pointRadius: 7, pointHoverRadius: 10,
            pointBackgroundColor: ['#a8a8b3', '#FFD100', '#FFA500'],
            pointBorderColor: '#000', pointBorderWidth: 2
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: c => 'Unidades promedio: ' + fmt.num(Math.round(c.parsed.y)) } } },
          scales: { x: { ...baseScale, grid: { display: false } }, y: { ...baseScale, ticks: { ...baseScale.ticks, callback: v => fmt.num(v) } } }
        }
      });
      const lift = pp.liftDespues;
      const liftLabel = lift >= 0 ? '+' + lift.toFixed(0) + '% post-promo' : lift.toFixed(0) + '% post-promo';
      document.getElementById('postPromoBadge').textContent = liftLabel;
      document.getElementById('postPromoBadge').className = 'pill ' + (lift > 5 ? 'pill-green' : lift < -5 ? 'pill-red' : 'pill-yellow');
    } else {
      ppCanvas.style.display = 'none';
      ppPlaceholder.style.display = 'grid';
      ppPlaceholder.textContent = 'Insuficiente variación de precio temporal para detectar promociones';
      document.getElementById('postPromoBadge').textContent = '—';
      document.getElementById('postPromoBadge').className = 'pill pill-gray';
    }

    // Top categorías
    destroyChart('categorias');
    const cats = DATASET.categorias.slice(0, 8);
    charts.categorias = new Chart(document.getElementById('chartCategorias'), {
      type: 'bar',
      data: { labels: cats.map(c => c.nombre.length > 18 ? c.nombre.substring(0,16)+'…' : c.nombre),
        datasets: [{ data: cats.map(c => c.revenue),
          backgroundColor: cats.map((_,i) => i === 0 ? '#FFD100' : i === 1 ? '#FFA500' : i === 2 ? '#FF7B00' : `rgba(255,209,0,${0.7 - i*0.07})`),
          borderRadius: 4 }]
      },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: c => fmt.money2(c.parsed.x) } } },
        scales: { x: { ...baseScale, ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } }, y: { ...baseScale, grid: { display: false } } }
      }
    });

    // Marcas
    destroyChart('marcas');
    const marcas = DATASET.marcas.slice(0, 10);
    charts.marcas = new Chart(document.getElementById('chartMarcas'), {
      type: 'doughnut',
      data: { labels: marcas.map(m => m.nombre),
        datasets: [{ data: marcas.map(m => m.revenue),
          backgroundColor: ['#FFD100','#FFA500','#FF7B00','#4d9fff','#00d68f','#b388ff','#ff4d6d','#6b6b78','#3a3a48','#2a2a35'],
          borderColor: '#0d0d10', borderWidth: 2, hoverOffset: 6 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10.5 }, padding: 8 } },
          tooltip: { ...tooltipStyle, callbacks: { label: c => `${c.label}: ${fmt.money(c.parsed)}` } } }
      }
    });

    // Top tiendas
    if (DATASET.tiendas.length) {
      document.getElementById('topTiendas').innerHTML = `
        <thead><tr><th>Tienda / Canal</th><th style="text-align:right">Revenue</th><th style="text-align:right">Units</th><th style="text-align:right">Mg%</th></tr></thead>
        <tbody>${DATASET.tiendas.slice(0,8).map(t => `
          <tr><td class="strong">${String(t.nombre).substring(0,22)}</td>
          <td class="num" style="text-align:right">${fmt.money(t.revenue)}</td>
          <td class="num" style="text-align:right">${t.unidades}</td>
          <td class="num" style="text-align:right">${(t.margen*100).toFixed(1)}%</td></tr>
        `).join('')}</tbody>`;
    } else {
      document.getElementById('topTiendas').innerHTML = `<tbody><tr><td style="padding:24px;color:var(--text-3);text-align:center;">Sin columna de tienda</td></tr></tbody>`;
    }

    // Canibalización
    destroyChart('cannibal');
    const promoSkus = DATASET.skus.filter(s => s.accion.startsWith('PROMO') || s.accion === 'BUNDLE');
    const restSkus = DATASET.skus.filter(s => !s.accion.startsWith('PROMO') && s.accion !== 'BUNDLE');
    const promoRev = promoSkus.reduce((a,s) => a + s.revenue, 0);
    const restRev = restSkus.reduce((a,s) => a + s.revenue, 0);
    charts.cannibal = new Chart(document.getElementById('chartCannibal'), {
      type: 'doughnut',
      data: { labels: ['Candidatos a promo', 'Resto del catálogo'],
        datasets: [{ data: [promoRev, restRev],
          backgroundColor: ['#FFD100', '#3a3a48'],
          borderColor: '#0d0d10', borderWidth: 2, hoverOffset: 6 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 8, font: { size: 11 } } },
          tooltip: { ...tooltipStyle, callbacks: { label: c => `${c.label}: ${fmt.money(c.parsed)} (${(c.parsed/(promoRev+restRev)*100).toFixed(1)}%)` } } }
      }
    });

    // Insight banner
    const top = DATASET.insights[0];
    if (top) {
      document.getElementById('insightBanner').innerHTML = `
        <span><strong>INSIGHT CLAVE:</strong> ${top.titulo}. ${top.descripcion} <em>${top.valor}</em></span>
      `;
    }
  }

  // ============ DASHBOARD PREDICTIVO ============
  function renderPredictive() {
    const DATASET = getDatasetForSection('predictive');
    syncFilterBarForSection('predictive');
    if (!DATASET) { showSectionEmpty('view-predictive', 'predictive'); return; }
    const k = DATASET.kpis;
    const skus = DATASET.skus;
    const sensibles = skus.filter(s => Math.abs(s.elasticidad) > 1.5).length;
    const elastAvg = skus.reduce((a,s) => a + s.elasticidad, 0) / Math.max(skus.length,1);
    const oppRev = DATASET.meta.revOportunidad;
    const profitIncrease = k.revenue_total > 0 ? (oppRev / k.revenue_total * 100) : 0;
    const revEstimado = k.revenue_total + oppRev;

    document.getElementById('predictiveKpis').innerHTML = [
      { label: 'Revenue estimado', value: fmt.money(revEstimado), meta: 'Aplicando recomendaciones', accent: true, mega: true },
      { label: 'Elasticidad promedio', value: elastAvg.toFixed(2), meta: 'Portafolio agregado', mega: true },
      { label: 'Productos sensibles', value: fmt.num(sensibles), meta: 'Items críticos · |E|>1.5', mega: true },
      { label: 'Incremento esperado', value: '+' + profitIncrease.toFixed(1) + '%', meta: 'Sobre revenue actual', mega: true, positive: true },
    ].map(it => `
      <div class="kpi ${it.accent ? 'accent' : ''} ${it.mega ? 'mega' : ''} ${it.positive ? 'positive' : ''}">
        <div class="kpi-label">${it.label}</div>
        <div class="kpi-value">${it.value}</div>
        <div class="kpi-meta"><span>${it.meta}</span></div>
      </div>
    `).join('');

    // Demanda vs Precio (scatter por segmento)
    destroyChart('demandPrice');
    charts.demandPrice = new Chart(document.getElementById('chartDemandPrice'), {
      type: 'bubble',
      data: { datasets: Object.keys(segColors).map(seg => ({
        label: seg,
        data: skus.filter(s => s.segmento === seg).map(s => ({
          x: s.precio,
          y: s.unidades,
          r: Math.min(18, Math.max(3, Math.sqrt(s.revenue)/20)),
          sku: s
        })),
        backgroundColor: segColors[seg] + 'CC',
        borderColor: segColors[seg], borderWidth: 1
      })) },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } },
          tooltip: { ...tooltipStyle, callbacks: { title: c => c[0].raw.sku.nombre + ' · ' + c[0].raw.sku.marca, label: c => `Precio: ${fmt.money2(c.raw.x)} · Unidades: ${c.raw.y} · E: ${c.raw.sku.elasticidad.toFixed(2)}` } } },
        scales: { x: { ...baseScale, type: 'logarithmic', title: { display: true, text: 'Precio (log)', color: '#6b6b78' }, ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } }, y: { ...baseScale, type: 'logarithmic', title: { display: true, text: 'Unidades (log)', color: '#6b6b78' } } }
      }
    });

    // Elasticidad por categoría
    destroyChart('elastByCat');
    const elastCats = Object.entries(DATASET.elastByCat)
      .map(([cat, e]) => ({ cat, e }))
      .sort((a,b) => a.e - b.e)
      .slice(0, 10);
    charts.elastByCat = new Chart(document.getElementById('chartElastByCat'), {
      type: 'bar',
      data: { labels: elastCats.map(x => x.cat.length > 18 ? x.cat.substring(0,16)+'…' : x.cat),
        datasets: [{ data: elastCats.map(x => x.e),
          backgroundColor: elastCats.map(x => Math.abs(x.e) > 1.5 ? '#ff4d6d' : Math.abs(x.e) > 1 ? '#FFA500' : '#FFD100'),
          borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { ...tooltipStyle, callbacks: { label: c => `Elasticidad: ${c.parsed.y.toFixed(2)} · ${Math.abs(c.parsed.y) > 1.5 ? 'Sensible' : Math.abs(c.parsed.y) > 1 ? 'Moderada' : 'Inelástica'}` } } },
        scales: { x: { ...baseScale, grid: { display: false } }, y: { ...baseScale, title: { display: true, text: 'Elasticidad (más negativo = más sensible)', color: '#6b6b78' } } }
      }
    });

    // Top más elásticos
    const topElast = [...skus].sort((a,b) => Math.abs(b.elasticidad) - Math.abs(a.elasticidad)).slice(0, 8);
    document.getElementById('topElastList').innerHTML = topElast.map(s => `
      <div class="elast-row">
        <div>
          <div class="name">${s.nombre}</div>
          <div class="meta">${s.marca} · SKU ${s.sku} · ${s.segmento}</div>
        </div>
        <div class="e-val">${s.elasticidad.toFixed(2)}</div>
      </div>
    `).join('');

    // Precios óptimos
    const optimal = skus.filter(s => s.accion === 'SUBIR PRECIO' || s.accion === 'BAJAR PRECIO')
      .sort((a,b) => b.revenue - a.revenue).slice(0, 12);
    document.getElementById('optimalPriceTable').innerHTML = `
      <thead><tr>
        <th>Producto</th><th style="text-align:right">Precio actual</th><th style="text-align:right">Precio óptimo</th><th style="text-align:right">Δ</th>
      </tr></thead>
      <tbody>${optimal.map(s => {
        const newP = s.precio * (1 + s.accion_pct/100);
        const cls = s.accion_pct > 0 ? 'var(--green)' : 'var(--red)';
        return `
          <tr>
            <td class="strong" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.nombre}<div style="font-size:10.5px;color:var(--text-3);font-weight:500">${s.marca}</div></td>
            <td class="num" style="text-align:right">${fmt.money2(s.precio)}</td>
            <td class="num" style="text-align:right;color:${cls};font-weight:600">${fmt.money2(newP)}</td>
            <td class="num" style="text-align:right;color:${cls};font-weight:600">${s.accion_pct > 0 ? '+' : ''}${s.accion_pct}%</td>
          </tr>`;
      }).join('') || '<tr><td colspan="4" style="padding:24px;color:var(--text-3);text-align:center">Sin acciones de precio recomendadas</td></tr>'}</tbody>
    `;
  }

  // ============ ELASTICITY VIEW ============
  function renderElasticity() {
    const DATASET = getDatasetForSection('elasticity');
    syncFilterBarForSection('elasticity');
    if (!DATASET) { showSectionEmpty('view-elasticity', 'elasticity'); return; }
    const skus = DATASET.skus;
    const propias = skus.filter(s => s.elastSource === 'propia');
    const heredadas = skus.filter(s => s.elastSource === 'categoria');
    const inelastic = skus.filter(s => Math.abs(s.elasticidad) < 1).length;
    const unitary = skus.filter(s => Math.abs(s.elasticidad) >= 1 && Math.abs(s.elasticidad) < 1.5).length;
    const elastic = skus.filter(s => Math.abs(s.elasticidad) >= 1.5).length;
    const avg = propias.length ? propias.reduce((a,s) => a + s.elasticidad, 0) / propias.length : 0;
    document.getElementById('elasticBadges').innerHTML = `
      <div class="kpi"><div class="kpi-label">Elasticidad propia (avg)</div><div class="kpi-value">${avg.toFixed(2)}</div><div class="kpi-meta">${propias.length} SKUs · ${heredadas.length} heredan de categoría</div></div>
      <div class="kpi accent"><div class="kpi-label">Inelásticos · |E|&lt;1</div><div class="kpi-value">${inelastic}</div><div class="kpi-meta">Poder de pricing alto</div></div>
      <div class="kpi"><div class="kpi-label">Unitarios</div><div class="kpi-value">${unitary}</div><div class="kpi-meta">Zona neutral</div></div>
      <div class="kpi"><div class="kpi-label">Elásticos · |E|&gt;1.5</div><div class="kpi-value">${elastic}</div><div class="kpi-meta">Sensibles al precio</div></div>
    `;

    // SCATTER: por default solo elasticidad propia (evita la línea vertical de heredadas)
    const showAll = showInheritedElast;
    const skusForScatter = showAll ? skus : propias;
    destroyChart('elastScatter');
    charts.elastScatter = new Chart(document.getElementById('chartElasticScatter'), {
      type: 'bubble',
      data: { datasets: Object.keys(segColors).map(seg => ({
        label: seg,
        data: skusForScatter.filter(s => s.segmento === seg).map(s => ({
          x: s.elasticidad, y: s.margen*100,
          r: Math.min(20, Math.max(3, Math.sqrt(s.revenue)/15)),
          sku: s
        })),
        backgroundColor: segColors[seg] + 'CC', borderColor: segColors[seg], borderWidth: 1
      })) },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10.5 } } },
          tooltip: { ...tooltipStyle, callbacks: {
            title: c => c[0].raw.sku.nombre + ' · ' + c[0].raw.sku.marca,
            label: c => [`Elast: ${c.raw.x.toFixed(2)} (${c.raw.sku.elastSource})`, `Mg: ${c.raw.y.toFixed(1)}% · Rev: ${fmt.money(c.raw.sku.revenue)}`]
          } } },
        scales: { x: { ...baseScale, title: { display: true, text: 'Elasticidad', color: '#6b6b78' } }, y: { ...baseScale, title: { display: true, text: 'Margen %', color: '#6b6b78' } } }
      }
    });

    destroyChart('elastHist');
    const bins = [-4,-3,-2.5,-2,-1.5,-1,-0.5,0,0.5];
    const histData = new Array(bins.length-1).fill(0);
    // Solo elasticidad propia para el histograma (más informativo)
    const histSource = showAll ? skus : propias;
    histSource.forEach(s => { for (let i=0; i<bins.length-1; i++) { if (s.elasticidad >= bins[i] && s.elasticidad < bins[i+1]) { histData[i]++; break; } } });
    charts.elastHist = new Chart(document.getElementById('chartElasticHist'), {
      type: 'bar',
      data: { labels: bins.slice(0,-1).map((b,i) => `${b}→${bins[i+1]}`),
        datasets: [{ data: histData,
          backgroundColor: bins.slice(0,-1).map(b => Math.abs(b) < 1 ? '#FFD100' : Math.abs(b) < 1.5 ? '#FFA500' : '#FF7B00'),
          borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipStyle },
        scales: { x: { ...baseScale, grid: { display: false } }, y: baseScale }
      }
    });

    // CURVAS: ahora con umbrales relajados, suelen aparecer más SKUs
    const curveSkus = skus.filter(s => DATASET.elastCurves[s.sku]).sort((a,b) => b.revenue - a.revenue).slice(0, 100);
    const sel = document.getElementById('elastSkuSelect');
    const ctx = document.getElementById('chartCurve');
    // Asegurar que existe un placeholder reutilizable
    let placeholder = document.getElementById('curvePlaceholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.id = 'curvePlaceholder';
      placeholder.style.cssText = 'display:none;position:absolute;inset:0;place-items:center;color:var(--text-3);font-size:12.5px;text-align:center;padding:30px;line-height:1.6;background:var(--surface);';
      ctx.parentElement.style.position = 'relative';
      ctx.parentElement.appendChild(placeholder);
    }
    if (curveSkus.length) {
      // Hay curvas → mostrar canvas, esconder placeholder
      ctx.style.display = '';
      placeholder.style.display = 'none';
      sel.innerHTML = curveSkus.map(s => `<option value="${s.sku}">${s.nombre} · ${s.marca} · ${s.sku}</option>`).join('');
      sel.onchange = e => drawCurve(e.target.value);
      drawCurve(curveSkus[0].sku);
    } else {
      // Sin curvas → mostrar placeholder con diagnóstico
      destroyChart('curve');
      const totalSkus = skus.length;
      const conPocasTrans = skus.filter(s => s.transacciones < 3).length;
      sel.innerHTML = '<option>—</option>';
      ctx.style.display = 'none';
      placeholder.style.display = 'grid';
      placeholder.innerHTML = `
        <div>
          <div style="font-size:32px;margin-bottom:12px;opacity:0.4;">📊</div>
          <strong style="color:var(--text-2);">Sin curvas disponibles para el filtro actual</strong><br>
          De ${totalSkus} SKUs activos, ninguno tiene 2+ niveles de precio observados.<br>
          ${conPocasTrans > 0 ? `${conPocasTrans} SKUs tienen menos de 3 transacciones.<br>` : ''}
          <span style="font-size:11px;opacity:0.7;">Tip: amplía la ventana temporal o quita filtros de marca/tienda para ver más curvas.</span>
        </div>`;
    }

    // Listener del toggle "incluir heredadas"
    const inhToggle = document.getElementById('showInheritedToggle');
    if (inhToggle && !inhToggle._wired) {
      inhToggle.checked = showInheritedElast;
      inhToggle.addEventListener('change', e => {
        showInheritedElast = e.target.checked;
        renderElasticity();
      });
      inhToggle._wired = true;
    }
  }

  function drawCurve(skuId) {
    const DATASET = getDatasetForSection('elasticity');
    if (!DATASET) return;
    const data = DATASET.elastCurves[skuId];
    if (!data) return;
    const sku = DATASET.skus.find(s => s.sku == skuId);
    destroyChart('curve');
    const pmin = Math.min(...data.precios), pmax = Math.max(...data.precios);
    const qref = data.cantidades.reduce((a,b)=>a+b,0) / data.cantidades.length;
    const pref = data.precios.reduce((a,b)=>a+b,0) / data.precios.length;
    const fittedPts = [];
    for (let i = 0; i <= 20; i++) { const p = pmin + (pmax-pmin)*i/20; fittedPts.push({x: p, y: qref * Math.pow(p/pref, sku.elasticidad)}); }
    charts.curve = new Chart(document.getElementById('chartCurve'), {
      type: 'scatter',
      data: { datasets: [
        { label: 'Observaciones', data: data.precios.map((p,i) => ({x: p, y: data.cantidades[i]})),
          backgroundColor: '#FFD100DD', borderColor: '#FFD100', borderWidth: 1, pointRadius: 6, pointHoverRadius: 9 },
        { label: `Curva ajustada (E = ${sku.elasticidad.toFixed(2)})`, type: 'line', data: fittedPts,
          borderColor: '#FFA500', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false }
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8 } }, tooltip: tooltipStyle },
        scales: { x: { ...baseScale, title: { display: true, text: 'Precio ($)', color: '#6b6b78' } },
                  y: { ...baseScale, title: { display: true, text: 'Unidades demandadas', color: '#6b6b78' } } }
      }
    });
  }

  // ============ SIMULATOR ============
  function parsePromoSpec(spec) {
    if (!spec || spec === 'none' || spec === '0') {
      return { spec: 'none', discount: 0, label: 'Sin promo' };
    }
    const match = String(spec).trim().toLowerCase().match(/^(\d+)\s*[x×]\s*(\d+)$/);
    if (!match) return null;
    const N = parseInt(match[1]), M = parseInt(match[2]);
    if (!Number.isFinite(N) || !Number.isFinite(M) || N <= 0 || M < 0 || N <= M) return null;
    const discount = (N - M) / N;
    return { spec: `${N}x${M}`, discount, label: `${N}×${M}` };
  }

  function setPromo(spec) {
    const p = parsePromoSpec(spec);
    if (!p) return false;
    currentPromo = p;
    document.querySelectorAll('#simPromoBtns .promo-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.promo === p.spec);
    });
    document.getElementById('simPromoLabel').textContent = p.label;
    const info = document.getElementById('simPromoInfo');
    info.textContent = p.discount > 0
      ? `Descuento equivalente: ${(p.discount*100).toFixed(1)}% · cliente paga ${Math.round((1-p.discount)*100)}% del precio`
      : 'Descuento equivalente: 0%';
    info.classList.toggle('active', p.discount > 0);
    updateSim();
    return true;
  }

  function renderSimulator() {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    const sel = document.getElementById('simSkuSelect');
    sel.innerHTML = DATASET.skus.slice()
      .sort((a,b) => b.revenue - a.revenue)
      .slice(0, Math.min(200, DATASET.skus.length))
      .map(s => `<option value="${s.sku}">${s.nombre} · ${s.marca} · SKU ${s.sku}</option>`).join('');
    sel.onchange = updateSim;
    document.getElementById('simPrice').oninput = updateSim;
    document.querySelectorAll('.quick-btn[data-price]').forEach(b =>
      b.onclick = () => { document.getElementById('simPrice').value = b.dataset.price; updateSim(); });

    // Botones de promo
    document.querySelectorAll('#simPromoBtns .promo-btn').forEach(b => {
      b.onclick = () => setPromo(b.dataset.promo);
    });
    // Promo personalizada (Enter o botón Aplicar)
    const customInput = document.getElementById('simPromoCustom');
    const applyBtn = document.getElementById('simPromoApply');
    const applyCustom = () => {
      const val = customInput.value.trim();
      if (!val) return;
      if (!setPromo(val)) {
        customInput.style.borderColor = 'var(--red)';
        customInput.value = '';
        customInput.placeholder = 'Formato inválido. Usa NxM (ej. 5x3)';
        setTimeout(() => {
          customInput.style.borderColor = '';
          customInput.placeholder = 'Personalizada: ej. 5x3, 7x4';
        }, 2000);
      } else {
        customInput.value = '';
      }
    };
    applyBtn.onclick = applyCustom;
    customInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } };

    // Reset promo al re-renderizar
    currentPromo = { spec: 'none', discount: 0, label: 'Sin promo' };
    setPromo('none');
  }

  function updateSim() {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    const sku = DATASET.skus.find(s => s.sku == document.getElementById('simSkuSelect').value);
    if (!sku) return;
    const dP = parseFloat(document.getElementById('simPrice').value) / 100;
    const promoDiscount = currentPromo.discount;
    document.getElementById('simPriceLabel').textContent = fmt.signed(dP*100);

    const demLabel = { muy_alta: 'muy alta', alta: 'alta', media: 'media', baja: 'baja' }[sku.demanda] || 'media';
    const demColor = { muy_alta: 'var(--green)', alta: 'var(--green)', media: 'var(--text)', baja: 'var(--red)' }[sku.demanda] || 'var(--text)';
    document.getElementById('simProductInfo').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
        <div><div class="label">SKU</div><div class="value">${sku.sku}</div></div>
        <div><div class="label">Marca</div><div class="value" style="font-family:'Manrope',sans-serif">${sku.marca}</div></div>
        <div><div class="label">Precio base</div><div class="value">${fmt.money2(sku.precio)}</div></div>
        <div><div class="label">Costo</div><div class="value">${sku.costo ? fmt.money2(sku.costo) : '—'}</div></div>
        <div><div class="label">Margen actual</div><div class="value">${(sku.margen*100).toFixed(1)}%</div></div>
        <div><div class="label">Elasticidad</div><div class="value">${sku.elasticidad.toFixed(2)}</div></div>
        <div><div class="label">Unidades vendidas</div><div class="value">${fmt.num(sku.unidades)}</div></div>
        <div><div class="label">Nivel de demanda</div><div class="value" style="color:${demColor};font-family:'Manrope',sans-serif">${demLabel}</div></div>
      </div>`;

    // Precio efectivo = ajuste manual + descuento de promo
    const newPrice = sku.precio * (1 + dP) * (1 - promoDiscount);
    const cost = sku.costo || 0;
    const profitUnit = newPrice - cost;
    const margin = newPrice > 0 ? profitUnit / newPrice : 0;
    const totalPriceChange = (1 + dP) * (1 - promoDiscount) - 1;
    const volRatio = Math.pow(1 + totalPriceChange, sku.elasticidad);
    const baseProfit = sku.precio - cost;

    const revDelta = newPrice / sku.precio - 1;
    const profDelta = baseProfit > 0 ? profitUnit / baseProfit - 1 : 0;
    const marDelta = margin - sku.margen;
    const volDelta = volRatio - 1;

    const setDelta = (id, val) => {
      const el = document.getElementById(id);
      el.textContent = fmt.signed(val*100);
      el.className = 'value-delta ' + (val > 0.005 ? 'delta-up' : val < -0.005 ? 'delta-down' : 'delta-flat');
    };
    document.getElementById('simRev').textContent = fmt.money2(newPrice);
    document.getElementById('simProfit').textContent = fmt.money2(profitUnit);
    document.getElementById('simMargin').textContent = (margin*100).toFixed(1) + '%';
    document.getElementById('simVol').textContent = (volRatio*100).toFixed(0);
    setDelta('simRevDelta', revDelta); setDelta('simProfitDelta', profDelta); setDelta('simMarginDelta', marDelta); setDelta('simVolDelta', volDelta);

    // Profit total considerando volumen Y nivel de demanda
    const totalProfitImpact = profitUnit * volRatio - baseProfit;
    // Multiplicador de impacto absoluto en P&L según demanda
    const demImpact = { muy_alta: 'muy alto', alta: 'alto', media: 'medio', baja: 'bajo' }[sku.demanda] || 'medio';
    let reco;
    if (baseProfit <= 0) reco = `<span style="color:var(--text-2);font-weight:600;">○ Sin costo válido.</span> No es posible calcular impacto en utilidad.`;
    else if (totalProfitImpact > baseProfit * 0.05) reco = `<span style="color:var(--green);font-weight:600;">✓ Escenario favorable.</span> Impacto unitario: ${fmt.signed((totalProfitImpact/baseProfit)*100)}. Producto de demanda <strong style="color:${demColor}">${demLabel}</strong> → impacto absoluto en P&L: <strong>${demImpact}</strong>. La elasticidad (${sku.elasticidad.toFixed(2)}) absorbe el cambio sin destruir volumen.`;
    else if (totalProfitImpact < -baseProfit * 0.05) reco = `<span style="color:var(--red);font-weight:600;">✗ Escenario desfavorable.</span> Impacto unitario: ${fmt.signed((totalProfitImpact/baseProfit)*100)}. ${sku.demanda === 'muy_alta' || sku.demanda === 'alta' ? '<strong>Demanda alta amplifica la pérdida.</strong>' : 'En demanda ' + demLabel + ', el daño es limitado pero real.'} El descuento erosiona más utilidad de la que el volumen incremental puede compensar.`;
    else reco = `<span style="color:var(--text-2);font-weight:600;">○ Escenario neutro.</span> Cambio marginal (demanda ${demLabel}). Considera otras palancas (cost-down, mix, otro tipo de promo).`;
    document.getElementById('simReco').innerHTML = reco;

    // ===== CURVA DEL SIMULADOR =====
    destroyChart('sim');
    const pts = [];
    const promoFactor = 1 - promoDiscount;
    for (let i = -30; i <= 30; i += 2) {
      const dp = i/100;
      const np = sku.precio * (1 + dp) * promoFactor;
      const vr = Math.pow((1 + dp) * promoFactor, sku.elasticidad);
      pts.push({ x: i, rev: np * vr, prof: (np - cost) * vr });
    }
    const currentVol = Math.pow((1 + dP) * promoFactor, sku.elasticidad);
    const currentRev = newPrice * currentVol;
    const currentProf = (newPrice - cost) * currentVol;

    charts.sim = new Chart(document.getElementById('chartSim'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Revenue × volumen', data: pts.map(p => ({x: p.x, y: p.rev})), borderColor: '#FFD100', borderWidth: 2, tension: 0.3, pointRadius: 0, fill: false },
          { label: 'Utilidad × volumen', data: pts.map(p => ({x: p.x, y: p.prof})), borderColor: '#00d68f', borderWidth: 2, tension: 0.3, pointRadius: 0, fill: false },
          { label: `Escenario actual${promoDiscount > 0 ? ' (con ' + currentPromo.label + ')' : ''}`, type: 'scatter',
            data: [{x: dP*100, y: currentRev}, {x: dP*100, y: currentProf}],
            backgroundColor: '#ff4d6d', borderColor: '#fff', borderWidth: 2,
            pointRadius: 8, pointHoverRadius: 10, showLine: false }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, parsing: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10.5 } } },
          tooltip: { ...tooltipStyle, callbacks: { label: c => c.dataset.label + ': ' + fmt.money2(c.parsed.y), title: c => 'Δ precio: ' + fmt.signed(c[0].parsed.x) } } },
        scales: {
          x: { ...baseScale, type: 'linear', title: { display: true, text: 'Cambio de precio (%)', color: '#6b6b78' }, ticks: { ...baseScale.ticks, callback: v => v + '%' } },
          y: { ...baseScale, ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } }
        }
      }
    });
  }

  // ============ SEGMENTATION ============
  function renderSegmentation() {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    const segs = ['Hero Product','Traffic Driver','Premium Product','Margin Killer','Sensitive Product','Standard'];
    document.getElementById('segGrid').innerHTML = segs.map(s => {
      const items = DATASET.skus.filter(x => x.segmento === s);
      const rev = items.reduce((a,b) => a + b.revenue, 0);
      return `<div class="seg-card ${segClass[s]}">
        <div class="seg-icon">${segDefs[s].icon}</div>
        <div class="seg-name">${s}</div>
        <div class="seg-count">${items.length}</div>
        <div class="seg-desc">${segDefs[s].desc}</div>
        <div class="seg-meta"><span>Revenue</span><span class="mono">${fmt.money(rev)}</span></div>
      </div>`;
    }).join('');

    destroyChart('seg');
    charts.seg = new Chart(document.getElementById('chartSegmento'), {
      type: 'bar',
      data: { labels: segs,
        datasets: [
          { label: 'Revenue', data: segs.map(s => DATASET.skus.filter(x => x.segmento === s).reduce((a,b)=>a+b.revenue, 0)), backgroundColor: segs.map(s => segColors[s]), borderRadius: 4, yAxisID: 'y' },
          { label: '# SKUs', data: segs.map(s => DATASET.skus.filter(x => x.segmento === s).length), backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 4, yAxisID: 'y1' }
        ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8 } }, tooltip: tooltipStyle },
        scales: { x: { ...baseScale, grid: { display: false } },
                  y: { ...baseScale, position: 'left', ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } },
                  y1: { ...baseScale, position: 'right', grid: { display: false } } }
      }
    });
  }

  // ============ RECOMMENDATIONS ============
  function renderRecommendations() {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    let filtered;
    if (recFilter === 'all') filtered = DATASET.skus.filter(s => s.accion !== 'MANTENER');
    else if (recFilter === 'PROMO') filtered = DATASET.skus.filter(s => s.accion.startsWith('PROMO') || s.accion === 'BUNDLE');
    else filtered = DATASET.skus.filter(s => s.accion === recFilter);
    const sorted = filtered.sort((a,b) => b.revenue - a.revenue).slice(0, 80);
    document.getElementById('recsList').innerHTML = sorted.length ? sorted.map(s => `
      <div class="rec-row">
        <div class="rec-sku">SKU<br>${s.sku}</div>
        <div class="rec-info">
          <div class="name">${s.nombre} <span style="color: var(--text-3); font-weight: 500;">· ${s.marca}</span></div>
          <div class="meta">Precio ${fmt.money2(s.precio)} · Mg ${(s.margen*100).toFixed(1)}% · E ${s.elasticidad.toFixed(2)} · Conf. ${s.confianza} · <span class="pill pill-gray" style="font-size:9.5px">${s.segmento}</span></div>
          <div class="rec-reason">${s.razon}</div>
        </div>
        <div style="text-align: center;">
          <span class="pill ${actionPill[s.accion] || 'pill-gray'}">${actionArrow[s.accion] || '•'} ${s.accion}</span>
          ${s.accion_pct !== 0 ? `<div class="mono" style="font-size: 14px; font-weight: 600; margin-top: 6px; color: ${s.accion_pct > 0 ? 'var(--green)':'var(--red)'};">${s.accion_pct > 0?'+':''}${s.accion_pct}%</div>` : ''}
        </div>
        <div class="rec-impact" style="text-align: right;">
          <div style="font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 2px;">Revenue</div>
          ${fmt.money(s.revenue)}
        </div>
      </div>
    `).join('') : '<div style="padding:32px;text-align:center;color:var(--text-3);">Sin recomendaciones para este filtro</div>';

    document.querySelectorAll('[data-filter]').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('primary'));
        b.classList.add('primary');
        recFilter = b.dataset.filter;
        renderRecommendations();
      };
    });
  }

  function renderInsights() {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    document.getElementById('insightsList').innerHTML = DATASET.insights.map(i => `
      <div class="insight ${i.tipo}">
        <div class="insight-icon">${insightIcons[i.tipo] || '•'}</div>
        <div class="insight-body">
          <div class="insight-titulo">${i.titulo}</div>
          <div class="insight-desc">${i.descripcion}</div>
        </div>
        <div class="insight-valor">${i.valor}</div>
      </div>
    `).join('');
  }

  function renderAnomalies() {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    document.getElementById('anomList').innerHTML = DATASET.anomalias.map(a => `
      <div class="anomaly ${a.tipo === 'warning' ? 'warning' : a.tipo === 'info' ? 'info' : ''}">
        <div class="anomaly-icon" style="color: ${a.tipo === 'critico' ? 'var(--red)' : a.tipo === 'warning' ? 'var(--yellow)' : 'var(--blue)'};">${a.tipo === 'critico' || a.tipo === 'warning' ? '⚠' : 'ⓘ'}</div>
        <div class="anomaly-body">
          <div class="anomaly-title">${a.mensaje}</div>
          <div class="anomaly-meta">SKU ${a.sku} · ${a.marca}</div>
        </div>
        <span class="pill ${a.tipo === 'critico' ? 'pill-red' : a.tipo === 'warning' ? 'pill-yellow' : 'pill-blue'}">${a.tipo.toUpperCase()}</span>
      </div>
    `).join('');
  }

  function renderSkuTable(filter = '') {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    const f = filter.toLowerCase();
    const filtered = DATASET.skus.filter(s =>
      !f || String(s.nombre).toLowerCase().includes(f) || String(s.marca).toLowerCase().includes(f) || String(s.sku).includes(f) || String(s.segmento).toLowerCase().includes(f)
    ).sort((a,b) => b.revenue - a.revenue);
    document.getElementById('skuCount').textContent = `${filtered.length} de ${DATASET.skus.length} SKUs`;
    document.getElementById('skuTable').innerHTML = `
      <thead><tr>
        <th>SKU</th><th>Producto</th><th>Marca</th><th style="text-align:right">Precio</th>
        <th style="text-align:right">Costo</th><th style="text-align:right">Mg%</th><th style="text-align:right">Revenue</th>
        <th style="text-align:right">Unid.</th><th style="text-align:right">Elast.</th><th>Conf.</th><th>Segmento</th><th>Acción</th>
      </tr></thead>
      <tbody>${filtered.slice(0, 300).map(s => `
        <tr>
          <td class="num">${s.sku}</td>
          <td class="strong" style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.nombre}</td>
          <td>${s.marca}</td>
          <td class="num" style="text-align:right">${fmt.money2(s.precio)}</td>
          <td class="num" style="text-align:right">${s.costo ? fmt.money2(s.costo) : '—'}</td>
          <td class="num" style="text-align:right; color: ${s.margen < 0.1 ? 'var(--red)' : s.margen > 0.3 ? 'var(--green)' : 'var(--text)'};">${(s.margen*100).toFixed(1)}%</td>
          <td class="num" style="text-align:right">${fmt.money(s.revenue)}</td>
          <td class="num" style="text-align:right">${s.unidades}</td>
          <td class="num" style="text-align:right">${s.elasticidad.toFixed(2)}</td>
          <td><span class="pill ${s.confianza === 'Alta' ? 'pill-green' : s.confianza === 'Media' ? 'pill-yellow' : 'pill-gray'}">${s.confianza}</span></td>
          <td><span class="pill ${segClass[s.segmento] === 'hero' ? 'pill-yellow' : segClass[s.segmento] === 'traffic' ? 'pill-blue' : segClass[s.segmento] === 'premium' ? 'pill-purple' : segClass[s.segmento] === 'killer' ? 'pill-red' : 'pill-gray'}">${s.segmento}</span></td>
          <td><span class="pill ${actionPill[s.accion] || 'pill-gray'}">${actionArrow[s.accion] || '•'} ${(s.accion || '').split(' ')[0]}</span></td>
        </tr>
      `).join('')}</tbody>
    `;
  }

  function renderExecutive() {
    const DATASET = DATASET_BASE;
    if (!DATASET) return;
    const k = DATASET.kpis;
    const opp = DATASET.skus.filter(s => s.accion === 'SUBIR PRECIO');
    const oppRev = opp.reduce((a,s) => a + s.revenue * (s.accion_pct/100), 0);
    document.getElementById('execSubtitle').textContent = `Análisis de ${DATASET.meta.skusTotales} SKUs sobre ${fmt.num(DATASET.meta.filasTotales)} transacciones. Decisiones priorizadas con impacto cuantificado.`;
    document.getElementById('execStats').innerHTML = `
      <div class="exec-stat"><div class="exec-stat-value" style="color: var(--yellow);">${fmt.money(k.revenue_total)}</div><div class="exec-stat-label">Revenue analizado</div></div>
      <div class="exec-stat"><div class="exec-stat-value" style="color: var(--green);">+${fmt.money(Math.abs(oppRev))}</div><div class="exec-stat-label">Oportunidad estimada</div></div>
      <div class="exec-stat"><div class="exec-stat-value">${opp.length}</div><div class="exec-stat-label">SKUs para acción</div></div>
      <div class="exec-stat"><div class="exec-stat-value" style="color: var(--red);">${DATASET.skus.filter(s => s.margen < 0.1).length}</div><div class="exec-stat-label">Margen crítico</div></div>
    `;
    const top = opp.sort((a,b) => b.revenue - a.revenue).slice(0, 5);
    document.getElementById('execActions').innerHTML = top.length ? top.map(s => `
      <div style="background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; gap: 14px; align-items: center;">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--yellow-dim);color:var(--yellow);display:grid;place-items:center;font-size:18px;font-weight:700;">↑</div>
        <div style="flex: 1;">
          <div style="font-size: 13.5px; font-weight: 600;">${s.nombre} · ${s.marca}</div>
          <div style="font-size: 11.5px; color: var(--text-3); margin-top: 2px;">SKU ${s.sku} · ${fmt.money2(s.precio)} → ${fmt.money2(s.precio*(1+s.accion_pct/100))}</div>
        </div>
        <div style="text-align: right;">
          <div class="mono" style="font-size: 14px; font-weight: 600; color: var(--green);">+${s.accion_pct}%</div>
          <div style="font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;">Precio</div>
        </div>
      </div>
    `).join('') : '<div style="padding:20px;color:var(--text-3);text-align:center;">Sin acciones prioritarias detectadas</div>';

    const counts = {};
    DATASET.skus.forEach(s => counts[s.accion] = (counts[s.accion]||0) + 1);
    destroyChart('exec');
    charts.exec = new Chart(document.getElementById('chartExec'), {
      type: 'doughnut',
      data: { labels: Object.keys(counts),
        datasets: [{ data: Object.values(counts),
          backgroundColor: Object.keys(counts).map(a => {
            if (a === 'SUBIR PRECIO') return '#00d68f';
            if (a === 'BAJAR PRECIO') return '#4d9fff';
            if (a.startsWith('PROMO')) return '#b388ff';
            if (a === 'BUNDLE' || a === 'CROSS-SELL') return '#4d9fff';
            if (a === 'EVITAR PROMO') return '#FFD100';
            if (a === 'REVISAR COSTO') return '#ff4d6d';
            return '#6b6b78';
          }),
          borderColor: '#0d0d10', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 8, font: { size: 10.5 } } }, tooltip: tooltipStyle } }
    });
  }

  // ============ FILE PARSING ============
  function parseFile(file) {
    resetState();  // ¡FIX! Limpia estado y charts antes de cargar nuevo archivo
    const status = document.getElementById('uploadStatus');
    status.innerHTML = `<div style="display:flex;align-items:center;gap:10px;color:var(--text-2);font-size:13px;"><span class="spinner"></span> Procesando ${file.name}...</div>`;

    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === 'csv' || ext === 'tsv') {
      Papa.parse(file, {
        header: true, dynamicTyping: false, skipEmptyLines: true,
        complete: results => handleParsed(results.data, file, results.errors),
        error: err => showError(err.message)
      });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          handleParsed(data, file, []);
        } catch (err) { showError('Error al leer Excel: ' + err.message); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      showError('Formato no soportado. Usa CSV, TSV, XLSX o XLS.');
    }
  }

  function showError(msg) {
    document.getElementById('uploadStatus').innerHTML = `<div class="upload-error"><strong>Error:</strong> ${msg}</div>`;
  }

  // ============ RESET STATE (¡fix re-upload!) ============
  function resetState() {
    RAW = null;
    MAPPING = null;
    DATASET_BASE = null;
    DATASET_OPTIONS = null;
    recFilter = 'all';
    showInheritedElast = false;
    SECTION_FILTERS.dashboard = DEFAULT_FILTERS();
    SECTION_FILTERS.predictive = DEFAULT_FILTERS();
    SECTION_FILTERS.elasticity = DEFAULT_FILTERS();
    currentPromo = { spec: 'none', discount: 0, label: 'Sin promo' };
    destroyAllCharts();
    // Re-bloquear todas las vistas excepto upload
    document.querySelectorAll('.nav-item').forEach(n => {
      if (n.dataset.view && n.dataset.view !== 'upload') {
        n.classList.add('locked');
        n.classList.remove('unlocked');
      }
    });
    // Reset topbar
    const wrap = document.getElementById('globalSearchWrap');
    if (wrap) wrap.style.display = 'none';
    const badge = document.getElementById('liveBadge');
    if (badge) { badge.className = 'badge badge-idle'; badge.textContent = 'SIN DATOS'; }
    const meta = document.getElementById('meta-info');
    if (meta) meta.textContent = 'Esperando archivo';
    // Reset UI cards
    const valCard = document.getElementById('validationCard');
    if (valCard) valCard.style.display = 'none';
    const helper = document.getElementById('emptyHelper');
    if (helper) helper.style.display = '';
    // Reset filter UI (todas las barras)
    document.querySelectorAll('[data-filter-type="window"] .filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.window === 'all');
    });
    document.querySelectorAll('input[data-filter-type="decay"]').forEach(el => el.checked = false);
    document.querySelectorAll('select[data-filter-type="category"]').forEach(sel => {
      sel.innerHTML = '<option value="all">Todas</option>'; sel.value = 'all'; sel.classList.remove('has-value');
    });
    document.querySelectorAll('select[data-filter-type="brand"]').forEach(sel => {
      sel.innerHTML = '<option value="all">Todas</option>'; sel.value = 'all'; sel.classList.remove('has-value');
    });
    document.querySelectorAll('select[data-filter-type="store"]').forEach(sel => {
      sel.innerHTML = '<option value="all">Todas</option>'; sel.value = 'all'; sel.classList.remove('has-value');
    });
    const inhToggle = document.getElementById('showInheritedToggle');
    if (inhToggle) inhToggle.checked = false;
    // Make sure we're on upload view
    if (!document.getElementById('view-upload').classList.contains('active')) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-upload').classList.add('active');
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      const uploadNav = document.querySelector('[data-view="upload"]');
      if (uploadNav) uploadNav.classList.add('active');
      const crumb = document.getElementById('crumb');
      if (crumb) crumb.textContent = 'Upload & Mapping';
    }
  }

  function handleParsed(data, file, errors) {
    if (!data || !data.length) { showError('Archivo vacío o sin filas válidas.'); return; }
    RAW = data;
    const headers = Object.keys(data[0]);
    MAPPING = detectColumns(headers);

    document.getElementById('uploadStatus').innerHTML = `
      <div class="upload-success">
        <div class="check">✓</div>
        <div><strong>${file.name}</strong><span>${data.length.toLocaleString()} filas · ${headers.length} columnas · ${(file.size/1024).toFixed(1)} KB</span></div>
      </div>`;

    const card = document.getElementById('validationCard');
    card.style.display = '';
    document.getElementById('emptyHelper').style.display = 'none';

    const requiredFields = ['sku', 'precio', 'qty'];
    const missing = requiredFields.filter(f => !MAPPING[f]);
    const validations = [];
    validations.push({ ok: true, msg: `${data.length.toLocaleString()} filas leídas correctamente`, detail: errors.length ? `${errors.length} warnings menores` : 'Sin errores de parsing' });
    validations.push({ ok: missing.length === 0, msg: missing.length === 0 ? 'Columnas obligatorias detectadas' : `Faltan columnas: ${missing.join(', ')}`, detail: 'SKU · Precio · Cantidad son obligatorios' });
    validations.push({ ok: !!MAPPING.costo, msg: MAPPING.costo ? 'Columna de costo detectada' : 'Sin columna de costo', detail: MAPPING.costo ? 'Permitirá cálculo preciso de margen' : 'Se calculará margen si existe (parcial)' });
    validations.push({ ok: true, msg: `${headers.length} columnas detectadas`, detail: 'Tipos inferidos automáticamente' });
    if (MAPPING.fecha || (MAPPING.año && MAPPING.mes)) validations.push({ ok: true, msg: 'Columnas temporales detectadas', detail: 'Análisis de tendencia disponible' });

    document.getElementById('validationList').innerHTML = validations.map(v => `
      <div style="display: flex; align-items: center; gap: 10px; padding: 8px 0;">
        <div style="width: 24px; height: 24px; border-radius: 50%; background: ${v.ok ? 'var(--green-dim)' : 'var(--red-dim)'}; color: ${v.ok ? 'var(--green)':'var(--red)'}; display: grid; place-items: center; font-weight: 700; font-size: 12px;">${v.ok ? '✓' : '×'}</div>
        <div style="flex: 1;"><div style="font-size: 13px; color: var(--text);">${v.msg}</div><div style="font-size: 11.5px; color: var(--text-3); margin-top: 1px;">${v.detail}</div></div>
      </div>`).join('');

    const fields = [
      { key: 'sku', label: 'SKU / Código de producto', required: true },
      { key: 'precio', label: 'Precio unitario', required: true },
      { key: 'qty', label: 'Cantidad vendida', required: true },
      { key: 'costo', label: 'Costo unitario' },
      { key: 'revenue', label: 'Revenue / Ventas' },
      { key: 'margen', label: 'Margen' },
      { key: 'utilidad', label: 'Utilidad / Profit' },
      { key: 'nombre', label: 'Nombre del producto' },
      { key: 'categoria', label: 'Categoría' },
      { key: 'marca', label: 'Marca' },
      { key: 'tienda', label: 'Tienda / Canal' },
      { key: 'proveedor', label: 'Proveedor' },
      { key: 'fecha', label: 'Fecha' },
      { key: 'año', label: 'Año' },
      { key: 'mes', label: 'Mes' },
    ];
    document.getElementById('mappingGrid').innerHTML = fields.map(f => `
      <div class="mapping-grid">
        <div class="map-detected">${MAPPING[f.key] || '<i style="color:var(--text-3)">no detectada</i>'}</div>
        <div class="map-arrow">→</div>
        <div class="map-mapped ${!MAPPING[f.key] && f.required ? 'missing' : ''}">${f.label}${f.required ? ' <span style="color:var(--yellow);font-size:10px;">obligatorio</span>' : ''}</div>
      </div>`).join('');

    document.getElementById('mappingSubtitle').textContent = `${Object.keys(MAPPING).length} de ${fields.length} campos mapeados automáticamente`;

    if (missing.length === 0) {
      document.getElementById('processBtn').style.display = '';
      document.getElementById('processBtn').onclick = processAndUnlock;
    } else {
      document.getElementById('processBtn').style.display = 'none';
    }
  }

  function processAndUnlock() {
    document.getElementById('processBtn').innerHTML = '<span class="spinner"></span> Procesando...';
    setTimeout(() => {
      try {
        // Build DATASET_OPTIONS desde TODOS los datos crudos
        const m = MAPPING;
        const allCats = new Set(), allMarcas = new Set(), allTiendas = new Set();
        for (const r of RAW) {
          if (m.categoria && r[m.categoria]) allCats.add(r[m.categoria]);
          if (m.marca && r[m.marca]) allMarcas.add(r[m.marca]);
          if (m.tienda && r[m.tienda]) allTiendas.add(r[m.tienda]);
        }
        DATASET_OPTIONS = {
          categorias: [...allCats].sort(),
          marcas: [...allMarcas].sort(),
          tiendas: [...allTiendas].sort(),
        };
        populateFilterSelects();

        // Resetear filtros por sección
        SECTION_FILTERS.dashboard = DEFAULT_FILTERS();
        SECTION_FILTERS.predictive = DEFAULT_FILTERS();
        SECTION_FILTERS.elasticity = DEFAULT_FILTERS();

        // Procesar BASE (sin filtros) y cachear
        DATASET_BASE = processData(DEFAULT_FILTERS());
        if (!DATASET_BASE || !DATASET_BASE.skus.length) {
          showError('No se pudieron procesar registros válidos. Verifica que precio y cantidad sean numéricos > 0.');
          return;
        }
        renderAll();
        unlockAll();
        document.querySelector('[data-view="dashboard"]').click();
      } catch (e) {
        showError('Error en procesamiento: ' + e.message);
        console.error(e);
      }
      document.getElementById('processBtn').innerHTML = '<span>Procesar y generar análisis</span><span style="margin-left:6px;">→</span>';
    }, 100);
  }

  function unlockAll() {
    document.querySelectorAll('.nav-item.locked').forEach(n => { n.classList.remove('locked'); n.classList.add('unlocked'); });
    document.getElementById('globalSearchWrap').style.display = '';
    const badge = document.getElementById('liveBadge');
    badge.className = 'badge badge-live';
    badge.textContent = 'LIVE · datos cargados';
    document.getElementById('meta-info').textContent =
      `${DATASET_BASE.meta.filasTotales.toLocaleString()} filas · ${DATASET_BASE.meta.skusTotales} SKUs · ${DATASET_BASE.meta.periodo}`;
  }

  // ============ RE-PROCESS (per sección) ============
  function reprocess(section) {
    if (!RAW || !MAPPING || !DATASET_BASE) return;
    // Status indicator
    const bar = document.querySelector(`[data-filter-bar][data-section="${section}"]`);
    if (bar) {
      const statusEl = bar.querySelector('[data-filter-type="status"]');
      if (statusEl) statusEl.textContent = 'recalculando…';
    }
    setTimeout(() => {
      try {
        // Re-renderizar SOLO la sección afectada
        renderSection(section);
      } catch (e) {
        console.error('Error reprocesando', section, ':', e);
        const msg = (e.message || String(e)).substring(0, 80);
        if (bar) {
          const statusEl = bar.querySelector('[data-filter-type="status"]');
          if (statusEl) statusEl.textContent = 'error: ' + msg;
        }
      }
    }, 30);
  }

  function renderSection(section) {
    if (section === 'dashboard') renderDescriptive();
    else if (section === 'predictive') renderPredictive();
    else if (section === 'elasticity') renderElasticity();
  }

  function showSectionEmpty(viewId, section) {
    const bar = document.querySelector(`[data-filter-bar][data-section="${section}"]`);
    if (bar) {
      const statusEl = bar.querySelector('[data-filter-type="status"]');
      if (statusEl) statusEl.textContent = '⚠ sin datos para este filtro';
    }
  }

  // ============ FILTERS UI ============
  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

  function populateFilterSelects() {
    if (!DATASET_OPTIONS) return;
    document.querySelectorAll('select[data-filter-type="category"]').forEach(sel => {
      const cur = sel.value || 'all';
      sel.innerHTML = '<option value="all">Todas</option>' +
        DATASET_OPTIONS.categorias.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
      sel.value = cur;
    });
    document.querySelectorAll('select[data-filter-type="brand"]').forEach(sel => {
      const cur = sel.value || 'all';
      sel.innerHTML = '<option value="all">Todas</option>' +
        DATASET_OPTIONS.marcas.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
      sel.value = cur;
    });
    document.querySelectorAll('select[data-filter-type="store"]').forEach(sel => {
      const cur = sel.value || 'all';
      sel.innerHTML = '<option value="all">Todas</option>' +
        DATASET_OPTIONS.tiendas.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
      sel.value = cur;
    });
  }

  // Sincroniza UI de UNA barra específica con el state de su sección
  function syncFilterBarForSection(section) {
    const bar = document.querySelector(`[data-filter-bar][data-section="${section}"]`);
    if (!bar) return;
    const f = SECTION_FILTERS[section];
    if (!f) return;
    bar.querySelectorAll('[data-filter-type="window"] .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.window === String(f.window));
    });
    const catSel = bar.querySelector('select[data-filter-type="category"]');
    if (catSel) { catSel.value = f.category; catSel.classList.toggle('has-value', f.category !== 'all'); }
    const brSel = bar.querySelector('select[data-filter-type="brand"]');
    if (brSel) { brSel.value = f.brand; brSel.classList.toggle('has-value', f.brand !== 'all'); }
    const stSel = bar.querySelector('select[data-filter-type="store"]');
    if (stSel) { stSel.value = f.store; stSel.classList.toggle('has-value', f.store !== 'all'); }
    const decay = bar.querySelector('input[data-filter-type="decay"]');
    if (decay) decay.checked = f.decay;
    // Status text
    const ds = getDatasetForSection(section);
    const statusEl = bar.querySelector('[data-filter-type="status"]');
    if (statusEl && ds) {
      const parts = [];
      if (f.window !== 'all') parts.push(`${f.window}m`);
      if (f.category !== 'all') parts.push('cat: ' + f.category.substring(0,12));
      if (f.brand !== 'all') parts.push('marca: ' + f.brand.substring(0,12));
      if (f.store !== 'all') parts.push('tienda: ' + String(f.store).substring(0,12));
      if (f.decay) parts.push('decay');
      parts.push(`${fmt.num(ds.meta.filasTotales)} filas · ${ds.meta.skusTotales} SKUs`);
      statusEl.textContent = parts.join(' · ');
    }
    // Reset button visibility (más prominente cuando hay filtros activos)
    const resetBtn = bar.querySelector('[data-filter-action="reset"]');
    if (resetBtn) resetBtn.style.opacity = isDefaultFilters(f) ? '0.5' : '1';
  }

  function attachFilterListeners() {
    document.querySelectorAll('[data-filter-bar]').forEach(bar => {
      const section = bar.dataset.section;
      if (!section || !SECTION_FILTERS[section]) return;
      // Ventana temporal
      bar.querySelectorAll('[data-filter-type="window"] .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!DATASET_BASE) return;
          SECTION_FILTERS[section].window = btn.dataset.window;
          reprocess(section);
        });
      });
      // Selectores
      const catSel = bar.querySelector('select[data-filter-type="category"]');
      if (catSel) catSel.addEventListener('change', e => { if (!DATASET_BASE) return; SECTION_FILTERS[section].category = e.target.value; reprocess(section); });
      const brSel = bar.querySelector('select[data-filter-type="brand"]');
      if (brSel) brSel.addEventListener('change', e => { if (!DATASET_BASE) return; SECTION_FILTERS[section].brand = e.target.value; reprocess(section); });
      const stSel = bar.querySelector('select[data-filter-type="store"]');
      if (stSel) stSel.addEventListener('change', e => { if (!DATASET_BASE) return; SECTION_FILTERS[section].store = e.target.value; reprocess(section); });
      const decay = bar.querySelector('input[data-filter-type="decay"]');
      if (decay) decay.addEventListener('change', e => { if (!DATASET_BASE) return; SECTION_FILTERS[section].decay = e.target.checked; reprocess(section); });
      // Botón reset
      const resetBtn = bar.querySelector('[data-filter-action="reset"]');
      if (resetBtn) resetBtn.addEventListener('click', () => {
        if (!DATASET_BASE) return;
        SECTION_FILTERS[section] = DEFAULT_FILTERS();
        reprocess(section);
      });
    });
  }

  // ============ SIDEBAR TOGGLE ============
  function setupSidebarToggle() {
    const btn = document.getElementById('sidebarToggle');
    const app = document.querySelector('.app');
    if (!btn || !app) return;
    btn.addEventListener('click', () => {
      app.classList.toggle('sidebar-collapsed');
      // Re-dimensionar todos los charts después de la transición CSS
      setTimeout(() => {
        Object.values(charts).forEach(c => { try { c && c.resize(); } catch(e){} });
      }, 280);
    });
  }

  // ============ NAVIGATION ============
  function setupNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.classList.contains('locked')) return;
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        const view = item.dataset.view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + view).classList.add('active');
        const labelEl = item.querySelector('.nav-label');
        document.getElementById('crumb').textContent = labelEl ? labelEl.textContent.trim() : (item.dataset.tooltip || '');
        window.scrollTo(0, 0);
        // Re-resize charts en la vista activa (importante después de cambiar de vista mientras estaba colapsada)
        setTimeout(() => {
          Object.values(charts).forEach(c => { try { c && c.resize(); } catch(e){} });
        }, 50);
      });
    });

    document.getElementById('skuSearch').addEventListener('input', e => renderSkuTable(e.target.value));
    document.getElementById('globalSearch').addEventListener('input', e => {
      if (e.target.value.length > 1 && DATASET_BASE) {
        document.querySelector('[data-view="skus"]').click();
        document.getElementById('skuSearch').value = e.target.value;
        renderSkuTable(e.target.value);
      }
    });

    attachFilterListeners();
    setupSidebarToggle();
  }

  // ============ UPLOAD HANDLERS ============
  function setupUpload() {
    const input = document.getElementById('fileInput');
    const zone = document.getElementById('uploadZone');
    input.addEventListener('change', e => {
      if (e.target.files[0]) parseFile(e.target.files[0]);
      e.target.value = '';  // ¡FIX! Permite re-seleccionar el mismo archivo
    });
    zone.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') input.click(); });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) parseFile(e.dataTransfer.files[0]);
    });
  }

  // ============ EXPORT ============
  function exportData(type) {
    if (!DATASET) { alert('Carga un archivo primero'); return; }
    let content, fname, mime;
    if (type === 'csv') {
      const header = ['sku','nombre','marca','categoria','precio','costo','margen','revenue','unidades','elasticidad','confianza','segmento','accion','accion_pct','razon'].join(',');
      const rows = DATASET.skus.map(s => [s.sku, '"'+(s.nombre||'').replace(/"/g,"'")+'"', '"'+(s.marca||'').replace(/"/g,"'")+'"', '"'+(s.categoria||'').replace(/"/g,"'")+'"', s.precio, s.costo, s.margen, s.revenue, s.unidades, s.elasticidad, s.confianza, '"'+s.segmento+'"', '"'+s.accion+'"', s.accion_pct, '"'+s.razon.replace(/"/g,"'")+'"'].join(','));
      content = header + '\n' + rows.join('\n');
      fname = 'pricing_intelligence_skus.csv'; mime = 'text/csv';
    } else if (type === 'json') {
      content = JSON.stringify(DATASET, null, 2);
      fname = 'pricing_intelligence_full.json'; mime = 'application/json';
    } else {
      const k = DATASET.kpis;
      const lines = [
        'EXECUTIVE SUMMARY · PRICING INTELLIGENCE PLATFORM',
        '='.repeat(60), '',
        `SKUs analizados: ${DATASET.meta.skusTotales}`,
        `Transacciones: ${DATASET.meta.filasTotales.toLocaleString()}`,
        `Periodo: ${DATASET.meta.periodo}`, '',
        'KPIs PRINCIPALES', '-'.repeat(40),
        `Revenue total: ${fmt.money2(k.revenue_total)}`,
        `Utilidad total: ${fmt.money2(k.utilidad_total)}`,
        `Margen promedio: ${(k.margen_avg*100).toFixed(2)}%`,
        `Unidades: ${k.unidades.toLocaleString()}`, '',
        'INSIGHTS EJECUTIVOS', '-'.repeat(40),
        ...DATASET.insights.map(i => `• ${i.titulo}\n  ${i.descripcion}\n  Valor: ${i.valor}`), '',
        'TOP 10 RECOMENDACIONES', '-'.repeat(40),
        ...DATASET.skus.filter(s => s.accion !== 'MANTENER').sort((a,b)=>b.revenue-a.revenue).slice(0,10).map((s,i) =>
          `${i+1}. ${s.nombre} · ${s.marca}\n   Acción: ${s.accion} (${s.accion_pct >= 0 ? '+' : ''}${s.accion_pct}%) · Revenue ${fmt.money(s.revenue)}\n   ${s.razon}`
        )
      ];
      content = lines.join('\n');
      fname = 'executive_summary.txt'; mime = 'text/plain';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
  }

  // ============ INIT ============
  function init() {
    setupNav();
    setupUpload();
  }

  return { init, exportData };
})();

document.addEventListener('DOMContentLoaded', App.init);
