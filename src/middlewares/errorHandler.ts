import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
    constructor(
        public statusCode: number,
        public message: string,
        public details?: unknown
    ) {
        super(message);
        this.name = 'AppError';
    }
}

export const notFoundHandler = (req: Request, res: Response) => {
    res.status(404).json({ status: 'error', message: 'Ruta no encontrada' });
};

export const errorHandler = (
    err: any,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (res.headersSent) {
        return next(err);
    }

    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            status: 'error',
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
        });
    }

    if (err instanceof ZodError) {
        return res.status(400).json({
            status: 'error',
            message: 'Datos inválidos',
            details: err.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        });
    }

    // JSON mal formado en el body
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ status: 'error', message: 'JSON inválido' });
    }
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ status: 'error', message: 'El cuerpo de la petición es demasiado grande' });
    }

    console.error(err);
    return res.status(500).json({
        status: 'error',
        message: 'Internal server error',
    });
};

export const catchAsync = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler => {
    return (req, res, next) => {
        fn(req, res, next)
            .then((result) => {
                // Si el handler ya respondió (ej. SSE), no volver a responder
                if (result === undefined || res.headersSent) return;
                const statusCode = result.code || 200;
                const data = result.code ? result.data : result;
                res.status(statusCode).json({ status: 'ok', data });
            })
            .catch(next);
    };
};

/** Convierte un parámetro de ruta en id numérico o lanza 400. */
export const parseId = (value: unknown, name = 'id'): number => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        throw new AppError(400, `El parámetro ${name} no es válido`);
    }
    return id;
};
