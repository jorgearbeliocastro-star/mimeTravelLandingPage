---
name: cruise-cabin-prices-pending
description: carga de precios reales de camarote por fecha (cabin_date_prices) para cruise_itineraries, en curso, datos ya extraídos de capturas de MSC
metadata:
  type: project
---

El usuario está mandando capturas de la web real de MSC (Itineraries Results) para cargar `cabin_date_prices` (columna jsonb nueva en `cruise_itineraries` — ver [[cruise-cabin-price-matrix]] si existe esa memoria) con precios reales por fecha × camarote × tarifa. Trabajo en curso, interrumpido para "volver al inicio" — no perder este contexto.

**Reglas acordadas con el usuario:**
- Precio se carga **tal cual** como viene en la captura (el usuario confirmó cargarlo como "por persona" en el sistema, aunque MSC lo etiqueta "PC" = per cabin — decisión del usuario, no cuestionar de nuevo).
- Cuando MSC muestra "N/A" en una fecha = sin reservas disponibles → NO se carga precio para esa fecha (no agregar a `cabin_date_prices` ni a `available_dates`).
- El precio grande de cada chip de fecha = precio de **Interior**, tarifa **Bella** (la más barata/base) — MSC no desglosa Bella/Fantastica/Aurea en esta vista, solo Interior/Balcony/etc. Se carga con clave `interior_bella`, `balcony_bella`, etc. (sin fantastica/aurea, no hay datos de esos todavía).
- El precio de Balcony (u otro camarote superior) solo aparece en el recuadro "CRUISE ONLY" de la fecha que está seleccionada/con borde azul en la captura — si no está seleccionada, solo se puede cargar el precio de Interior (el del chip), no Balcony.
- Las fotos de camarote/extras que ya existen en el sistema son **todas del MSC Seaside** — no hay fotos propias de otros barcos (MSC World America, MSC Poesia, etc.). Pendiente de decidir: ¿dejar la foto del Seaside como genérica para todos los barcos, o no mostrar foto para los que no tienen la suya?
- El negocio **no liga con otras navieras** (Royal Caribbean, Carnival, etc.) — todo el sistema de camarotes (`CABIN_TYPE_ORDER`/`FARE_TIER_ORDER`, nombres Bella/Fantastica/Aurea) es específico de MSC a propósito, no hace falta generalizarlo.

**Itinerarios de MSC Poesia vistos en capturas, NO existen todavía en `cruise_itineraries`** (5, 10 y 15 noches, puertos "George Town, Ocho Ri...", "Kralendijk, Oranjest...") — pendiente de decidir con el usuario si se crean (el de 15 noches sí tenía precio real: Interior USD 2050, Balcony USD 3121 para 2026-10-17; los de 5 y 10 noches estaban N/A esa fecha).

**Datos ya extraídos y verificados, SQL armado pero NO corrido todavía** (esperando resolver lo de MSC Poesia antes de correrlo) — para octubre 2026, sobre estos itinerarios ya existentes:

- `384ca5ac-056f-4262-87e1-5f6aef46896e` (Seaside Caribe y Bahamas 3n): 2026-10-16 interior_bella=417, balcony_bella=1077
- `876581ad-da42-42f1-b0dc-f2ab38f7004d` (Seaside Caribe y Bahamas 4n): 2026-10-26 interior_bella=265, balcony_bella=1005
- `e4fba6ce-9a07-49d3-af5c-e31d00d1d813` (Seaside Caribe y Bahamas 7n): 10-05=613(solo interior), 10-12=629(solo interior), 10-19=708(solo interior), 10-10=645/balcony=2013 (10-10 no estaba en available_dates, hay que agregarlo)
- `31a1b05d-7241-4e2b-b804-a9713101311f` (World America Caribe Oriental 7n): 10-03=723/balcony=2433, 10-17=719(solo interior) — agregar ambas fechas a available_dates (solo tenía fechas de septiembre)
- `63adce12-653c-45b1-b5f2-68216ec3673f` (World America Caribe Oriental 14n): 10-17=1485/balcony=4065, 10-31=1528(solo interior) — agregar fechas a available_dates
- `805464ce-0c8c-4ad8-9f78-811bb337671e` (World America Caribe Occidental 14n): 10-10=1663/balcony=4159, 10-24=1440(solo interior) — agregar fechas a available_dates (solo tenía "2026-09-26")

El SQL completo con estos `update` ya se le mostró al usuario en el chat pero no se corrió — reconstruir con estos mismos datos si hace falta retomar.

Faltan: resto de octubre, y noviembre/diciembre completos, para TODOS los itinerarios (Seaside 7n Caribe Oriental/Occidental/10n, World America Caribe Occidental 7n, etc.) — el usuario dijo que van a seguir mandando capturas mes a mes hasta fin de año, para esta ruta que sale de Miami.
