// ─────────────────────────────────────────────────────────────
// Lector de gob.pe: lee el buscador público (JSON), abre cada
// aviso nuevo y descarga sus bases en PDF.
//
// Reglas para no molestar ni ser bloqueados:
//  · Nombre honesto del bot, con web y correo.
//  · Una visita a la vez, con pausa de 4 segundos.
//  · Si la web responde con error (403, 429, 5xx), el bot se detiene.
//  · robots.txt de gob.pe: solo prohíbe /admin/ y ?sheet= (no los usamos).
// ─────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOT = "AChambearPeruBot/0.1 (+https://achambearperu.com; achambearperu@gmail.com)";
const PAUSA_MS = Number(process.env.BOT_PAUSA_MS ?? 4000);
const BASE = "https://www.gob.pe";

export class Detenido extends Error {}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let ultimaVisita = 0;

// Fallas sueltas del servidor (502, 503, sin conexión) en una página:
// se salta esa página. Si se repiten, gob.pe está con problemas y el bot
// se detiene. Un 403 o 429 (nos están frenando) detiene el bot al tiro.
const MAX_FALLAS = 3;
let fallas = 0;
export const paginasSaltadas = [];

function fallaSuelta(url, motivo) {
  fallas += 1;
  paginasSaltadas.push(`${motivo} · ${url}`);
  if (fallas >= MAX_FALLAS) throw new Detenido(`gob.pe falló ${fallas} veces (la última: ${motivo} en ${url}): el bot se detiene para no insistir`);
  return null;
}

async function visitar(url, tipo = "texto") {
  const falta = ultimaVisita + PAUSA_MS - Date.now();
  if (falta > 0) await esperar(falta);
  ultimaVisita = Date.now();
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": BOT }, signal: AbortSignal.timeout(40000) });
  } catch (e) {
    return fallaSuelta(url, `sin conexión (${e.message})`);
  }
  if (r.status === 403 || r.status === 429) {
    throw new Detenido(`gob.pe respondió ${r.status} en ${url}: nos está frenando, el bot se detiene`);
  }
  if (r.status >= 500) return fallaSuelta(url, `error ${r.status} del servidor`);
  if (!r.ok) return null; // 404 u otro: se salta solo esa página
  return tipo === "pdf" ? Buffer.from(await r.arrayBuffer()) : r.text();
}

// ─── 1. Buscador: avisos y compendios de todas las entidades ───
// El buscador solo devuelve 25 resultados por consulta (la paginación
// usa "sheet=", que robots.txt de gob.pe prohíbe, así que no la usamos).
// Por eso se hacen varias búsquedas y se abren los compendios
// ("Convocatorias CAS 2026" de cada entidad), que listan sus avisos.
const BUSQUEDAS = ["convocatoria cas", "proceso cas", "concurso publico de meritos", "convocatoria practicas", "convocatoria 728"];

// Búsquedas "por relevancia" (sin sort_by=recent): estas sí respetan la palabra
// buscada y traen colecciones y avisos de entidades que nunca salen entre los
// 25 más recientes. Son muchas, así que cada vuelta hace solo unas cuantas
// (rotando) y en un día se recorren todas.
const AÑO = new Date().getFullYear();
const DESCUBRIR = [
  "hospital", "red de salud", "diresa", "geresa", "essalud", "instituto nacional de salud", "ugel", "direccion regional de educacion",
  "municipalidad provincial", "municipalidad distrital", "gobierno regional", "corte superior de justicia", "universidad nacional",
  "zona registral", "ministerio", "programa nacional", "practicas profesionales", "practicas preprofesionales", "728", "276",
  "amazonas", "ancash", "apurimac", "arequipa", "ayacucho", "cajamarca", "callao", "cusco", "huancavelica", "huanuco", "ica",
  "junin", "la libertad", "lambayeque", "lima", "loreto", "madre de dios", "moquegua", "pasco", "piura", "puno", "san martin",
  "tacna", "tumbes", "ucayali",
].map((t) => `convocatoria cas ${AÑO} ${t}`);
const DESCUBRIR_POR_VUELTA = Number(process.env.BOT_DESCUBRIR ?? 6);
const DIAS_AVISO_RECIENTE = 45; // en búsquedas por relevancia, avisos más antiguos ya cerraron

