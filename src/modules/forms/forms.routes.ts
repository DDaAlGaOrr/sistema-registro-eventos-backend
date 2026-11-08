import { Router } from 'express';
import { z } from 'zod';
import { AppError, catchAsync, parseId } from '../../middlewares/errorHandler';
import { i18nTextSchema, isoDateTimeSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import { FIELD_KEY } from './form-schema';
import * as forms from './forms.service';

const codeSchema = z.string().regex(FIELD_KEY, 'Código: minúsculas, números y guion bajo; empieza con letra');
const variantCodeSchema = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, 'Código de variante: letras, números, - o _');
const cents = z.number().int().min(0).max(10_000_000);

const formUpdateSchema = z.object({
    title: i18nTextSchema(150),
    opensAt: isoDateTimeSchema.nullable(),
    closesAt: isoDateTimeSchema.nullable(),
    maxRegistrations: z.number().int().positive().max(1_000_000).nullable(),
    paymentsEnabled: z.boolean(),
    allowOnlinePayment: z.boolean(),
    allowOfflinePayment: z.boolean(),
    settings: z.object({ confirmationMessage: i18nTextSchema(2000).optional() }).strict(),
}).partial().strict().refine(v => Object.keys(v).length > 0, 'No hay cambios');

const variantSchema = z.object({
    code: variantCodeSchema,
    label: i18nTextSchema(100),
    priceCentsOverride: cents.nullable().optional(),
    stock: z.number().int().min(0).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
}).strict();

const itemCreateSchema = z.object({
    code: codeSchema,
    kind: z.enum(['registration_fee', 'product']),
    name: i18nTextSchema(150),
    description: i18nTextSchema(1000).nullable().optional(),
    priceCents: cents,
    isRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    variants: z.array(variantSchema).max(30).optional(),
}).strict();

const itemUpdateSchema = z.object({
    name: i18nTextSchema(150),
    description: i18nTextSchema(1000).nullable(),
    priceCents: cents,
    isRequired: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
    isActive: z.boolean(),
}).partial().strict().refine(v => Object.keys(v).length > 0, 'No hay cambios');

const auth = [requireTenant, authenticate] as const;
const read = requirePermission('registrations.read');
const manage = requirePermission('forms.manage');

/** /api/v2/events/:eventId/forms */
export const eventFormRoutesV2 = Router({ mergeParams: true });
eventFormRoutesV2.use(...auth);

eventFormRoutesV2.get('/', read, catchAsync(async (req) => ({
    code: 200, data: await forms.listForms(parseId(req.params.eventId, 'eventId')),
})));

eventFormRoutesV2.post('/', manage, catchAsync(async (req) => {
    const { title } = z.object({ title: i18nTextSchema(150) }).strict().parse(req.body);
    return { code: 201, data: await forms.createForm(parseId(req.params.eventId, 'eventId'), { title }) };
}));

/** /api/v2/forms/:formId */
export const formRoutesV2 = Router();
formRoutesV2.use(...auth);

const formId = (req: { params: Record<string, unknown> }) => parseId(req.params.formId, 'formId');

formRoutesV2.get('/:formId', read, catchAsync(async (req) => ({ code: 200, data: await forms.getForm(formId(req)) })));

formRoutesV2.patch('/:formId', manage, catchAsync(async (req) => ({
    code: 200, data: await forms.updateForm(formId(req), formUpdateSchema.parse(req.body)),
})));

formRoutesV2.post('/:formId/status', manage, catchAsync(async (req) => {
    const { status } = z.object({ status: z.enum(['draft', 'open', 'closed']) }).strict().parse(req.body);
    return { code: 200, data: await forms.changeFormStatus(formId(req), status) };
}));

formRoutesV2.put('/:formId/draft', manage, catchAsync(async (req) => {
    const { schema } = z.object({ schema: z.unknown() }).strict().parse(req.body);
    if (schema === undefined) throw new AppError(400, 'Falta "schema"');
    return { code: 200, data: await forms.saveDraft(formId(req), schema) };
}));

formRoutesV2.post('/:formId/publish', manage, catchAsync(async (req) => ({
    code: 200, data: await forms.publishDraft(formId(req)),
})));

formRoutesV2.get('/:formId/versions', read, catchAsync(async (req) => ({ code: 200, data: await forms.listVersions(formId(req)) })));

formRoutesV2.get('/:formId/versions/:versionId', read, catchAsync(async (req) => ({
    code: 200, data: await forms.getVersion(formId(req), parseId(req.params.versionId, 'versionId')),
})));

formRoutesV2.post('/:formId/preview-answers', manage, catchAsync(async (req) => {
    const body = z.object({
        version: z.enum(['draft', 'published']).default('draft'),
        answers: z.record(z.unknown()),
    }).strict().parse(req.body);
    return { code: 200, data: await forms.previewAnswers(formId(req), body.version, body.answers) };
}));

formRoutesV2.post('/:formId/items', manage, catchAsync(async (req) => ({
    code: 201, data: await forms.createItem(formId(req), itemCreateSchema.parse(req.body)),
})));

formRoutesV2.patch('/:formId/items/:itemId', manage, catchAsync(async (req) => ({
    code: 200, data: await forms.updateItem(formId(req), parseId(req.params.itemId, 'itemId'), itemUpdateSchema.parse(req.body)),
})));

formRoutesV2.put('/:formId/items/:itemId/variants', manage, catchAsync(async (req) => {
    const { variants } = z.object({ variants: z.array(variantSchema).max(30) }).strict().parse(req.body);
    return { code: 200, data: await forms.setVariants(formId(req), parseId(req.params.itemId, 'itemId'), variants) };
}));
