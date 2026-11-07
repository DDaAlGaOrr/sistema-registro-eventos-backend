import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

/** Audiencia de los tokens V2 (los de V1 no la tienen y se rechazan aquí). */
const AUDIENCE = 'v2';

export interface AccessTokenClaims {
    userId: number;
    /** Cliente para el que se emitió (null = panel de plataforma). */
    tenantId: number | null;
}

export function signAccessToken({ userId, tenantId }: AccessTokenClaims): string {
    return jwt.sign({ tid: tenantId }, env.JWT_SECRET, {
        algorithm: 'HS256',
        audience: AUDIENCE,
        subject: String(userId),
        expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], audience: AUDIENCE }) as jwt.JwtPayload;
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('Token sin usuario');
    return { userId, tenantId: typeof payload.tid === 'number' ? payload.tid : null };
}

/** Refresh token opaco: se le da al navegador en cookie; en la BD solo va su hash. */
export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const REFRESH_COOKIE = 'rt';
export const REFRESH_COOKIE_PATH = '/api/v2/auth';

export const refreshCookieOptions = () => ({
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
});
