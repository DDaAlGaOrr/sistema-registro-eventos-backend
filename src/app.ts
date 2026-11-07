import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { sql } from 'kysely';
import { env } from './config/env';
import { router } from './routes';
import { catchAsync, errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { getContext, requestContextMiddleware } from './core/request-context';
import { logger, sanitizeUrl } from './core/logger';
import { db } from './db/client';

/** Crea la app sin levantar el servidor (las pruebas la usan directo). */
export function createApp(): Express {
    const app = express();

    // Railway (y la mayoría de hostings) ponen un proxy enfrente:
    // necesario para que el rate limit vea la IP real del cliente.
    app.set('trust proxy', 1);

    app.use(requestContextMiddleware);
    app.use(pinoHttp({
        logger,
        genReqId: () => getContext()?.requestId ?? '',
        serializers: {
            req: (req) => ({ id: req.id, method: req.method, url: sanitizeUrl(req.url) }),
            res: (res) => ({ statusCode: res.statusCode }),
        },
        // El health check lo llama Railway a cada rato: no llenar el log
        autoLogging: { ignore: (req) => req.url === '/api/health' },
    }));

    app.use(helmet());
    app.use(cors({
        origin: (origin, callback) => {
            // Peticiones sin Origin (curl, health checks, server-to-server)
            if (!origin || env.CORS_ORIGINS.includes(origin)) {
                return callback(null, true);
            }
            return callback(null, false);
        },
        exposedHeaders: ['X-Request-Id'],
    }));
    app.use(express.json({ limit: '100kb' }));

    app.get('/test', (req: Request, res: Response) => {
        res.json({
            message: '¡Hola, mundo!',
            status: 'success'
        });
    });

    app.get('/api/health', catchAsync(async () => {
        await sql`SELECT 1`.execute(db);
        return { code: 200, data: { api: 'up', db: 'up' } };
    }));

    app.use('/api', router);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
