# Lector de convocatorias públicas

Lector abierto que reúne las convocatorias de empleo público del Perú (CAS, 728, 276 y prácticas) publicadas en [gob.pe](https://www.gob.pe), para el buscador de empleo [AChambearPerú](https://achambearperu.com).

## Qué hace

Cada hora:

1. Busca avisos de convocatoria en el buscador público de gob.pe y en las colecciones "Convocatorias CAS" de cada entidad.
2. Abre cada aviso nuevo y pasa sus bases en PDF a texto (con OCR en español si el PDF es escaneado).
3. Guarda lo leído en la rama [`lecturas`](../../tree/lecturas): `indice.json` y un archivo por aviso en `lecturas/`.

## Reglas para no molestar a gob.pe

- Se identifica con un nombre honesto (`AChambearPeruBot`) que incluye web y correo de contacto.
- Visita una página a la vez, con 4 segundos de pausa entre cada una.
- Si gob.pe responde 403 o 429, se detiene al instante. Si falla varias veces, también.
- Respeta su `robots.txt` y no usa la paginación `?sheet=` que este prohíbe.

## Seguridad

Este repositorio no tiene claves ni acceso a ninguna base de datos. Solo lee páginas públicas y guarda texto público. El flujo arranca por horario o a mano, nunca por pull requests.

Contacto: achambearperu@gmail.com
