import { Router } from 'express';
import { z } from 'zod';
import { AppError, catchAsync, parseId } from '../../middlewares/errorHandler';
import { currentTenantScope } from '../../core/access-scope';
import { httpsUrlSchema, i18nTextSchema, isoDateTimeSchema, slugSchema, timezoneSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import { findVisibleEvent, listEvents } from './events.repository';
import { listRegistrations } from '../registrations/registrations.repository';
import * as events from './events.service';

const pageSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const eventFields = {
    slug: slugSchema,
    name: i18nTextSchema(150),
    description: i18nTextSchema(2000).nullable().optional(),
    venue: z.string().trim().max(200).nullable().optional(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    timezone: timezoneSchema,
    coverImageUrl: httpsUrlSchema.nullable().optional(),
};

const createSchema = z.object({
    ...eventFields,
    organizerOrganizationId: z.number().int().positive().optional(),
}).strict();

const updateSchema = z.object(eventFields).partial().strict()
    .refine(v => Object.keys(v).length > 0, 'No hay cambios');

const statusSchema = z.object({ status: z.enum(['draft', 'published', 'closed', 'archived']) }).strict();

export const eventRoutesV2 = Router();

eventRoutesV2.use(requireTenant, authenticate, requirePermission('registrations.read'));

eventRoutesV2.get('/', catchAsync(async () => {
    const scope = await currentTenantScope();
    return { code: 200, data: await listEvents(scope) };
}));

eventRoutesV2.get('/:eventId', catchAsync(async (req) => ({
    code: 200, data: await events.getEventDetail(parseId(req.params.eventId, 'eventId')),
})));

eventRoutesV2.get('/:eventId/registrations', catchAsync(async (req) => {
    const scope = await currentTenantScope();
    const event = await findVisibleEvent(scope, parseId(req.params.eventId, 'eventId'));
    // Mismo 404 si no existe, es de otro cliente o no lo puede ver: no se delata nada
    if (!event) throw new AppError(404, 'Evento no encontrado');
    const page = pageSchema.parse(req.query);
    return { code: 200, data: await listRegistrations(scope, event, page) };
}));

// ── Administración de eventos ──────────────────────────────────────────

eventRoutesV2.post('/', requirePermission('events.manage'), catchAsync(async (req) => ({
    code: 201, data: await events.createEvent(createSchema.parse(req.body)),
})));

eventRoutesV2.patch('/:eventId', requirePermission('events.manage'), catchAsync(async (req) => ({
    code: 200, data: await events.updateEvent(parseId(req.params.eventId, 'eventId'), updateSchema.parse(req.body)),
})));

eventRoutesV2.post('/:eventId/status', requirePermission('events.manage'), catchAsync(async (req) => ({
    code: 200, data: await events.changeStatus(parseId(req.params.eventId, 'eventId'), statusSchema.parse(req.body).status),
})));

eventRoutesV2.delete('/:eventId', requirePermission('events.manage'), catchAsync(async (req) => {
    await events.deleteEvent(parseId(req.params.eventId, 'eventId'));
    return { code: 200, data: { message: 'Evento eliminado' } };
}));
