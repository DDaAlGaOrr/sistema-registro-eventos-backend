import { Router } from 'express';
import { z } from 'zod';
import { catchAsync, parseId } from '../../middlewares/errorHandler';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import * as orgs from './organizations.service';

const stateCode = z.string().trim().length(2);

const createSchema = z.object({
    conferenceId: z.number().int().positive(),
    name: z.string().trim().min(2).max(200),
    city: z.string().trim().max(120).nullable().optional(),
    stateCode: stateCode.nullable().optional(),
}).strict();

const updateSchema = z.object({
    name: z.string().trim().min(2).max(200).optional(),
    city: z.string().trim().max(120).nullable().optional(),
    stateCode: stateCode.nullable().optional(),
    status: z.enum(['verified', 'inactive']).optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'No hay cambios');

const listSchema = z.object({
    status: z.enum(['verified', 'pending', 'merged', 'inactive']).optional(),
    conferenceId: z.coerce.number().int().positive().optional(),
    q: z.string().trim().max(100).optional(),
});

export const organizationRoutesV2 = Router();

organizationRoutesV2.use(requireTenant, authenticate);

// Lectura (filtros del panel): cualquier rol
organizationRoutesV2.get('/tree', requirePermission('registrations.read'), catchAsync(async (req) => ({
    code: 200, data: await orgs.getTree(req.query.includePending === 'true'),
})));

// Catálogo de iglesias: owner
organizationRoutesV2.get('/churches', requirePermission('organizations.manage'), catchAsync(async (req) => ({
    code: 200, data: await orgs.listChurches(listSchema.parse(req.query)),
})));

organizationRoutesV2.post('/churches', requirePermission('organizations.manage'), catchAsync(async (req) => ({
    code: 201, data: await orgs.createChurch(createSchema.parse(req.body)),
})));

organizationRoutesV2.patch('/churches/:id', requirePermission('organizations.manage'), catchAsync(async (req) => ({
    code: 200, data: await orgs.updateChurch(parseId(req.params.id), updateSchema.parse(req.body)),
})));

organizationRoutesV2.post('/churches/:id/merge', requirePermission('organizations.manage'), catchAsync(async (req) => {
    const { intoId } = z.object({ intoId: z.number().int().positive() }).strict().parse(req.body);
    return { code: 200, data: await orgs.mergeChurch(parseId(req.params.id), intoId) };
}));
