import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env';
import { db } from '../../db/client';
import type { MembershipRole } from '../../db/types';
import { diff, recordAudit } from '../../core/audit';
import { frontUrl, sendMail } from '../../core/mailer';
import { getContext } from '../../core/request-context';
import { assertManageableOrganization, manageableOrganizationIds } from '../../core/tenant-tree';
import { AppError } from '../../middlewares/errorHandler';
import { currentAuth } from '../auth/auth.middleware';
import { issueSession, loadAuthInfo, Session } from '../auth/auth.service';
import { hashToken, newRefreshToken } from '../auth/tokens';
import { getBranding } from '../tenants/tenant.service';
import { addedToTenantEmail, invitationEmail, passwordResetEmail } from './user-emails';

export interface Member {
    userId: number;
    name: string;
    email: string;
    role: MembershipRole;
    scope: { id: number; name: string; type: string } | null;
    isActive: boolean;
    invitationPending: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
}

const requireTenant = () => {
    const tenant = getContext()?.tenant;
    if (!tenant) throw new AppError(400, 'Falta indicar el cliente');
    return tenant;
};

/** Hash de una contraseña aleatoria que nadie conoce: la cuenta no sirve hasta aceptar la invitación. */
const unusablePasswordHash = () => bcrypt.hash(randomBytes(32).toString('hex'), 10);

function membersQuery(tenantId: number) {
    return db.selectFrom('tenant_memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .leftJoin('organizations as o', 'o.id', 'm.scope_organization_id')
        .select([
            'u.id as user_id', 'u.name', 'u.email', 'u.must_change_password', 'u.last_login_at',
            'm.role', 'm.is_active', 'm.created_at', 'm.scope_organization_id',
            'o.name as scope_name', 'o.type as scope_type',
        ])
        .where('m.tenant_id', '=', tenantId);
}

type MemberRow = Awaited<ReturnType<ReturnType<typeof membersQuery>['executeTakeFirstOrThrow']>>;

const toMember = (r: MemberRow): Member => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    scope: r.scope_organization_id ? { id: r.scope_organization_id, name: r.scope_name!, type: r.scope_type! } : null,
    isActive: !!r.is_active,
    invitationPending: !!r.must_change_password,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
    createdAt: new Date(r.created_at),
});

/** Un owner limitado a una asociación solo ve/gestiona miembros dentro de ella. */
async function visibleScopeIds(): Promise<number[] | null> {
    return currentAuth().scopeOrganizationId ? manageableOrganizationIds() : null;
}

export async function listMembers(): Promise<Member[]> {
    const tenant = requireTenant();
    let query = membersQuery(tenant.id);
    const scopeIds = await visibleScopeIds();
    if (scopeIds) query = query.where('m.scope_organization_id', 'in', scopeIds);
    const rows = await query.orderBy('u.name').execute();
    return rows.map(toMember);
}

async function getMember(userId: number): Promise<Member> {
    const tenant = requireTenant();
    let query = membersQuery(tenant.id).where('u.id', '=', userId);
    const scopeIds = await visibleScopeIds();
    if (scopeIds) query = query.where('m.scope_organization_id', 'in', scopeIds);
    const row = await query.executeTakeFirst();
    if (!row) throw new AppError(404, 'Usuario no encontrado');
    return toMember(row);
}

/** Valida el alcance pedido: dentro del cliente/alcance del que invita y solo asociación o iglesia. */
async function validateScope(scopeOrganizationId: number | null): Promise<void> {
    const actorScoped = !!currentAuth().scopeOrganizationId;
    if (scopeOrganizationId === null) {
        if (actorScoped) throw new AppError(403, 'Solo puedes asignar usuarios dentro de tu asociación');
        return;
    }
    await assertManageableOrganization(scopeOrganizationId);
    const org = await db.selectFrom('organizations').select('type').where('id', '=', scopeOrganizationId).executeTakeFirstOrThrow();
    if (org.type === 'union') throw new AppError(400, 'El alcance debe ser una asociación o una iglesia (para toda la unión, déjalo vacío)');
}

async function createToken(userId: number, type: 'invite' | 'password_reset', ttlMs: number, executor = db): Promise<string> {
    const token = newRefreshToken();
    await executor.updateTable('user_tokens').set({ revoked_at: new Date() })
        .where('user_id', '=', userId).where('type', '=', type)
        .where('used_at', 'is', null).where('revoked_at', 'is', null)
        .execute();
    await executor.insertInto('user_tokens').values({
        user_id: userId, type, token_hash: hashToken(token), expires_at: new Date(Date.now() + ttlMs),
        used_at: null, revoked_at: null, ip: null, user_agent: null,
    }).execute();
    return token;
}

