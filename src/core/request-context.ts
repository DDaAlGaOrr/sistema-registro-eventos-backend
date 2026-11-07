import { AsyncLocalStorage } from 'node:async_hooks';
import { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulidx';

import type { MembershipRole } from '../db/types';
import type { Permission } from './permissions';

export interface TenantInfo {
    id: number;
    slug: string;
    name: string;
    rootOrganizationId: number;
}

export interface AuthInfo {
    userId: number;
    name: string;
    email: string;
    isPlatformAdmin: boolean;
    /** null solo para el admin de plataforma fuera de un cliente. */
    role: MembershipRole | null;
    /** Asociación/iglesia a la que está limitado (null = todo el cliente). */
    scopeOrganizationId: number | null;
    permissions: ReadonlySet<Permission>;
}

export interface RequestContext {
    requestId: string;
    ip?: string;
    userAgent?: string;
    /** Cliente de la petición (X-Tenant / subdominio). */
    tenant?: TenantInfo;
    /** Usuario autenticado (V2). */
    auth?: AuthInfo;
}

const storage = new AsyncLocalStorage<RequestContext>();

const REQUEST_ID_PATTERN = /^[0-9A-Za-z-]{8,64}$/;

/**
 * Crea el contexto de la petición (request_id, IP, user-agent) y lo deja
 * disponible en cualquier capa vía getContext(), sin pasarlo por parámetros.
 * El mismo request_id se devuelve en el header X-Request-Id y se guarda en
 * audit_logs, para poder cruzar logs del servidor con la auditoría.
 */
export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : ulid();
    res.setHeader('X-Request-Id', requestId);

    storage.run(
        { requestId, ip: req.ip, userAgent: req.header('user-agent')?.slice(0, 255) },
        () => next()
    );
};

export const getContext = (): RequestContext | undefined => storage.getStore();

/** Para scripts y pruebas: ejecuta `fn` con un contexto propio. */
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);