const MESES = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, setiembre: 8, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };
// "23 de abril de 2026" (o "22 de abril de 2025 -  1:13 p. m.") → milisegundos
function fechaDeGobpe(texto) {
  const m = String(texto ?? "").match(/(\d{1,2}) de (\p{L}+) de (\d{4})/u);
  return m && m[2].toLowerCase() in MESES ? Date.UTC(Number(m[3]), MESES[m[2].toLowerCase()], Number(m[1])) : null;
}
// Una colección de años pasados ("Convocatoria CAS N°002 - 2024") ya no trae avisos abiertos.
const deAñoPasado = (titulo) => (titulo.match(/\b20\d{2}\b/g) ?? []).some(Number) && !(titulo.match(/\b20\d{2}\b/g) ?? []).some((a) => Number(a) >= AÑO);

function terminosDeEstaVuelta() {
  const grupos = Math.ceil(DESCUBRIR.length / DESCUBRIR_POR_VUELTA);
  const g = Math.floor(Date.now() / 3600000) % grupos; // cambia cada hora
  return DESCUBRIR.slice(g * DESCUBRIR_POR_VUELTA, (g + 1) * DESCUBRIR_POR_VUELTA);
}
const SI = /\b(convocatoria|proceso|concurso)\b.*\b(cas|1057|728|276|pr[aá]cticas?|practicantes?)\b|\b(cas|pr[aá]cticas?)\b[^|]{0,20}\bn[°º.]|contrataci[oó]n administrativa de servicios/i;
const NO = /resultado|becari|beca\b|encargatura|director(a)? general|lista de|fe de erratas|comunicado|acta\b|cronograma|ganador|apto|entrevista|evaluaci[oó]n|cancelad|desiert|suspend|postergad|ampliaci|rectificaci|modificaci|procedimientos? de selecci|comercializador|nombramiento|rendici[oó]n de cuentas|raee|donaci|rotaci|reasignaci|designaci|destaque/i;
// Colecciones de compras, obras o servicios (no son empleos).
const COMPENDIO_NO = /obras por impuestos|proyectos? de inversi|servicios de terceros|bienes|adquisici|contrataciones? (directas|menores)|proveedores|licitaci|arrendamiento/i;
const COMPENDIO_SI = /convocatoria|concurso|\bcas\b|728|276|pr[aá]ctica|trabaj|laboral|plazas/i;

// Registro de todo lo que se vio y por qué se tomó o no
// (se guarda en bot-salida/buscador.txt para revisar el filtro).
export const registroBuscador = [];

function motivoAviso(titulo) {
  if (NO.test(titulo)) return `descartado por "${titulo.match(NO)[0]}"`;
  if (!SI.test(titulo)) return "no parece convocatoria";
  return "TOMADO";
}

function separarEntidad(card) {
  const [sigla, ...resto] = (card ?? "").split(" - ");
  return { entidadSigla: sigla.trim(), entidad: resto.join(" - ").trim() || sigla.trim() };
}

// Colecciones vistas en esta vuelta (el bot las guarda en Supabase para
// revisarlas siempre, aunque ya no salgan en el buscador).
export const coleccionesVistas = new Map(); // url → { url, entidadSigla, entidad, titulo, tomados }

