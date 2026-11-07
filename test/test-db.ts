import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Nombre de la BD de pruebas. Siempre termina en "_test" para que nunca se
 * borre por error la BD de desarrollo.
 */
export const TEST_DB_NAME = process.env.TEST_DB_NAME || `${process.env.DB_NAME || 'registro_eventos'}_test`;

if (!/_test$/.test(TEST_DB_NAME)) {
    throw new Error(`La BD de pruebas debe terminar en "_test" (se recibió "${TEST_DB_NAME}").`);
}

export const testDbConnection = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
};
