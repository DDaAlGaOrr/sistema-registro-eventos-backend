/**
 * CLI de migraciones.
 *   npm run migrate          → aplica las pendientes
 *   npm run migrate:down     → revierte la última
 *   npm run migrate:status   → lista aplicadas / pendientes
 */
import { db, destroyDb } from './client';
import { assertMigrationResult, createMigrator } from './migrator';
import { env } from '../config/env';

async function main() {
    const command = process.argv[2] ?? 'latest';
    const migrator = createMigrator(db);
    console.log(`[migrate] BD: ${env.DB_NAME} @ ${env.DB_HOST}:${env.DB_PORT}`);

    if (command === 'latest') {
        const applied = assertMigrationResult(await migrator.migrateToLatest());
        console.log(applied.length ? applied.map(a => `  ✔ ${a}`).join('\n') : '  Nada pendiente.');
    } else if (command === 'down') {
        const applied = assertMigrationResult(await migrator.migrateDown());
        console.log(applied.length ? applied.map(a => `  ↩ ${a}`).join('\n') : '  Nada que revertir.');
    } else if (command === 'status') {
        for (const m of await migrator.getMigrations()) {
            console.log(`  ${m.executedAt ? '✔' : '·'} ${m.name}${m.executedAt ? `  (${m.executedAt.toISOString()})` : ''}`);
        }
    } else {
        throw new Error(`Comando desconocido: ${command} (usa latest | down | status)`);
    }
}

main()
    .catch((err) => {
        console.error(`[migrate] ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    })
    .finally(() => destroyDb());
