// ─────────────────────────────────────────────────────────────
// Lector abierto de convocatorias públicas (ayudante de AChambearPerú)
//
//   node lector/leer.mjs
//
// Busca avisos de convocatoria en gob.pe, abre cada aviso nuevo y
// convierte sus bases en PDF a texto (con OCR si es escaneado).
// Lo leído queda en la carpeta datos/ (rama "lecturas" del repo):
//   datos/indice.json            lista de avisos leídos
//   datos/lecturas/<id>.json     página, documentos y texto de las bases
//   datos/estado.json            colecciones conocidas y avisos ya leídos
//
// Este lector no tiene claves ni acceso a ninguna base de datos:
// solo lee páginas públicas y deja el texto aquí.
// ─────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { leerBuscador, leerAviso, leerPdf, Detenido, paginasSaltadas, coleccionesVistas, leerDirectorioEstado, buscarInstituciones, leerInstitucion } from "./gobpe.mjs";

const DATOS = process.env.DATOS_DIR ?? "datos";
const MAX_AVISOS = Number(process.env.LECTOR_MAX_AVISOS ?? 150);
const COMPENDIOS = Number(process.env.LECTOR_COMPENDIOS ?? 40);
const MAX_OCR = Number(process.env.LECTOR_MAX_OCR ?? 30);
// La vuelta tiene 55 minutos: a los 40 se deja de leer y se guarda lo leído.
const TIEMPO_MAX_MS = Number(process.env.LECTOR_TIEMPO_MAX_MIN ?? 40) * 60000;
// Entidades revisadas por vuelta (su página de publicaciones), con tope de tiempo.
const INSTITUCIONES = Number(process.env.LECTOR_INSTITUCIONES ?? 200);
const TIEMPO_INSTITUCIONES_MS = Number(process.env.LECTOR_TIEMPO_INSTITUCIONES_MIN ?? 15) * 60000;
const BUSCAR_INSTITUCIONES_POR_VUELTA = 6;
const DEPARTAMENTOS = ["amazonas", "ancash", "apurimac", "arequipa", "ayacucho", "cajamarca", "callao", "cusco", "huancavelica", "huanuco", "ica", "junin",
  "la libertad", "lambayeque", "lima", "loreto", "madre de dios", "moquegua", "pasco", "piura", "puno", "san martin", "tacna", "tumbes", "ucayali"];
const TERMINOS_INSTITUCIONES = [
  "municipalidad distrital", "municipalidad provincial", "ugel", "red de salud", "hospital", "direccion regional de salud",
  "direccion regional de educacion", "gobierno regional", "universidad nacional", "corte superior de justicia", "zona registral",
  "instituto nacional", "programa nacional", "proyecto especial", "beneficencia", "superintendencia", "autoridad", "empresa",
  ...DEPARTAMENTOS, ...DEPARTAMENTOS.map((d) => `municipalidad ${d}`),
];
const GUARDAR_DIAS = 30; // las lecturas se borran a los 30 días (los avisos ya cerraron)
const RECORDAR_DIAS = 120; // y el id se recuerda 120 días para no volver a leerlo
const MAX_INTENTOS = 3; // un PDF que no baja en 3 vueltas se guarda sin texto

// Avisos que ya cerraron: se guarda la página pero no se bajan sus PDF
// (ahorra tiempo y visitas a gob.pe). Cerrado = ya publicó resultados
// finales, o se publicó hace más de 40 días.
const DIAS_CERRADO = 40;
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, setiembre: 9, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const RESULTADO_FINAL = /resultados?\s+finale?s?\b(?!\s+(?:de\s+(?:la\s+)?)?evaluaci[oó]n)|cuadro\s+de\s+m[eé]ritos\s+final|\bganador(?:es|as)?\b/i;
function yaCerro(pagina) {
  if (pagina.documentos.some((d) => RESULTADO_FINAL.test(d.label)) || RESULTADO_FINAL.test(pagina.textoPagina)) return true;
  const m = pagina.textoPagina.slice(0, 1500).match(/\b(\d{1,2}) de (\p{L}+) de (20\d{2})\b/u);
  const mes = m && MESES[m[2].toLowerCase()];
  return Boolean(mes) && (Date.now() - Date.UTC(Number(m[3]), mes - 1, Number(m[1]))) / 86400000 > DIAS_CERRADO;
}

const INICIO = Date.now();
const ahora = new Date().toISOString();
const diasDesde = (fecha) => (Date.now() - Date.parse(fecha)) / 86400000;
const leerJson = (archivo, siNo) => (existsSync(archivo) ? JSON.parse(readFileSync(archivo, "utf8")) : siNo);

