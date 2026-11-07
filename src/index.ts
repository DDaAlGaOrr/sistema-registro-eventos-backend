import { env } from './config/env';
import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { router } from './routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';

const app: Express = express();
const port = env.PORT;

// Railway (y la mayoría de hostings) ponen un proxy enfrente:
// necesario para que el rate limit vea la IP real del cliente.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
    origin: (origin, callback) => {
        // Peticiones sin Origin (curl, health checks, server-to-server)
        if (!origin || env.CORS_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        return callback(null, false);
    },
}));
app.use(express.json({ limit: '100kb' }));

app.get('/test', (req: Request, res: Response) => {
    res.json({
        message: '¡Hola, mundo!',
        status: 'success'
    });
});

app.use('/api', router);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(port, () => {
    console.log(`[server]: El servidor está corriendo en http://localhost:${port}`);
});
