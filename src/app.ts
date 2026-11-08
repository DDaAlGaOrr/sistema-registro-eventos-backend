import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { sql } from 'kysely';
import { env } from './config/env';
import cookieParser from 'cookie-parser';
import { router } from './routes';
import { routerV2 } from './routes/v2';
import { catchAsync, errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { getContext, requestContextMiddleware } from './core/request-context';
import { logger, sanitizeUrl } from './core/logger';
import { db } from './db/client';
import { handleStripeWebhook } from './modules/payments/stripe-webhooks';

/**
 * Orígenes permitidos: la lista de CORS_ORIGINS y cualquier subdominio de
 * los dominios base (cada cliente tiene el suyo: pacific.tuapp.com).
 * Peticiones sin Origin (curl, health checks, server-to-server) pasan.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    if (env.CORS_ORIGINS.includes(origin)) return true;
    try {
        const { hostname, protocol } = new URL(origin);
        const isLocal = hostname === 'localhost' || hostname.endsWith('.localhost');
        // Fuera de localhost solo HTTPS
        if (protocol !== 'https:' && !(protocol === 'http:' && isLocal)) return false;
        return env.APP_BASE_DOMAINS.some(base => hostname === base || hostname.endsWith(`.${base}`));
    } catch {
        return false;
    }
}

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
        origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
        // La cookie del refresh token (V2) necesita credentials
        credentials: true,
        exposedHeaders: ['X-Request-Id'],
    }));
    // Webhook de Stripe: necesita el cuerpo crudo para verificar la firma (va antes de express.json)
    app.post('/api/v2/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), catchAsync(async (req) => ({
        code: 200, data: await handleStripeWebhook(req.body as Buffer, req.header('stripe-signature')),
    })));

    app.use(express.json({ limit: '100kb' }));
    app.use(cookieParser());

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

    app.use('/api/v2', routerV2);
    app.use('/api', router);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
