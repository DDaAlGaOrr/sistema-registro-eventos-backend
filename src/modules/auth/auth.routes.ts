import { Router } from 'express';
import { z } from 'zod';
import { catchAsync } from '../../middlewares/errorHandler';
import { loginLimiter } from '../../middlewares/rateLimit';
import { getContext } from '../../core/request-context';
import { db } from '../../db/client';
import { authenticate, currentAuth } from './auth.middleware';
import * as authService from './auth.service';
import { REFRESH_COOKIE, refreshCookieOptions } from './tokens';

const loginSchema = z.object({
    email: z.string().trim().min(1, 'El correo es obligatorio').max(150),
    password: z.string().min(1, 'La contraseña es obligatoria').max(200),
});

const sessionResponse = (session: authService.Session) => ({
    accessToken: session.accessToken,
    ...describeAuth(session.auth),
});

const describeAuth = (auth: authService.Session['auth']) => ({
    user: { id: auth.userId, name: auth.name, email: auth.email, isPlatformAdmin: auth.isPlatformAdmin },
    tenant: getContext()?.tenant ?? null,
    role: auth.role,
    scopeOrganizationId: auth.scopeOrganizationId,
    permissions: [...auth.permissions].sort(),
});

export const authRoutesV2 = Router();

authRoutesV2.post('/login', loginLimiter, catchAsync(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body ?? {});
    const session = await authService.login(email, password);
    res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
    return { code: 200, data: sessionResponse(session) };
}));

authRoutesV2.post('/refresh', catchAsync(async (req, res) => {
    try {
        const session = await authService.refresh(req.cookies?.[REFRESH_COOKIE]);
        res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
        return { code: 200, data: sessionResponse(session) };
    } catch (err) {
        res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
        throw err;
    }
}));

authRoutesV2.post('/logout', catchAsync(async (req, res) => {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
    return { code: 200, data: { message: 'Sesión cerrada' } };
}));

authRoutesV2.get('/me', authenticate, catchAsync(async () => {
    const auth = currentAuth();
    const scope = auth.scopeOrganizationId
        ? await db.selectFrom('organizations').select(['id', 'name', 'type', 'short_name'])
            .where('id', '=', auth.scopeOrganizationId).executeTakeFirst()
        : null;
    return { code: 200, data: { ...describeAuth(auth), scope: scope ?? null } };
}));
