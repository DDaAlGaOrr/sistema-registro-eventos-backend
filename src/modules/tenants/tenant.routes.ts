import { Router } from 'express';
import { z } from 'zod';
import { catchAsync } from '../../middlewares/errorHandler';
import { getContext } from '../../core/request-context';
import { emailSchema, hexColorSchema, httpsUrlSchema, timezoneSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from './tenant.resolver';
import { getPublicBranding, getTenantSettings, updateTenantSettings } from './tenant.service';

const settingsSchema = z.object({
    name: z.string().trim().min(2).max(150),
    defaultLocale: z.enum(['es', 'en']),
    timezone: timezoneSchema,
    logoUrl: httpsUrlSchema.nullable(),
    primaryColor: hexColorSchema.nullable(),
    secondaryColor: hexColorSchema.nullable(),
    emailFromName: z.string().trim().min(1).max(120).nullable(),
    emailReplyTo: emailSchema.nullable(),
}).partial().strict().refine(v => Object.keys(v).length > 0, 'No hay cambios');

export const tenantRoutesV2 = Router();

tenantRoutesV2.use(requireTenant);

/** Marca del cliente para la pantalla de login y el formulario público (sin sesión). */
tenantRoutesV2.get('/public', catchAsync(async () => ({
    code: 200, data: await getPublicBranding(getContext()!.tenant!.id),
})));

tenantRoutesV2.get('/settings', authenticate, requirePermission('tenant.settings'), catchAsync(async () => ({
    code: 200, data: await getTenantSettings(getContext()!.tenant!.id),
})));

tenantRoutesV2.patch('/settings', authenticate, requirePermission('tenant.settings'), catchAsync(async (req) => ({
    code: 200, data: await updateTenantSettings(settingsSchema.parse(req.body)),
})));
