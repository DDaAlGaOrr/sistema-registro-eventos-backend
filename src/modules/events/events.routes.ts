import { Router } from 'express';
import { z } from 'zod';
import { AppError, catchAsync, parseId } from '../../middlewares/errorHandler';
import { currentTenantScope } from '../../core/access-scope';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import { findVisibleEvent, listEvents } from './events.repository';
import { listRegistrations } from '../registrations/registrations.repository';

const pageSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const eventRoutesV2 = Router();

eventRoutesV2.use(requireTenant, authenticate, requirePermission('registrations.read'));

eventRoutesV2.get('/', catchAsync(async () => {
    const scope = await currentTenantScope();
    return { code: 200, data: await listEvents(scope) };
}));

eventRoutesV2.get('/:eventId/registrations', catchAsync(async (req) => {
    const scope = await currentTenantScope();
    const event = await findVisibleEvent(scope, parseId(req.params.eventId, 'eventId'));
    // Mismo 404 si no existe, es de otro cliente o no lo puede ver: no se delata nada
    if (!event) throw new AppError(404, 'Evento no encontrado');
    const page = pageSchema.parse(req.query);
    return { code: 200, data: await listRegistrations(scope, event, page) };
}));
