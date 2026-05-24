# Pricing Intelligence Platform

> Plataforma de analítica de precios y elasticidad para retail. Sube un CSV o Excel con datos transaccionales y obtén elasticidad-precio, segmentación de productos, recomendaciones de IA, insights ejecutivos y simulador what-if — todo procesado en tu navegador.

![status](https://img.shields.io/badge/status-stable-success)
![license](https://img.shields.io/badge/license-MIT-blue)
![tech](https://img.shields.io/badge/tech-vanilla_JS-yellow)

## Características

- **100% client-side** — Tus datos nunca salen de tu computadora. Sin servidor, sin base de datos, sin cookies.
- **Mapeo inteligente de columnas** — Detección automática de SKU, precio, costo, cantidad, marca, categoría, fecha, tienda, etc. en español e inglés.
- **Motor de elasticidad** — Regresión log-log por SKU sobre la variación real de precio observada en tus transacciones.
- **Segmentación automática** — Clasifica productos en Hero Product, Traffic Driver, Premium Product, Margin Killer, Sensitive Product y Standard.
- **Recomendaciones de IA** — Acciones de pricing con razonamiento explicado (subir precio, bajar precio, evitar promo, revisar costo, mantener).
- **Simulador What-If** — Sliders de precio, costo y promoción con cálculo de impacto en tiempo real usando la elasticidad calculada.
- **Insights ejecutivos** — Conclusiones en lenguaje de consultoría, listas para comité directivo.
- **Detección de anomalías** — Márgenes críticos, variación inconsistente de precio entre tiendas, descuentos extremos.
- **Executive Mode** — Vista simplificada para directivos con oportunidad cuantificada.
- **Exportación** — CSV enriquecido, JSON API-ready, reporte ejecutivo en texto.

## Tech stack

- **HTML/CSS/JS vanilla** — Sin frameworks, sin build step
- **Chart.js** — Visualizaciones
- **PapaParse** — Parseo CSV
- **SheetJS** — Parseo Excel
- **Manrope + JetBrains Mono + Instrument Serif** — Tipografía

Inspirado visualmente en Bloomberg Terminal, Linear y Stripe Dashboard. Paleta cromática contrastante (negro, gris oscuro, amarillo, blanco) optimizada para dashboards de retail.

## Uso

### Opción A — Local

```bash
git clone https://github.com/TU-USUARIO/pricing-intelligence-platform.git
cd pricing-intelligence-platform
# Abre index.html en tu navegador (doble clic), o:
python3 -m http.server 8000
# Visita http://localhost:8000
```

### Opción B — GitHub Pages (un clic)

1. Settings → Pages
2. Source: `Deploy from a branch` → `main` → `/ (root)`
3. Visita `https://TU-USUARIO.github.io/pricing-intelligence-platform/`

### Opción C — Vercel / Netlify

Conecta el repo y deploya. No requiere configuración (no hay build step).

## Estructura del proyecto

```
pricing-intelligence-platform/
├── index.html        # UI principal (estructura + 11 vistas/módulos)
├── styles.css        # Diseño · paleta · animaciones
├── app.js            # Lógica completa: parseo, elasticidad, segmentación, recomendaciones
├── README.md
├── LICENSE
└── .gitignore
```

## Formato de datos esperado

Tu archivo CSV/Excel debe tener al menos estas columnas (cualquier nombre — se detectan por heurística):

| Campo | Obligatorio | Alias detectados |
|---|---|---|
| SKU | ✓ | `sku`, `prod_nbr`, `product_id`, `codigo`, `item_id` |
| Precio | ✓ | `precio`, `price`, `precio_unitario`, `unit_price` |
| Cantidad | ✓ | `qty`, `cantidad`, `unidades`, `units` |
| Costo | recomendado | `costo`, `cost`, `apparent_unit_cost`, `unit_cost` |
| Marca | recomendado | `marca`, `brand`, `fabricante` |
| Categoría | recomendado | `class_nm`, `categoria`, `category`, `dept_nm` |
| Fecha | recomendado | `fecha`, `date`, o `año`+`mes`+`día` separados |
| Tienda | opcional | `store_nm`, `tienda`, `store`, `sucursal` |

Sin costo, el margen se omite de algunos cálculos. Sin fecha, no se muestra la tendencia temporal. Lo demás funciona normalmente.

## Metodología de elasticidad

Para cada SKU con suficiente variación de precio observada (al menos 5 transacciones con desviación estándar de log-precio > 0.01):

```
log(Q) = α + E · log(P) + ε
```

Donde **E** es la elasticidad-precio. Se calcula por OLS con coeficiente R² para nivel de confianza:

- **R² > 0.5** → confianza Alta
- **R² > 0.2** → confianza Media
- **otherwise** → confianza Baja (fallback a elasticidad de categoría)

## Lógica de recomendaciones

| Condición | Acción | Razón |
|---|---|---|
| `|E| < 0.5` y margen > 20% | **SUBIR PRECIO +8%** | Demanda muy insensible · alta oportunidad |
| `|E| < 0.7` y margen > 25% | **SUBIR PRECIO +5%** | Demanda poco sensible · margen saludable |
| `|E| > 1.5` y margen < 20% | **BAJAR PRECIO -3%** | Activar volumen en producto elástico |
| margen < 10% | **REVISAR COSTO** | Margen crítico · negociar con proveedor |
| `|E| > 1.2` | **EVITAR PROMO** | Promociones erosionan margen sin volumen rentable |
| Segmento Hero | **MANTENER** | Balance óptimo · no tocar |

## Lógica de segmentación

| Segmento | Criterio |
|---|---|
| **Hero Product** | Revenue ≥ p75 + Margen ≥ p50 |
| **Traffic Driver** | Revenue ≥ p75 + Margen < p50 |
| **Premium Product** | Margen ≥ p50 + Revenue < p50 + Precio > mediana |
| **Margin Killer** | Margen < p25 |
| **Sensitive Product** | `|Elasticidad| > 1.5` |
| **Standard** | Resto |

## Roadmap

- [ ] Forecasting de demanda (series de tiempo)
- [ ] Comparación con competencia (web scraping opcional)
- [ ] AI assistant integrado (Claude / OpenAI API)
- [ ] Guardado de escenarios en localStorage
- [ ] Multi-empresa con permisos por rol
- [ ] Exportación a PDF nativo
- [ ] Backend opcional FastAPI + PostgreSQL para deploy enterprise

## Privacidad

Esta plataforma es **100% client-side**. Tu dataset:

- Se procesa en memoria del navegador
- No se sube a ningún servidor
- No se guarda en localStorage ni cookies
- Desaparece cuando cierras la pestaña

Las únicas peticiones externas son a los CDNs públicos (jsDelivr, Google Fonts) para cargar las librerías. Si quieres aislamiento total, descarga las librerías y sírvelas locales.

## Licencia

MIT — Ver [LICENSE](LICENSE).

## Contribuciones

PRs bienvenidos. Issues con label `good first issue` son ideales para empezar.

---

Construido como demostración de la convergencia entre data science, pricing strategy y product design.
