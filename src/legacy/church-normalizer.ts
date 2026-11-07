/**
 * Normaliza los nombres de iglesia escritos a mano en V1 (typos, variantes).
 * Se usa en el endpoint /churches de V1 y para construir el catálogo de
 * iglesias de V2 al migrar FEJA 2026.
 */
export function normalizarIglesia(nombreCrudo: string): string {
    if (!nombreCrudo) return 'Desconocida';

    const nombre = nombreCrudo.toLowerCase().trim();

    if (nombre.includes('maranatha') || nombre.includes('maranata') || nombre.includes('marantha')) {
        if (nombre.includes('las vegas')) return 'Maranatha Las Vegas';
        if (nombre.includes('san josé') || nombre.includes('san jose')) return 'San José Maranatha';
        return 'Maranatha SDA';
    }

    if (nombre.includes('central valley') || nombre.includes('central bali')) return 'Phoenix Central Valley';
    if (nombre.includes('north valley') || nombre.includes('nort valley') || nombre.includes('norvali')) return 'North Valley Spanish';
    if (nombre.includes('san diego central') || nombre.includes('san diego cental')) return 'San Diego Central';
    if (nombre.includes('san diego spanish') || nombre.includes('san diego eta')) return 'San Diego Spanish';
    if (nombre.includes('san bernardino')) return 'San Bernardino Spanish';
    if (nombre.includes('phoenix spanish central') || nombre.includes('central spanish') || nombre.includes('central hispana') || nombre.includes('phoenix central spanish')) return 'Phoenix Central Spanish';
    if (nombre.includes('shalom') || nombre.includes('sholom')) return 'Shalom SDA';
    if (nombre.includes('avondale')) return 'Avondale Spanish';
    if (nombre.includes('mesa')) return 'Mesa Hispanic';
    if (nombre.includes('peoria')) return 'Peoria Spanish';
    if (nombre.includes('west valley')) return 'West Valley';
    if (nombre.includes('san luis')) return 'San Luis AZ';
    if (nombre.includes('paraiso') || nombre.includes('paraíso')) {
        return 'Paraíso SDA'; 
    }
    if (nombre.includes('paradise')) {
        return 'Paradise Valley SDA'; 
    }
    if (nombre.includes('faro')) return 'Faro del Este';
    if (nombre.includes('napa')) return 'Napa Valley';
    if (nombre.includes('mountain view')) return 'Mountain View Hispana';
    if (nombre.includes('fil am') || nombre.includes('fil-am')) return 'Living Water Fil-Am';

    let nombreFormateado = nombre.split(' ').map(palabra => {
        if (palabra.length === 0) return '';
        return palabra.charAt(0).toUpperCase() + palabra.slice(1);
    }).join(' ');

    nombreFormateado = nombreFormateado.replace(/\bsda\b/ig, 'SDA');
    nombreFormateado = nombreFormateado.replace(/\bDel\b/g, 'del').replace(/\bDe\b/g, 'de').replace(/\bA\b/g, 'a');

    return nombreFormateado;
}