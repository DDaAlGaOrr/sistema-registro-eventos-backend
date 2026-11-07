import { Request, Response, NextFunction } from 'express';
import { TokenPayload, verifyToken } from '../services/auth.service';
import { hasPermission, Permission } from '../config/roles';

export interface AuthRequest extends Request {
    user?: TokenPayload
}

const unauthorized = (res: Response, error: string) => res.status(401).json({ status: 'error', message: error, error });

const authenticate = (token: string | undefined, req: AuthRequest, res: Response, next: NextFunction) => {
    if (!token) {
        return unauthorized(res, 'Token requerido o formato inválido');
    }
    try {
        req.user = verifyToken(token);
        next();
    } catch {
        return unauthorized(res, 'Token inválido o expirado');
    }
};

/** Exige `Authorization: Bearer <token>`. */
export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    return authenticate(token, req, res, next);
};

/**
 * Para Server-Sent Events: EventSource no puede mandar headers,
 * así que también se acepta `?token=`. Usar SOLO en la ruta del stream.
 */
export const requireAuthSse = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    return authenticate(headerToken ?? queryToken, req, res, next);
};

/** Debe ir después de requireAuth. */
export const requirePermission = (permission: Permission) =>
    (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!hasPermission(req.user?.role, permission)) {
            return res.status(403).json({ status: 'error', message: 'No tienes permiso para realizar esta acción' });
        }
        next();
    };
