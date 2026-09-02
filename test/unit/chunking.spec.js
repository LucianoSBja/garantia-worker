import { describe, it, expect } from 'vitest';
import { chunkText, chunkGarantiaPorModelo, chunkearPorNombreDeArchivo } from '../../src/chunking.js';

describe('chunkText', () => {
	it('parte en bloques de chunkSize palabras con overlap', () => {
		const texto = Array.from({ length: 900 }, (_, i) => `palabra${i}`).join(' ');
		const chunks = chunkText(texto, 400, 50);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].split(' ')).toHaveLength(400);
		// El segundo chunk arranca 350 palabras después del primero (400 - 50 de overlap).
		expect(chunks[1].split(' ')[0]).toBe('palabra350');
	});

	it('descarta chunks de 50 caracteres o menos', () => {
		const chunks = chunkText('una frase corta', 400, 50);
		expect(chunks).toEqual([]);
	});

	it('un texto vacío no genera chunks', () => {
		expect(chunkText('', 400, 50)).toEqual([]);
	});
});

describe('chunkGarantiaPorModelo', () => {
	const MODELOS = ['HILUX', 'SW4', 'COROLLA', 'ETIOS', 'YARIS', 'YARIS CROSS', 'COROLLA CROSS'];

	function documentoDePrueba() {
		const intro = 'TOYOTA\n\nGarantía Oficial Limitada\n\nPROGRAMA TOYOTA10';
		const secciones = MODELOS.map(
			(modelo) =>
				`${modelo}\n\nDescripción del modelo y línea de motor.\n\nMotor\n\nCobertura de motor con más de cincuenta caracteres de texto real acá.\n\nCarrocería\n\nCobertura de carrocería, con cerraduras y otras piezas, más de cincuenta caracteres.`
		);
		return [intro, ...secciones].join('\n\n');
	}

	it('genera chunks por modelo y sección cuando la estructura calza (7 modelos)', () => {
		const chunks = chunkGarantiaPorModelo(documentoDePrueba());

		expect(chunks).not.toBeNull();
		// Al menos un chunk por modelo debe traer el modelo como prefijo.
		for (const modelo of MODELOS) {
			expect(chunks.some((c) => c.startsWith(`[${modelo}]`))).toBe(true);
		}
	});

	it('un párrafo de contenido que arranca con el nombre de otra sección no se confunde con su encabezado', () => {
		// Caso real documentado en CLAUDE.md: el contenido de "Sistema eléctrico"
		// empieza con "Motor de arranque...", que sin el tope de longitud
		// matcheaba como si fuera la sección "Motor".
		const intro = 'TOYOTA\n\nGarantía Oficial Limitada';
		const bloque = MODELOS.map(
			(modelo) =>
				`${modelo}\n\nDescripción del modelo.\n\nSistema eléctrico\n\nMotor de arranque, alternador, batería y cableado general del vehículo con detalle extenso.\n\nCarrocería\n\nCobertura de carrocería con más de cincuenta caracteres de texto de prueba acá.`
		);
		const chunks = chunkGarantiaPorModelo([intro, ...bloque].join('\n\n'));

		expect(chunks).not.toBeNull();
		// El contenido de "Motor de arranque..." tiene que quedar DENTRO del
		// chunk de "Sistema eléctrico", no como un chunk de sección "Motor".
		expect(chunks.some((c) => c.startsWith('[HILUX] Motor\n'))).toBe(false);
		const chunkElectrico = chunks.find((c) => c.startsWith('[HILUX] Sistema eléctrico'));
		expect(chunkElectrico).toBeDefined();
		expect(chunkElectrico).toContain('Motor de arranque');
	});

	it('devuelve null si no hay exactamente los 7 modelos esperados', () => {
		const texto = 'HILUX\n\nAlgo\n\nSW4\n\nOtra cosa';
		expect(chunkGarantiaPorModelo(texto)).toBeNull();
	});

	it('devuelve null con texto sin ninguna estructura de modelos', () => {
		expect(chunkGarantiaPorModelo('Texto cualquiera sin estructura de garantía por modelo.')).toBeNull();
	});
});

describe('chunkearPorNombreDeArchivo', () => {
	it('usa el chunker estructural solo para Toyota10_Garantia_por_Modelo.docx', () => {
		const texto = Array.from({ length: 500 }, (_, i) => `palabra${i}`).join(' ');
		const generico = chunkearPorNombreDeArchivo('otro-archivo.pdf', texto);
		expect(generico.length).toBeGreaterThan(0);
		expect(generico[0].split(' ')).toHaveLength(400);
	});

	it('cae al chunking genérico si el archivo especial no tiene la estructura esperada', () => {
		const texto = Array.from({ length: 500 }, (_, i) => `palabra${i}`).join(' ');
		const chunks = chunkearPorNombreDeArchivo('Toyota10_Garantia_por_Modelo.docx', texto);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].split(' ')).toHaveLength(400);
	});
});