mkdirSync(join(DATOS, "lecturas"), { recursive: true });
const estado = leerJson(join(DATOS, "estado.json"), { version: 1, leidos: {}, intentos: {}, colecciones: [] });
estado.instituciones ??= {}; // slug → { nombre, encontrada_en, revisada_en, ultimos_tomados }
const anotarInstitucion = (slug, nombre) => {
  if (!estado.instituciones[slug]) estado.instituciones[slug] = { nombre, encontrada_en: ahora, revisada_en: null };
};
const indice = leerJson(join(DATOS, "indice.json"), { version: 1, lecturas: [] });

let leidos = 0;
let ocrUsados = 0;
let quedan = 0;
let detenido = null;

try {
  // Primero las colecciones que hace más tiempo no se revisan (las nuevas, sin fecha, van primero).
  const extras = [...estado.colecciones]
    .sort((a, b) => (a.revisada_en ?? "").localeCompare(b.revisada_en ?? ""))
    .slice(0, COMPENDIOS)
    .map(({ url, entidadSigla, entidad, titulo }) => ({ url, entidadSigla, entidad, titulo }));
  const delBuscador = await leerBuscador(COMPENDIOS, extras);

  // ─── Directorio de entidades ───
  // /estado se relee una vez por semana; el buscador de instituciones rota términos cada hora.
  if (!estado.directorio_en || diasDesde(estado.directorio_en) > 7) {
    const nacionales = await leerDirectorioEstado();
    for (const i of nacionales) anotarInstitucion(i.slug, i.nombre);
    if (nacionales.length) estado.directorio_en = ahora;
  }
  const grupo = Math.floor(Date.now() / 3600000) % Math.ceil(TERMINOS_INSTITUCIONES.length / BUSCAR_INSTITUCIONES_POR_VUELTA);
  for (const termino of TERMINOS_INSTITUCIONES.slice(grupo * BUSCAR_INSTITUCIONES_POR_VUELTA, (grupo + 1) * BUSCAR_INSTITUCIONES_POR_VUELTA)) {
    for (const i of await buscarInstituciones(termino)) anotarInstitucion(i.slug, i.nombre);
  }
  // Las entidades de los avisos y colecciones que ya conocemos también entran.
  for (const a of [...delBuscador, ...estado.colecciones]) {
    const slug = (a.url ?? "").match(/\/institucion\/([a-z0-9-]+)\//)?.[1];
    if (slug) anotarInstitucion(slug, a.entidad ?? slug);
  }

  // ─── Publicaciones de cada entidad (las menos revisadas primero) ───
  const avisos = new Map(delBuscador.map((a) => [a.id, a]));
  const inicioInstituciones = Date.now();
  let revisadas = 0;
  const porRevisar = Object.entries(estado.instituciones)
    .sort(([, a], [, b]) => (a.revisada_en ?? "").localeCompare(b.revisada_en ?? ""))
    .slice(0, INSTITUCIONES);
  for (const [slug, inst] of porRevisar) {
    if (Date.now() - inicioInstituciones > TIEMPO_INSTITUCIONES_MS) break;
    const r = await leerInstitucion(slug);
    inst.revisada_en = new Date().toISOString();
    revisadas += 1;
    if (!r) { inst.sin_pagina = (inst.sin_pagina ?? 0) + 1; continue; }
    inst.nombre = r.nombre;
    inst.ultimos_tomados = r.avisos.length;
    delete inst.sin_pagina;
    for (const a of r.avisos) if (!avisos.has(a.id)) avisos.set(a.id, a);
  }
  // Una entidad sin página de publicaciones en 5 vueltas seguidas se olvida.
  for (const [slug, inst] of Object.entries(estado.instituciones)) if ((inst.sin_pagina ?? 0) >= 5) delete estado.instituciones[slug];
  console.log(`Entidades conocidas: ${Object.keys(estado.instituciones).length} · revisadas en esta vuelta: ${revisadas}.`);
  const lista = [...avisos.values()].sort((a, b) => Number(b.id) - Number(a.id));

  const porUrl = new Map(estado.colecciones.map((c) => [c.url, c]));
  for (const v of coleccionesVistas.values()) {
    const c = porUrl.get(v.url) ?? { url: v.url, entidadSigla: v.entidadSigla, entidad: v.entidad, titulo: v.titulo, encontrada_en: ahora, revisada_en: null };
    if (v.tomados !== null) Object.assign(c, { revisada_en: ahora, ultimos_tomados: v.tomados });
    porUrl.set(v.url, c);
  }
  estado.colecciones = [...porUrl.values()];

  const nuevos = lista.filter((a) => !estado.leidos[a.id]);
  console.log(`Avisos encontrados (buscador + entidades): ${lista.length}, ${nuevos.length} sin leer. Colecciones conocidas: ${estado.colecciones.length}.`);

  for (const [i, aviso] of nuevos.slice(0, MAX_AVISOS).entries()) {
    if (Date.now() - INICIO > TIEMPO_MAX_MS) {
      quedan = Math.min(nuevos.length, MAX_AVISOS) - i;
      console.log(`Se acabó el tiempo: ${quedan} avisos quedan para la próxima vuelta.`);
      break;
    }
    const pagina = await leerAviso(aviso);
    if (!pagina) continue; // se reintenta en la próxima vuelta
    const cerrado = yaCerro(pagina);
    const leido = pagina.bases && !cerrado ? await leerPdf(pagina.bases, ocrUsados < MAX_OCR) : null;
    if (leido?.pendienteOcr) continue; // escaneado sin cupo de OCR: va en la próxima vuelta
    if (pagina.bases && !cerrado && !leido) {
      estado.intentos[aviso.id] = (estado.intentos[aviso.id] ?? 0) + 1;
      if (estado.intentos[aviso.id] < MAX_INTENTOS) continue;
    }
    if (leido?.ocr) ocrUsados += 1;
    const lectura = {
      version: 1,
      id: aviso.id,
      titulo: aviso.titulo,
      url: aviso.url,
      entidadSigla: aviso.entidadSigla,
      entidad: aviso.entidad,
      leido_en: new Date().toISOString(),
      textoPagina: pagina.textoPagina,
      documentos: pagina.documentos,
      bases: pagina.bases,
      texto: leido?.texto ?? null,
      layout: leido?.layout ?? null,
      ocr: Boolean(leido?.ocr),
      cerrado,
    };
    writeFileSync(join(DATOS, "lecturas", `${aviso.id}.json`), JSON.stringify(lectura));
    indice.lecturas = indice.lecturas.filter((l) => l.id !== aviso.id);
    indice.lecturas.push({ id: aviso.id, leido_en: lectura.leido_en });
    estado.leidos[aviso.id] = lectura.leido_en;
    delete estado.intentos[aviso.id];
    leidos += 1;
    console.log(`· ${aviso.id} ${cerrado ? "ya cerró (sin bajar PDF)" : lectura.texto ? (lectura.ocr ? "leído con OCR" : "leído") : "sin texto"} · ${aviso.entidadSigla} · ${aviso.titulo.slice(0, 70)}`);
  }
} catch (e) {
  detenido = e instanceof Detenido ? e.message : `error inesperado: ${e.stack ?? e.message}`;
  console.error(`DETENIDO: ${detenido}`);
}

// ─── Limpieza y guardado (siempre, aunque se haya detenido) ───
for (const l of indice.lecturas.filter((l) => diasDesde(l.leido_en) > GUARDAR_DIAS)) {
  rmSync(join(DATOS, "lecturas", `${l.id}.json`), { force: true });
}
indice.lecturas = indice.lecturas.filter((l) => diasDesde(l.leido_en) <= GUARDAR_DIAS).sort((a, b) => Number(b.id) - Number(a.id));
for (const [id, fecha] of Object.entries(estado.leidos)) if (diasDesde(fecha) > RECORDAR_DIAS) delete estado.leidos[id];
indice.actualizado = new Date().toISOString();

writeFileSync(join(DATOS, "indice.json"), JSON.stringify(indice, null, 1));
writeFileSync(join(DATOS, "estado.json"), JSON.stringify(estado, null, 1));

const resumen = [
  `Vuelta ${indice.actualizado.slice(0, 16).replace("T", " ")} UTC · leídos: ${leidos} · con OCR: ${ocrUsados}` + (quedan ? ` · quedan ${quedan} para la próxima` : ""),
  `Lecturas guardadas: ${indice.lecturas.length} · colecciones conocidas: ${estado.colecciones.length} · entidades conocidas: ${Object.keys(estado.instituciones).length}`,
  detenido ? `El lector se detuvo: ${detenido}` : "",
  paginasSaltadas.length ? `Páginas saltadas:\n${paginasSaltadas.map((p) => `- ${p}`).join("\n")}` : "",
].filter(Boolean).join("\n");
console.log(`\n${resumen}`);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, resumen + "\n", { flag: "a" });
if (detenido) process.exitCode = 1;