async function sendInvitation(userId: number, email: string, name: string, token: string) {
    const tenant = requireTenant();
    const { brand, locale, slug } = await getBranding(tenant.id);
    await sendMail(invitationEmail({
        brand, locale, to: email, name, inviterName: currentAuth().name,
        url: frontUrl(slug, `/invitacion?token=${token}`), days: env.INVITE_TTL_DAYS,
    }), { tenantId: tenant.id, template: 'user_invitation', locale });
}

export interface InviteInput {
    email: string;
    name: string;
    role: MembershipRole;
    scopeOrganizationId: number | null;
}

export async function inviteUser(input: InviteInput): Promise<Member> {
    const tenant = requireTenant();
    await validateScope(input.scopeOrganizationId);
    const passwordHash = await unusablePasswordHash();

    const result = await db.transaction().execute(async (trx) => {
        const existing = await trx.selectFrom('users').select(['id', 'name', 'must_change_password'])
            .where('email', '=', input.email).executeTakeFirst();
        let userId: number;
        let isNewUser = false;
        let token: string | null = null;

        if (existing) {
            userId = existing.id;
            const membership = await trx.selectFrom('tenant_memberships').select(['id', 'is_active'])
                .where('tenant_id', '=', tenant.id).where('user_id', '=', userId).executeTakeFirst();
            if (membership?.is_active) throw new AppError(409, 'Esa persona ya tiene acceso a este cliente');
            if (membership) {
                await trx.updateTable('tenant_memberships')
                    .set({ role: input.role, scope_organization_id: input.scopeOrganizationId, is_active: 1 })
                    .where('id', '=', membership.id).execute();
            } else {
                await trx.insertInto('tenant_memberships').values({
                    tenant_id: tenant.id, user_id: userId, role: input.role,
                    scope_organization_id: input.scopeOrganizationId, is_active: 1, created_by: currentAuth().userId,
                }).execute();
            }
            // Si nunca activó su cuenta, se le manda de nuevo la invitación
            if (existing.must_change_password) token = await createToken(userId, 'invite', env.INVITE_TTL_DAYS * 86_400_000, trx);
        } else {
            isNewUser = true;
            userId = Number((await trx.insertInto('users').values({
                name: input.name, email: input.email, password_hash: passwordHash,
                is_platform_admin: 0, is_active: 1, must_change_password: 1, locked_until: null, last_login_at: null,
            }).executeTakeFirstOrThrow()).insertId);
            await trx.insertInto('tenant_memberships').values({
                tenant_id: tenant.id, user_id: userId, role: input.role,
                scope_organization_id: input.scopeOrganizationId, is_active: 1, created_by: currentAuth().userId,
            }).execute();
            token = await createToken(userId, 'invite', env.INVITE_TTL_DAYS * 86_400_000, trx);
        }

        await recordAudit(trx, {
            action: 'user.invited', entityType: 'user', entityId: userId,
            metadata: { email: input.email, role: input.role, scopeOrganizationId: input.scopeOrganizationId, isNewUser },
        });
        return { userId, token, name: existing?.name ?? input.name };
    });

    if (result.token) {
        await sendInvitation(result.userId, input.email, result.name, result.token);
    } else {
        const { brand, locale, slug } = await getBranding(tenant.id);
        await sendMail(addedToTenantEmail({
            brand, locale, to: input.email, name: result.name, inviterName: currentAuth().name, url: frontUrl(slug, '/login'),
        }), { tenantId: tenant.id, template: 'user_added', locale });
    }
    return getMember(result.userId);
}

export async function resendInvitation(userId: number): Promise<void> {
    const member = await getMember(userId);
    if (!member.invitationPending) throw new AppError(409, 'Esta persona ya activó su cuenta');
    const token = await createToken(userId, 'invite', env.INVITE_TTL_DAYS * 86_400_000);
    await recordAudit(db, { action: 'user.invitation_resent', entityType: 'user', entityId: userId });
    await sendInvitation(userId, member.email, member.name, token);
}

export interface MemberUpdate {
    role?: MembershipRole;
    scopeOrganizationId?: number | null;
    isActive?: boolean;
}

