import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { env } from '../config/env';
import type { Database } from './types';

/**
 * Pool de la V2. Todo en UTC: la sesión de MySQL/MariaDB se fija a +00:00 y
 * mysql2 interpreta las fechas como UTC. (La V1 usa su propio pool en
 * src/conection con -07:00; no se mezclan.)
 */
export const pool = createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
    supportBigNumbers: true,
});

pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
});

export const db = new Kysely<Database>({
    dialect: new MysqlDialect({ pool }),
});

export const destroyDb = () => db.destroy();