// extras: colecciones guardadas de vueltas anteriores (las menos revisadas primero).
export async function leerBuscador(maxCompendios = 12, extras = []) {
  const avisos = new Map();
  const compendios = new Map();
  const consultas = [
    ...BUSQUEDAS.map((t) => ({ termino: t, recientes: true })),
    ...(DESCUBRIR_POR_VUELTA > 0 ? terminosDeEstaVuelta().map((t) => ({ termino: t, recientes: false })) : []),
  ];
  for (const { termino, recientes } of consultas) {
    const url = `${BASE}/busquedas.json?term=${encodeURIComponent(termino).replace(/%20/g, "+")}&contenido[]=publicaciones${recientes ? "&sort_by=recent" : ""}`;
    const texto = await visitar(url);
    if (!texto) continue;
    let resultados = [];
    try {
      resultados = JSON.parse(texto)?.data?.attributes?.results;
      if (!Array.isArray(resultados)) resultados = [];
    } catch {
      paginasSaltadas.push(`respuesta no es JSON · ${url}`);
      continue;
    }
    // gob.pe a veces manda resultados vacíos (null) en la lista: se saltan.
    for (const r of resultados) {
      if (!r || typeof r !== "object") continue;
      const html = String(r.url ?? "");
      const enlace = html.match(/href=["']([^"']+)["']/)?.[1];
      const titulo = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!enlace) continue;
      let motivo;
      if (r.searchable_type === "DocumentsCollection") {
        motivo = COMPENDIO_SI.test(titulo) && !NO.test(titulo) && !COMPENDIO_NO.test(titulo) ? "COMPENDIO" : "compendio descartado";
        if (motivo === "COMPENDIO" && deAñoPasado(titulo)) motivo = "compendio de años pasados";
        if (motivo === "COMPENDIO") compendios.set(BASE + enlace, { url: BASE + enlace, titulo, ...separarEntidad(r.content_sub_title_card) });
      } else if (r.searchable_type === "Report") {
        motivo = motivoAviso(titulo);
        const fecha = fechaDeGobpe(r.publication);
        if (motivo === "TOMADO" && !recientes && fecha && Date.now() - fecha > DIAS_AVISO_RECIENTE * 86400000) motivo = "antiguo (ya cerró)";
        const id = enlace.match(/\/(\d+)-[^/]*$/)?.[1];
        if (motivo === "TOMADO" && id) avisos.set(id, { id, titulo, url: BASE + enlace, ...separarEntidad(r.content_sub_title_card) });
      } else motivo = `no es aviso (${r.searchable_type})`;
      registroBuscador.push(`"${termino}" | ${motivo.padEnd(28)} | ${r.content_sub_title_card ?? ""} | ${titulo}`);
    }
  }

  // Compendios: su primera página trae los avisos más recientes de esa entidad.
  // Primero las guardadas que hace más tiempo no se revisan (las recién
  // encontradas se guardan y entran primero en la próxima vuelta).
  const porRevisar = [...extras, ...[...compendios.values()].filter((c) => !extras.some((e) => e.url === c.url))];
  for (const c of porRevisar.slice(0, maxCompendios)) {
    const html = await visitar(c.url);
    coleccionesVistas.set(c.url, { ...c, tomados: 0 });
    if (!html) continue;
    const main = html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? html;
    const enlaces = main.matchAll(/<a[^>]*href="(\/institucion\/[^"]+\/informes-publicaciones\/(\d+)-[^"]*)"[^>]*>([\s\S]{0,400}?)<\/a>/g);
    for (const [, enlace, id, interior] of enlaces) {
      const titulo = interior.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      if (!titulo || avisos.has(id)) continue;
      const motivo = motivoAviso(titulo);
      registroBuscador.push(`compendio | ${motivo.padEnd(28)} | ${c.entidadSigla} | ${titulo}`);
      if (motivo === "TOMADO") {
        avisos.set(id, { id, titulo, url: BASE + enlace, entidadSigla: c.entidadSigla, entidad: c.entidad });
        coleccionesVistas.get(c.url).tomados += 1;
      }
    }
  }
  for (const c of porRevisar) if (!coleccionesVistas.has(c.url)) coleccionesVistas.set(c.url, { ...c, tomados: null });
  // El número del aviso en gob.pe crece con el tiempo: los más altos son los más nuevos.
  return [...avisos.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

// ─── 2. Página del aviso: sus PDF y la fecha de postulación ────
// Se compara palabra por palabra del nombre del archivo ("analista" no es "lista").
const PDF_DESCARTAR = / (cronograma|resultados?|lista|inscritos|comunicados?|acta|fe de erratas|declaracion(es)?|instructivo|anexos?|formatos?|ganador(es)?|aptos?|horarios?|entrevistas?|preliminar|final) /i;
const PDF_PREFERIR = / (bases|perfil|informacion general|tdr|terminos|convocatoria|requerimiento) /i;
const palabrasDe = (url) => ` ${url.split("/").pop().replace(/\.pdf$/i, "").replace(/[-_.\s]+/g, " ")} `;

export async function leerAviso(aviso) {
  const html = await visitar(aviso.url);
  if (!html) return null;
  const main = html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? html;
  const textoPagina = main.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/\n\s*\n+/g, "\n");
  // Solo los PDF propios de este aviso: su nombre empieza con el id.
  const propios = [...new Set(main.match(new RegExp(`https://cdn\\.www\\.gob\\.pe/uploads/document/file/\\d+/${aviso.id}-[^"'?\\s]+\\.pdf`, "g")) ?? [])];
  const documentos = propios.map((url) => ({
    label: url.split("/").pop().replace(/^\d+-/, "").replace(/\.pdf$/, "").replace(/-/g, " "),
    url,
  }));
  const candidatos = propios.filter((u) => PDF_PREFERIR.test(palabrasDe(u)) || !PDF_DESCARTAR.test(palabrasDe(u)));
  const bases = candidatos.find((u) => PDF_PREFERIR.test(palabrasDe(u))) ?? candidatos[0] ?? null;
  return { textoPagina, documentos, bases };
}

