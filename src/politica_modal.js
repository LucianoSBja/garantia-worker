// Texto del modal de "Política de Garantía y Mantenimiento" que ve el
// técnico en el chat (botón 📘 del header) — GarantIA.
//
// Es un resumen curado, no el PDF entero — vive aparte del documento
// indexado que usa /chat para responder preguntas (ver "Panel admin" en
// CLAUDE.md: reemplazar el archivo actualiza lo que busca /chat, esto es
// lo otro). Antes era HTML fijo escrito a mano en chatHTML(); ahora vive en
// KV como Markdown, editable desde el panel admin (`POST /admin/api/politica`)
// y renderizado del lado del cliente con el mismo sanitizador que ya usan
// las respuestas del chat (`renderMarkdownSeguro`, en chatHTML()) — nunca
// HTML crudo directo a innerHTML.

const KV_KEY_POLITICA = 'politica:modal_markdown';

// Semilla inicial: el mismo contenido que antes vivía como HTML fijo,
// transcripto a Markdown. Se usa solo si nadie editó nada todavía.
const TEXTO_POR_DEFECTO = `## 1. Responsabilidad del propietario

**Obtención del Servicio de Garantía.** El propietario tiene la responsabilidad de acercar su vehículo a cualquier Concesionario Toyota autorizado en el país para obtener el servicio de garantía.

**Mantenimiento y Cuidados.** El propietario es el responsable de la operación correcta, mantenimiento y cuidados de su vehículo Toyota de acuerdo con las instrucciones contenidas en los Manuales del Propietario y Mantenimiento. Si el vehículo está sujeto a uso bajo condiciones severas, debe seguir las especificaciones particulares del Manual de Mantenimiento.

**Registro de Mantenimiento.** Se sugiere conservar los registros de mantenimiento por si es necesario mostrarlos en situaciones que requieran comprobar que este se ha cumplido adecuadamente.

**Servicio de Mantenimiento Periódico.** La realización de todos los Servicios de Mantenimiento Periódico que figuran al final del Manual de Garantía, efectuados en los Concesionarios Oficiales Toyota durante el período de Garantía, es requisito indispensable para que el vehículo se mantenga cubierto por la misma (completar los cupones por triplicado).

## 2. Exclusiones de garantía (lo que no cubre)

- **Factores fuera de control:** reparaciones y ajustes por mal uso (motor a toda velocidad, sobrecarga), negligencia, modificación, alteración, manipulación indebida, accidentes o uso en competencias.
- **Corrosión superficial y pintura** debido a piedras de grava o rayaduras en la pintura.
- **Daños ambientales:** lluvia ácida, sustancias suspendidas en el aire, sal, granizo, tornados, rayos, inundaciones u otros actos de la naturaleza.
- **Ruido normal y desgaste:** ruido normal, vibraciones, desgaste o deterioro natural (decoloración, desvanecimiento, deformación o manchas).
- **Kilometraje alterado:** cualquier falla o evidencia de alteración del kilometraje implica la anulación inmediata de la garantía.
- **Gastos adicionales:** llamadas telefónicas, transporte, pérdida de tiempo, inconveniencias o pérdidas comerciales.
- **Insumos incorrectos:** falta de mantenimiento o uso de combustible, aceite o lubricantes no especificados en el Manual del Propietario.
- **Mantenimiento de rutina:** ajuste de motor, lubricación, limpieza, reemplazo de filtros, refrigerantes, bujías, fusibles, escobillas, pastillas de freno, disco de embrague, alineación y balanceo.

## 3. Restricciones especiales y accesorios no genuinos

**Vibración al frenar — reemplazo de discos.** Cualquier accesorio no genuino (por ejemplo, separadores/espaciadores de rueda) en contacto con los discos de freno anula la garantía por vibración al frenar:

- Genera diferencia de tamaño y mal asentamiento.
- Repercute negativamente en la performance de frenado.
- Provoca desgaste desparejo en las pastillas de freno.

## 4. Criterio de trabajo: exceso de kilometraje en servicios

Ante el ingreso de una unidad cuyo kilometraje se haya excedido significativamente conforme al último servicio realizado, se aplica el siguiente criterio oficial de unificación:

| Caso / Situación | Servicio correspondiente | Observación |
|---|---|---|
| Último servicio a los 10.000 km, ingresa con 28.000 km | Servicio de 20.000 km | Se realiza a los 28.000 km actuales |
| Siguiente mantenimiento (≈40.000 km) | Servicio de 40.000 km | Según el kilometraje que tenga en ese momento |

> Efecto sobre el plan: se saltea el Servicio de 30.000 km para reordenar el plan de mantenimiento de la unidad.

---

Este documento resume la política oficial de garantía, mantenimiento y criterios operativos de taller.`;

export async function leerPoliticaMarkdown(env) {
	const guardado = await env.garantia_cache.get(KV_KEY_POLITICA);
	return guardado || TEXTO_POR_DEFECTO;
}

export async function guardarPoliticaMarkdown(env, markdown) {
	await env.garantia_cache.put(KV_KEY_POLITICA, markdown);
}
