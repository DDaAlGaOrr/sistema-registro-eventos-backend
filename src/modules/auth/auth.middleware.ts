import { NextFunction, Request, Response } from 'express';
import { getContext } from '../../core/request-context';
import type { Permission } from '../../core/permissions';
import { AppError } from '../../middlewares/errorHandler';
import { loadAuthInfo } from './auth.service';
import { verifyAccessToken } from './tokens';

/**
 * Exige `Authorization: Bearer <access token V2>`. El token debe ser del
 * mismo cliente de la petición, y el usuario/membresía se revisan en la BD.
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const header = req.header('authorization');
        const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        if (!token) throw new AppError(401, 'Token requerido');

        let claims;
        try {
            claims = verifyAccessToken(token);
        } catch {
            throw new AppError(401, 'Token inválido o expirado');
        }

        const ctx = getContext();
        if (claims.tenantId !== (ctx?.tenant?.id ?? null)) {
            throw new AppError(401, 'La sesión pertenece a otro cliente');
        }

        const auth = await loadAuthInfo(claims.userId, ctx?.tenant);
        if (auth === 'inactive') throw new AppError(401, 'Usuario inactivo');
        if (auth === 'no-access') throw new AppError(403, 'No tienes acceso a este cliente');
        if (ctx) ctx.auth = auth;
        next();
    } catch (err) {
        next(err);
    }
};

/** Debe ir después de authenticate. */
export const requirePermission = (permission: Permission) =>
    (req: Request, res: Response, next: NextFunction) => {
        if (!getContext()?.auth?.permissions.has(permission)) {
            return next(new AppError(403, 'No tienes permiso para realizar esta acción'));
        }
        next();
    };

/** El contexto de auth ya validado (usar solo en rutas con authenticate). */
export const currentAuth = () => {
    const auth = getContext()?.auth;
    if (!auth) throw new AppError(401, 'No autenticado');
    return auth;
};
