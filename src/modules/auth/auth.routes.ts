import { Router } from 'express';
import { z } from 'zod';
import { catchAsync } from '../../middlewares/errorHandler';
import { accountLimiter, loginLimiter } from '../../middlewares/rateLimit';
import { getContext } from '../../core/request-context';
import { emailSchema, passwordSchema } from '../../core/validation';
import { db } from '../../db/client';
import { authenticate, currentAuth } from './auth.middleware';
import * as authService from './auth.service';
import * as users from '../users/users.service';
import { REFRESH_COOKIE, refreshCookieOptions } from './tokens';

const tokenSchema = z.string().trim().min(20).max(200);
const acceptSchema = z.object({ token: tokenSchema, password: passwordSchema }).strict();
const forgotSchema = z.object({ email: emailSchema }).strict();
const resetSchema = z.object({ token: tokenSchema, password: passwordSchema }).strict();

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

// ── Invitación y recuperación de contraseña (sin sesión) ───────────────

authRoutesV2.post('/invitation/accept', accountLimiter, catchAsync(async (req, res) => {
    const { token, password } = acceptSchema.parse(req.body ?? {});
    const session = await users.acceptInvitation(token, password);
    if (!session) return { code: 200, data: { message: 'Contraseña creada. Ya puedes iniciar sesión.' } };
    res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
    return { code: 200, data: sessionResponse(session) };
}));

authRoutesV2.post('/password/forgot', accountLimiter, catchAsync(async (req) => {
    const { email } = forgotSchema.parse(req.body ?? {});
    await users.requestPasswordReset(email);
    // Misma respuesta exista o no el correo
    return { code: 200, data: { message: 'Si el correo está registrado, te enviamos un enlace para cambiar tu contraseña.' } };
}));

authRoutesV2.post('/password/reset', accountLimiter, catchAsync(async (req, res) => {
    const { token, password } = resetSchema.parse(req.body ?? {});
    await users.resetPassword(token, password);
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
    return { code: 200, data: { message: 'Contraseña actualizada. Inicia sesión con tu nueva contraseña.' } };
}));