export async function updateMember(userId: number, input: MemberUpdate): Promise<Member> {
    const tenant = requireTenant();
    const auth = currentAuth();
    if (userId === auth.userId) throw new AppError(400, 'No puedes cambiar tu propio rol, alcance o estado');

    const before = await getMember(userId);
    if (input.scopeOrganizationId !== undefined) await validateScope(input.scopeOrganizationId);

    const after = {
        role: input.role ?? before.role,
        scopeOrganizationId: input.scopeOrganizationId !== undefined ? input.scopeOrganizationId : before.scope?.id ?? null,
        isActive: input.isActive ?? before.isActive,
    };

    // Nunca dejar al cliente sin un owner activo con acceso a todo
    const wasFullOwner = before.isActive && before.role === 'owner' && !before.scope;
    const staysFullOwner = after.isActive && after.role === 'owner' && after.scopeOrganizationId === null;
    if (wasFullOwner && !staysFullOwner) {
        const others = await db.selectFrom('tenant_memberships').select(eb => eb.fn.countAll<number>().as('n'))
            .where('tenant_id', '=', tenant.id).where('role', '=', 'owner').where('is_active', '=', 1)
            .where('scope_organization_id', 'is', null).where('user_id', '!=', userId)
            .executeTakeFirstOrThrow();
        if (Number(others.n) === 0) throw new AppError(409, 'El cliente debe tener al menos un owner activo con acceso a todo');
    }

    const changes = diff(
        { role: before.role, scopeOrganizationId: before.scope?.id ?? null, isActive: before.isActive },
        after
    );
    if (!changes) return before;

    await db.transaction().execute(async (trx) => {
        await trx.updateTable('tenant_memberships').set({
            role: after.role, scope_organization_id: after.scopeOrganizationId, is_active: after.isActive ? 1 : 0,
        }).where('tenant_id', '=', tenant.id).where('user_id', '=', userId).execute();
        await recordAudit(trx, { action: 'membership.updated', entityType: 'user', entityId: userId, changes });
    });
    return getMember(userId);
}

// ── Flujos públicos (sin sesión) ───────────────────────────────────────

async function findValidToken(token: string, type: 'invite' | 'password_reset') {
    const row = await db.selectFrom('user_tokens').select(['id', 'user_id', 'expires_at', 'used_at', 'revoked_at'])
        .where('token_hash', '=', hashToken(token)).where('type', '=', type).executeTakeFirst();
    if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) {
        throw new AppError(400, type === 'invite'
            ? 'La invitación no es válida o ya venció. Pide que te la envíen de nuevo.'
            : 'El enlace no es válido o ya venció. Solicita uno nuevo.');
    }
    return row;
}

/** Crea la contraseña y, si tiene acceso a este cliente, inicia sesión. */
export async function acceptInvitation(token: string, password: string): Promise<Session | null> {
    const row = await findValidToken(token, 'invite');
    const passwordHash = await bcrypt.hash(password, 12);
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('users').set({
            password_hash: passwordHash, must_change_password: 0, failed_login_count: 0, locked_until: null,
        }).where('id', '=', row.user_id).execute();
        await trx.updateTable('user_tokens').set({ used_at: new Date() }).where('id', '=', row.id).execute();
        await recordAudit(trx, {
            action: 'user.invitation_accepted', entityType: 'user', entityId: row.user_id,
            actorType: 'user', actorUserId: row.user_id,
        });
    });

    const auth = await loadAuthInfo(row.user_id, getContext()?.tenant);
    if (auth === 'inactive' || auth === 'no-access') return null;
    const ctx = getContext();
    if (ctx) ctx.auth = auth;
    return issueSession(auth, ctx?.tenant);
}

/** Siempre responde igual (no delata qué correos existen). */
export async function requestPasswordReset(email: string): Promise<void> {
    const tenant = getContext()?.tenant;
    const user = await db.selectFrom('users').select(['id', 'name', 'email', 'is_active'])
        .where('email', '=', email).executeTakeFirst();
    if (!user || !user.is_active) return;

    // Solo se manda con la marca de un cliente al que pertenece
    const auth = await loadAuthInfo(user.id, tenant);
    if (auth === 'inactive' || auth === 'no-access') return;

    const token = await createToken(user.id, 'password_reset', env.PASSWORD_RESET_TTL_MINUTES * 60_000);
    await recordAudit(db, {
        action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id,
        actorType: 'user', actorUserId: user.id, actorName: user.name,
    });
    const { brand, locale, slug } = await getBranding(tenant?.id ?? null);
    await sendMail(passwordResetEmail({
        brand, locale, to: user.email, name: user.name,
        url: frontUrl(slug, `/restablecer?token=${token}`), minutes: env.PASSWORD_RESET_TTL_MINUTES,
    }), { tenantId: tenant?.id ?? null, template: 'password_reset', locale });
}

/** Cambia la contraseña y cierra todas las sesiones abiertas de esa persona. */
export async function resetPassword(token: string, password: string): Promise<void> {
    const row = await findValidToken(token, 'password_reset');
    const passwordHash = await bcrypt.hash(password, 12);
    await db.transaction().execute(async (trx) => {
        await trx.updateTable('users').set({
            password_hash: passwordHash, must_change_password: 0, failed_login_count: 0, locked_until: null,
        }).where('id', '=', row.user_id).execute();
        await trx.updateTable('user_tokens').set({ used_at: new Date() }).where('id', '=', row.id).execute();
        await trx.updateTable('user_tokens').set({ revoked_at: new Date() })
            .where('user_id', '=', row.user_id).where('type', 'in', ['refresh', 'password_reset'])
            .where('revoked_at', 'is', null).where('used_at', 'is', null)
            .execute();
        await recordAudit(trx, {
            action: 'auth.password_reset', entityType: 'user', entityId: row.user_id,
            actorType: 'user', actorUserId: row.user_id,
        });
    });
}
