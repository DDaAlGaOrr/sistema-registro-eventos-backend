import { Router } from 'express';
import { z } from 'zod';
import { AppError, catchAsync, parseId } from '../../middlewares/errorHandler';
import { getContext } from '../../core/request-context';
import { emailSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import { registrationHistory } from '../audit/audit.service';
import * as service from './registrations.service';

const updateSchema = z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: emailSchema,
    phone: z.string().trim().max(30).nullable(),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha YYYY-MM-DD').nullable(),
    gender: z.enum(['male', 'female', 'undisclosed']).nullable(),
    conferenceOrganizationId: z.number().int().positive().nullable(),
    churchOrganizationId: z.number().int().positive().nullable(),
    answers: z.record(z.unknown()),
}).partial().strict().refine(v => Object.keys(v).length > 0, 'No hay cambios');

const id = (value: unknown, name = 'id') => parseId(value, name);

/** /api/v2/registrations/:id — operación del evento sobre un registro. */
export const registrationRoutesV2 = Router();

registrationRoutesV2.use(requireTenant, authenticate, requirePermission('registrations.read'));

registrationRoutesV2.get('/:id', catchAsync(async (req) => {
    const includeDeleted = req.query.includeDeleted === 'true';
    if (includeDeleted && !getContext()?.auth?.permissions.has('registrations.delete')) {
        throw new AppError(403, 'No tienes permiso para ver registros borrados');
    }
    return { code: 200, data: await service.getRegistrationDetail(id(req.params.id), { includeDeleted }) };
}));

registrationRoutesV2.patch('/:id', requirePermission('registrations.update'), catchAsync(async (req) => ({
    code: 200, data: await service.updateRegistration(id(req.params.id), updateSchema.parse(req.body)),
})));

registrationRoutesV2.patch('/:id/items/:itemId', requirePermission('registrations.update'), catchAsync(async (req) => {
    const { variantCode } = z.object({ variantCode: z.string().trim().min(1).max(20) }).strict().parse(req.body);
    return { code: 200, data: await service.changeItemVariant(id(req.params.id), id(req.params.itemId, 'itemId'), variantCode) };
}));

registrationRoutesV2.delete('/:id', requirePermission('registrations.delete'), catchAsync(async (req) => {
    const { reason } = z.object({ reason: z.string().trim().max(500).nullable().default(null) }).strict().parse(req.body ?? {});
    await service.deleteRegistration(id(req.params.id), reason);
    return { code: 200, data: { message: 'Registro enviado a la papelera' } };
}));

registrationRoutesV2.post('/:id/restore', requirePermission('registrations.delete'), catchAsync(async (req) => ({
    code: 200, data: await service.restoreRegistration(id(req.params.id)),
})));

registrationRoutesV2.post('/:id/checkin', requirePermission('checkin.write'), catchAsync(async (req) => ({
    code: 200, data: await service.checkInManual(id(req.params.id)),
})));

registrationRoutesV2.delete('/:id/checkin', requirePermission('checkin.write'), catchAsync(async (req) => ({
    code: 200, data: await service.undoCheckIn(id(req.params.id)),
})));

registrationRoutesV2.post('/:id/items/:itemId/delivery', requirePermission('checkin.write'), catchAsync(async (req) => ({
    code: 200, data: await service.setDelivered(id(req.params.id), id(req.params.itemId, 'itemId'), true),
})));

registrationRoutesV2.delete('/:id/items/:itemId/delivery', requirePermission('checkin.write'), catchAsync(async (req) => ({
    code: 200, data: await service.setDelivered(id(req.params.id), id(req.params.itemId, 'itemId'), false),
})));

registrationRoutesV2.get('/:id/history', requirePermission('audit.read'), catchAsync(async (req) => ({
    code: 200, data: await registrationHistory(id(req.params.id)),
})));
