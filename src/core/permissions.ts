import type { MembershipRole } from '../db/types';

/**
 * Permisos de V2. La API decide con esto; el Front solo oculta botones.
 * Matriz en docs/v2/plan-refactorizacion.md.
 */
export const PERMISSIONS = [
    'registrations.read',
    'registrations.update',
    'registrations.delete',
    'checkin.write',
    'payments.write',
    'events.manage',
    'forms.manage',
    'users.manage',
    'organizations.manage',
    'tenant.settings',
    'audit.read',
] as const;

export type Permission = typeof PERMISSIONS[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
    // superadmin de V1: todo dentro de su cliente, incluida la auditoría
    owner: ALL,
    finance: ['registrations.read', 'payments.write'],
    staff: ['registrations.read', 'registrations.update', 'registrations.delete', 'checkin.write'],
    // admin / vicePresident de V1: solo lectura
    viewer: ['registrations.read'],
};

export function permissionsFor(role: MembershipRole | null, isPlatformAdmin: boolean): ReadonlySet<Permission> {
    if (isPlatformAdmin) return new Set(ALL);
    return new Set(role ? ROLE_PERMISSIONS[role] : []);
}
