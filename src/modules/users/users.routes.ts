import { Router } from 'express';
import { z } from 'zod';
import { catchAsync, parseId } from '../../middlewares/errorHandler';
import { emailSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import * as users from './users.service';

const roleSchema = z.enum(['owner', 'finance', 'staff', 'viewer']);

const inviteSchema = z.object({
    email: emailSchema,
    name: z.string().trim().min(1).max(120),
    role: roleSchema,
    scopeOrganizationId: z.number().int().positive().nullable().default(null),
}).strict();

const updateSchema = z.object({
    role: roleSchema.optional(),
    scopeOrganizationId: z.number().int().positive().nullable().optional(),
    isActive: z.boolean().optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'No hay cambios');

export const userRoutesV2 = Router();

userRoutesV2.use(requireTenant, authenticate, requirePermission('users.manage'));

userRoutesV2.get('/', catchAsync(async () => ({ code: 200, data: await users.listMembers() })));

userRoutesV2.post('/invite', catchAsync(async (req) => ({
    code: 201, data: await users.inviteUser(inviteSchema.parse(req.body)),
})));

userRoutesV2.post('/:userId/resend-invitation', catchAsync(async (req) => {
    await users.resendInvitation(parseId(req.params.userId, 'userId'));
    return { code: 200, data: { message: 'Invitación reenviada' } };
}));

userRoutesV2.patch('/:userId', catchAsync(async (req) => ({
    code: 200, data: await users.updateMember(parseId(req.params.userId, 'userId'), updateSchema.parse(req.body)),
})));
