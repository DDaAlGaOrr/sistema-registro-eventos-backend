/**
 * Columnas JSON portables entre MySQL y MariaDB.
 *
 * - MySQL guarda JSON nativo y mysql2 lo devuelve ya como objeto.
 * - MariaDB lo guarda como LONGTEXT (con CHECK json_valid) y mysql2 lo
 *   devuelve como string.
 *
 * Regla: al escribir siempre se manda toJson(valor); al leer siempre se pasa
 * por fromJson(). Así el código se comporta igual en los dos motores.
 */
export const toJson = (value: unknown): string => JSON.stringify(value ?? null);

export function fromJson<T>(value: unknown): T;
export function fromJson<T>(value: unknown, fallback: T): T;
export function fromJson<T>(value: unknown, fallback?: T): T {
    if (value === null || value === undefined) return fallback as T;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as T;
        } catch {
            return (fallback ?? value) as T;
        }
    }
    if (Buffer.isBuffer(value)) return fromJson<T>(value.toString('utf8'), fallback as T);
    return value as T;
}

/** Texto en los dos idiomas del sistema. */
export interface I18nText {
    es: string;
    en: string;
}