// ─── 3. Bases en PDF → texto ──────────────────────────────────
// Devuelve { texto, ocr } o null si no se pudo descargar. Si el PDF es una
// foto escaneada (casi sin letras) y conOcr es true, lo lee con OCR:
// tesseract en español, gratis. Si no se pudo leer, texto queda en null.
const PAGINAS_OCR = 6;
const tieneTexto = (t) => (t ?? "").replace(/\s/g, "").length >= 200;

export async function leerPdf(url, conOcr = true) {
  const datos = await visitar(url, "pdf");
  if (!datos) return null;
  const carpeta = mkdtempSync(join(tmpdir(), "bases-"));
  try {
    const archivo = join(carpeta, "bases.pdf");
    writeFileSync(archivo, datos);
    // pdftotext (paquete poppler-utils). Sin -layout: deja cada
    // etiqueta seguida de su valor, que es lo que lee el traductor.
    const texto = execFileSync("pdftotext", ["-enc", "UTF-8", archivo, "-"], { maxBuffer: 20 * 1024 * 1024 }).toString("utf8");
    // Con -layout cada fila de una tabla queda en una línea: sirve de respaldo
    // para los cronogramas en tabla (UGEL y otros), donde sin -layout las
    // fechas quedan todas juntas, lejos de su etapa.
    let layout = null;
    try { layout = execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", archivo, "-"], { maxBuffer: 20 * 1024 * 1024 }).toString("utf8"); } catch {}
    if (tieneTexto(texto)) return { texto, layout, ocr: false };
    if (!conOcr) return { texto: null, ocr: false, pendienteOcr: true };
    const ocr = leerConOcr(archivo, carpeta);
    return { texto: tieneTexto(ocr) ? ocr : null, ocr: true };
  } catch (e) {
    return { texto: null, ocr: false }; // PDF dañado: el aviso queda como borrador
  } finally {
    rmSync(carpeta, { recursive: true, force: true });
  }
}

function leerConOcr(archivo, carpeta) {
  try {
    execFileSync("pdftoppm", ["-r", "200", "-gray", "-l", String(PAGINAS_OCR), "-png", archivo, join(carpeta, "pag")], { timeout: 120000 });
    const paginas = readdirSync(carpeta).filter((f) => f.startsWith("pag") && f.endsWith(".png")).sort();
    return paginas.map((f) =>
      execFileSync("tesseract", [join(carpeta, f), "stdout", "-l", "spa"], { timeout: 120000, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8"),
    ).join("\n");
  } catch {
    return ""; // sin tesseract o con error: se queda como escaneado
  }
}
