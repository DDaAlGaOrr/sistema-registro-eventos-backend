import bcrypt from 'bcrypt';
import { sql } from 'kysely';
import { env } from '../../config/env';
import { db } from '../../db/client';
import { recordAudit } from '../../core/audit';
import { ipToBuffer } from '../../core/ip';
import { permissionsFor } from '../../core/permissions';
import { AuthInfo, getContext, TenantInfo } from '../../core/request-context';
import { AppError } from '../../middlewares/errorHandler';
import { hashToken, newRefreshToken, signAccessToken } from './tokens';

// Hash de relleno: si el correo no existe se compara igual, para que el
// tiempo de respuesta no delate qué correos están registrados.
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', 10);

/** Si dos pestañas renuevan a la vez, la segunda usa un token recién rotado: no es robo. */
const ROTATION_GRACE_MS = 30_000;

export interface Session {
    accessToken: string;
    refreshToken: string;
    auth: AuthInfo;
}

/**
 * Usuario + membresía en el cliente. Se llama en CADA petición autenticada:
 * desactivar a alguien o cambiarle el rol aplica de inmediato.
 */
export async function loadAuthInfo(userId: number, tenant: TenantInfo | undefined): Promise<AuthInfo | 'inactive' | 'no-access'> {
    const user = await db.selectFrom('users')
        .select(['id', 'name', 'email', 'is_active', 'is_platform_admin'])
        .where('id', '=', userId)
        .executeTakeFirst();
    if (!user || !user.is_active) return 'inactive';
    const isPlatformAdmin = !!user.is_platform_admin;

    let role: AuthInfo['role'] = null;
    let scopeOrganizationId: number | null = null;
    if (tenant) {
        const membership = await db.selectFrom('tenant_memberships')
            .select(['role', 'scope_organization_id'])
            .where('tenant_id', '=', tenant.id)
            .where('user_id', '=', userId)
            .where('is_active', '=', 1)
            .executeTakeFirst();
        if (membership) {
            role = membership.role;
            scopeOrganizationId = membership.scope_organization_id;
        } else if (!isPlatformAdmin) {
            return 'no-access';
        }
    } else if (!isPlatformAdmin) {
        // Fuera de un cliente (app.tuapp.com) solo entra el admin de plataforma
        return 'no-access';
    }

    return {
        userId: user.id,
        name: user.name,
        email: user.email,
        isPlatformAdmin,
        // El admin de plataforma ve todo aunque tenga una membresía limitada
        role,
        scopeOrganizationId: isPlatformAdmin ? null : scopeOrganizationId,
        permissions: permissionsFor(role, isPlatformAdmin),
    };
}

async function issueSession(auth: AuthInfo, tenant: TenantInfo | undefined): Promise<Session> {
    const refreshToken = newRefreshToken();
    const ctx = getContext();
    await db.insertInto('user_tokens').values({
        user_id: auth.userId,
        type: 'refresh',
        token_hash: hashToken(refreshToken),
        expires_at: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        used_at: null,
        revoked_at: null,
        ip: ipToBuffer(ctx?.ip),
        user_agent: ctx?.userAgent ?? null,
    }).execute();
    return {
        accessToken: signAccessToken({ userId: auth.userId, tenantId: tenant?.id ?? null }),
        refreshToken,
        auth,
    };
}

