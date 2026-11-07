import { Kysely, MysqlDialect } from 'kysely';
import mysql from 'mysql2/promise';
import { createPool } from 'mysql2';
import { createMigrator, assertMigrationResult } from '../src/db/migrator';
import { TEST_DB_NAME, testDbConnection } from './test-db';

/**
 * Antes de todas las pruebas: recrea la BD de pruebas desde cero y prueba
 * las migraciones completas en los dos sentidos (up → down → up).
 */
export default async function setup() {
    const admin = await mysql.createConnection(testDbConnection);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.end();

    const pool = createPool({ ...testDbConnection, database: TEST_DB_NAME, timezone: 'Z', connectionLimit: 2 });
    const db = new Kysely<any>({ dialect: new MysqlDialect({ pool }) });
    try {
        const migrator = createMigrator(db);
        assertMigrationResult(await migrator.migrateToLatest());
        const all = await migrator.getMigrations();
        for (let i = 0; i < all.length; i++) {
            assertMigrationResult(await migrator.migrateDown());
        }
        assertMigrationResult(await migrator.migrateToLatest());
    } finally {
        await db.destroy();
    }
}
