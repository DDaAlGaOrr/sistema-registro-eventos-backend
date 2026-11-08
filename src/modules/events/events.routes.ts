import { Router } from 'express';
import { z } from 'zod';
import { AppError, catchAsync, parseId } from '../../middlewares/errorHandler';
import { currentTenantScope } from '../../core/access-scope';
import { httpsUrlSchema, i18nTextSchema, isoDateTimeSchema, slugSchema, timezoneSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import { findVisibleEvent, listEvents } from './events.repository';
import { listRegistrations } from '../registrations/registrations.repository';
import * as registrations from '../registrations/registrations.service';
import * as reports from '../reports/reports.service';
import { getContext } from '../../core/request-context';
import { FIELD_KEY } from '../forms/form-schema';
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

/** Filtros de la lista y de la exportación (vienen en el query string). */
export const registrationFiltersSchema = z.object({
    q: z.string().trim().max(100).optional(),
    conferenceId: z.coerce.number().int().positive().optional(),
    churchId: z.coerce.number().int().positive().optional(),
    status: z.enum(['confirmed', 'pending_payment', 'cancelled']).optional(),
    paymentStatus: z.enum(['not_required', 'unpaid', 'partially_paid', 'paid', 'refunded']).optional(),
    checkedIn: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
    itemCode: z.string().regex(FIELD_KEY).optional(),
    variantCode: z.string().trim().max(20).optional(),
    createdFrom: isoDateTimeSchema.optional(),
    createdTo: isoDateTimeSchema.optional(),
    deleted: z.enum(['exclude', 'only']).optional(),
});

const listQuerySchema = pageSchema.merge(registrationFiltersSchema).extend({
    sort: z.enum(['created_at', 'last_name', 'checked_in_at']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
});

const splitQuery = (query: unknown) => {
    const { page, pageSize, sort, order, ...filters } = listQuerySchema.parse(query);
    // La papelera solo para quien puede borrar
    if (filters.deleted === 'only' && !getContext()?.auth?.permissions.has('registrations.delete')) {
        throw new AppError(403, 'No tienes permiso para ver registros borrados');
    }
    return { page, pageSize, sort, order, filters };
};

async function visibleEventOr404(eventId: unknown) {
    const scope = await currentTenantScope();
    const event = await findVisibleEvent(scope, parseId(eventId, 'eventId'));
    // Mismo 404 si no existe, es de otro cliente o no lo puede ver: no se delata nada
    if (!event) throw new AppError(404, 'Evento no encontrado');
    return { scope, event };
}

eventRoutesV2.get('/:eventId/registrations', catchAsync(async (req) => {
    const { scope, event } = await visibleEventOr404(req.params.eventId);
    return { code: 200, data: await listRegistrations(scope, event, splitQuery(req.query)) };
}));

eventRoutesV2.get('/:eventId/registrations/export', catchAsync(async (req, res) => {
    const { filters } = splitQuery(req.query);
    const locale = req.query.locale === 'en' ? 'en' : 'es';
    const csv = await reports.exportRegistrationsCsv(parseId(req.params.eventId, 'eventId'), filters, locale);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csv.filename}"`);
    res.send(csv.content);
}));

eventRoutesV2.get('/:eventId/report', catchAsync(async (req) => ({
    code: 200, data: await reports.getEventReport(parseId(req.params.eventId, 'eventId')),
})));

eventRoutesV2.get('/:eventId/activity', catchAsync(async (req) => {
    const { after } = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query);
    return { code: 200, data: await reports.getActivity(parseId(req.params.eventId, 'eventId'), after ?? null) };
}));

// ── Check-in por QR ────────────────────────────────────────────────────

const publicCodeSchema = z.string().trim().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, 'Código inválido');

eventRoutesV2.get('/:eventId/checkin/:publicCode', requirePermission('checkin.write'), catchAsync(async (req) => ({
    code: 200,
    data: await registrations.lookupForCheckIn(parseId(req.params.eventId, 'eventId'), publicCodeSchema.parse(req.params.publicCode)),
})));

eventRoutesV2.post('/:eventId/checkin', requirePermission('checkin.write'), catchAsync(async (req) => {
    const { publicCode } = z.object({ publicCode: publicCodeSchema }).strict().parse(req.body);
    return { code: 200, data: await registrations.checkInByCode(parseId(req.params.eventId, 'eventId'), publicCode) };
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