export async function login(emailInput: string, password: string): Promise<Session> {
    const tenant = getContext()?.tenant;
    const email = emailInput.trim();
    const user = await db.selectFrom('users')
        .select(['id', 'name', 'password_hash', 'is_active', 'failed_login_count', 'locked_until'])
        .where('email', '=', email)
        .executeTakeFirst();

    const failed = async (reason: string, status = 401, message = 'Credenciales incorrectas') => {
        await recordAudit(db, {
            action: 'auth.login_failed', entityType: 'user', entityId: user?.id ?? null,
            actorType: 'user', actorUserId: user?.id ?? null, actorName: user?.name ?? null,
            metadata: { email, reason },
        });
        throw new AppError(status, message);
    };

    if (user?.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        const minutes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
        await bcrypt.compare(password, DUMMY_HASH);
        return failed('locked', 423, `Cuenta bloqueada por intentos fallidos. Intenta de nuevo en ${minutes} min.`);
    }

    const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
        if (user) {
            const attempts = user.failed_login_count + 1;
            const lock = attempts >= env.LOGIN_MAX_ATTEMPTS;
            await db.updateTable('users').set({
                failed_login_count: lock ? 0 : attempts,
                locked_until: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : null,
            }).where('id', '=', user.id).execute();
        }
        return failed(user ? 'wrong_password' : 'unknown_email');
    }
    if (!user.is_active) return failed('inactive');

    const auth = await loadAuthInfo(user.id, tenant);
    if (auth === 'inactive') return failed('inactive');
    if (auth === 'no-access') return failed('no_membership', 403, 'No tienes acceso a este cliente');

    await db.updateTable('users').set({
        failed_login_count: 0, locked_until: null, last_login_at: new Date(),
    }).where('id', '=', user.id).execute();

    const ctx = getContext();
    if (ctx) ctx.auth = auth;
    const session = await issueSession(auth, tenant);
    await recordAudit(db, { action: 'auth.login', entityType: 'user', entityId: user.id });
    return session;
}

export async function refresh(refreshToken: string | undefined): Promise<Session> {
    if (!refreshToken) throw new AppError(401, 'Sesión expirada');
    const tenant = getContext()?.tenant;

    const row = await db.selectFrom('user_tokens')
        .select(['id', 'user_id', 'expires_at', 'revoked_at', 'used_at'])
        .where('token_hash', '=', hashToken(refreshToken))
        .where('type', '=', 'refresh')
        .executeTakeFirst();
    if (!row) throw new AppError(401, 'Sesión expirada');

    if (row.revoked_at) {
        const rotatedRecently = row.used_at && Date.now() - new Date(row.used_at).getTime() < ROTATION_GRACE_MS;
        if (!rotatedRecently) {
            // Alguien reutilizó un token ya rotado: posible robo. Se cierran todas sus sesiones.
            await db.updateTable('user_tokens').set({ revoked_at: new Date() })
                .where('user_id', '=', row.user_id).where('type', '=', 'refresh').where('revoked_at', 'is', null)
                .execute();
            await recordAudit(db, {
                action: 'auth.refresh_token_reused', entityType: 'user', entityId: row.user_id,
                actorType: 'user', actorUserId: row.user_id,
            });
        }
        throw new AppError(401, 'Sesión expirada');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) throw new AppError(401, 'Sesión expirada');

    const auth = await loadAuthInfo(row.user_id, tenant);
    if (auth === 'inactive' || auth === 'no-access') {
        await db.updateTable('user_tokens').set({ revoked_at: new Date() }).where('id', '=', row.id).execute();
        throw new AppError(auth === 'inactive' ? 401 : 403, auth === 'inactive' ? 'Sesión expirada' : 'No tienes acceso a este cliente');
    }

    // Rotación: el token usado deja de servir y se emite uno nuevo
    const updated = await db.updateTable('user_tokens')
        .set({ revoked_at: new Date(), used_at: new Date() })
        .where('id', '=', row.id).where('revoked_at', 'is', null)
        .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw new AppError(401, 'Sesión expirada');

    const ctx = getContext();
    if (ctx) ctx.auth = auth;
    return issueSession(auth, tenant);
}

export async function logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const row = await db.selectFrom('user_tokens').select(['id', 'user_id'])
        .where('token_hash', '=', hashToken(refreshToken)).where('type', '=', 'refresh')
        .executeTakeFirst();
    if (!row) return;
    await db.updateTable('user_tokens').set({ revoked_at: sql`COALESCE(revoked_at, UTC_TIMESTAMP())` as any })
        .where('id', '=', row.id).execute();
    await recordAudit(db, {
        action: 'auth.logout', entityType: 'user', entityId: row.user_id, actorType: 'user', actorUserId: row.user_id,
    });
}
