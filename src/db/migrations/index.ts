import type { Migration } from 'kysely';
import * as m001 from './001_initial_schema';
import * as m002 from './002_audit_logs_append_only';

/**
 * Lista explícita de migraciones (en orden). Al crear una nueva:
 *   1. agrega el archivo NNN_descripcion.ts en esta carpeta
 *   2. regístrala aquí
 * Una lista estática funciona igual con tsx, con el build (dist) y con
 * Vitest, sin depender de leer la carpeta en disco.
 */
export const migrations: Record<string, Migration> = {
    '001_initial_schema': m001,
    '002_audit_logs_append_only': m002,
};
