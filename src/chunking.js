// Chunking — copia para el panel admin del Worker.
//
// Tercera copia intencional de esta lógica (además de src/ingest.js y
// src/ingest_file.js): el parseo de archivos para el panel corre en el
// navegador del admin (ver CLAUDE.md, "Panel admin"), pero el chunking es
// liviano en CPU y no tiene el problema de límite que sí tiene el parseo —
// se queda del lado del Worker porque así queda testeable con vitest, cosa
// que esta lógica nunca tuvo en los scripts CLI.
//
// El filtro VIN_RE NO vive acá: se aplica durante el parseo de planillas
// (fila por fila), que ahora pasa en el navegador — para cuando el texto
// llega al Worker, las filas de VIN ya están filtradas.

export function chunkText(text, chunkSize = 400, overlap = 50) {
	const words = text.split(/\s+/);
	const chunks = [];
	let i = 0;
	while (i < words.length) {
		const chunk = words.slice(i, i + chunkSize).join(' ');
		if (chunk.trim().length > 50) chunks.push(chunk.trim());
		i += chunkSize - overlap;
	}
	return chunks;
}

const MODELOS_TOYOTA10 = ['HILUX', 'SW4', 'COROLLA', 'ETIOS', 'YARIS', 'YARIS CROSS', 'COROLLA CROSS'];

const SECCIONES_TOYOTA10 = [
	'Garantía Inicial —',
	'Alcance general',
	'Garantía Adicional Toyota10 —',
	'Motor',
	'Sistema de combustible',
	'Sistema de refrigeración',
	'Transmisión + transferencia 4x4',
	'Transmisión de potencia',
	'Transmisión',
	'Sistema de frenos',
	'Sistema de suspensión',
	'Ítems de seguridad',
	'Aire acondicionado',
	'Sistema de dirección',
	'Sistema híbrido — Cobertura especial',
	'Sistema híbrido',
	'Sistema eléctrico',
	'Carrocería',
	'NO CUBRE —',
	'Batería —',
];

function seccionToyota10(parrafo) {
	const candidato = SECCIONES_TOYOTA10.find((s) => parrafo.startsWith(s));
	return candidato && parrafo.length <= candidato.length + 50 ? candidato : null;
}

export function chunkGarantiaPorModelo(texto) {
	const parrafos = texto
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);

	const indicesModelo = parrafos.reduce((acc, p, i) => {
		if (MODELOS_TOYOTA10.includes(p)) acc.push(i);
		return acc;
	}, []);

	if (indicesModelo.length !== MODELOS_TOYOTA10.length) return null;

	const chunks = [parrafos.slice(0, indicesModelo[0]).join('\n')];

	for (let m = 0; m < indicesModelo.length; m++) {
		const modelo = parrafos[indicesModelo[m]];
		const fin = m + 1 < indicesModelo.length ? indicesModelo[m + 1] : parrafos.length;
		const bloque = parrafos.slice(indicesModelo[m] + 1, fin);

		const indicePrimeraSeccion = bloque.findIndex((p) => seccionToyota10(p));
		const intro = bloque.slice(0, indicePrimeraSeccion === -1 ? bloque.length : indicePrimeraSeccion);
		if (intro.length) chunks.push(`[${modelo}]\n${intro.join('\n')}`);

		let i = indicePrimeraSeccion;
		while (i !== -1 && i < bloque.length) {
			let j = i + 1;
			while (j < bloque.length && !seccionToyota10(bloque[j])) j++;
			const contenido = bloque.slice(i + 1, j).join(' ');
			chunks.push(`[${modelo}] ${bloque[i]}\n${contenido}`);
			i = j;
		}
	}

	return chunks.filter((c) => c.trim().length > 50);
}

export function chunkearPorNombreDeArchivo(fileName, texto) {
	return fileName === 'Toyota10_Garantia_por_Modelo.docx' ? chunkGarantiaPorModelo(texto) || chunkText(texto) : chunkText(texto);
}
