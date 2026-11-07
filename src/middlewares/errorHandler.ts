import { Request, Response, NextFunction, RequestHandler } from 'express';

export class AppError extends Error {
    constructor(
        public statusCode: number,
        public message: string
    ) {
        super(message);
        this.name = 'AppError';
    }
}

export const errorHandler = (
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            status: 'error',
            message: err.message,
        });
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
                if (result !== undefined) {
                    const statusCode = result.code || 200;
                    const data = result.code ? result.data : result;

                    res.status(statusCode).json({ status: 'ok', data });
                }
            })
            .catch(next); // Equivale a .catch(err => next(err))
    };
};