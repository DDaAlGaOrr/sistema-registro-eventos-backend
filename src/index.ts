import { env } from './config/env';
import { createApp } from './app';
import { logger } from './core/logger';
import { destroyDb } from './db/client';

const app = createApp();

const server = app.listen(env.PORT, () => {
    logger.info(`[server]: El servidor está corriendo en http://localhost:${env.PORT}`);
});

// Cierre ordenado (Railway manda SIGTERM al redeployar)
const shutdown = (signal: string) => {
    logger.info(`${signal} recibido, cerrando servidor...`);
    server.close(async () => {
        await destroyDb().catch(() => undefined);
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
