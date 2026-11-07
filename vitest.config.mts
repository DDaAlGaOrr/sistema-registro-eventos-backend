import { defineConfig } from 'vitest/config';
import { TEST_DB_NAME } from './test/test-db';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        globalSetup: ['test/global-setup.ts'],
        env: {
            DB_NAME: TEST_DB_NAME,
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            LOG_PRETTY: 'false',
            JWT_SECRET: 'secreto-solo-para-pruebas-automatizadas-123456',
            // Nunca mandar correos reales desde las pruebas
            EMAIL_USER: '',
            EMAIL_PASS: '',
        },
        // Comparten la misma BD: un archivo a la vez
        fileParallelism: false,
        testTimeout: 20_000,
        hookTimeout: 60_000,
    },
});
