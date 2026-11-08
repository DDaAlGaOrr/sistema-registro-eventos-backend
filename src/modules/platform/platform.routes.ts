import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AppError, catchAsync, parseId } from '../../middlewares/errorHandler';
import { emailSchema, slugSchema, timezoneSchema } from '../../core/validation';
import { authenticate, currentAuth } from '../auth/auth.middleware';
import * as platform from './platform.service';

const requirePlatformAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!currentAuth().isPlatformAdmin) return next(new AppError(403, 'Solo para el administrador de la plataforma'));
    next();
};

const tenantSchema = z.object({
    name: z.string().trim().min(2).max(150),
    slug: slugSchema,
    rootOrganizationId: z.number().int().positive(),
    defaultLocale: z.enum(['es', 'en']).default('es'),
    timezone: timezoneSchema.default('America/Los_Angeles'),
    owner: z.object({ email: emailSchema, name: z.string().trim().min(1).max(120) }).strict(),
}).strict();

const organizationSchema = z.object({
    type: z.enum(['union', 'conference']),
    name: z.string().trim().min(2).max(200),
    shortName: z.string().trim().max(30).nullable().default(null),
    parentId: z.number().int().positive().nullable().default(null),
    stateCodes: z.array(z.string().trim().length(2)).max(20).default([]),
}).strict();

/** Panel de la plataforma (app.tuapp.com): solo el admin de plataforma. */
export const platformRoutesV2 = Router();

platformRoutesV2.use(authenticate, requirePlatformAdmin);

platformRoutesV2.get('/tenants', catchAsync(async () => ({ code: 200, data: await platform.listTenants() })));

platformRoutesV2.post('/tenants', catchAsync(async (req) => ({
    code: 201, data: await platform.createTenant(tenantSchema.parse(req.body)),
})));

platformRoutesV2.patch('/tenants/:id/status', catchAsync(async (req) => {
    const { status } = z.object({ status: z.enum(['active', 'suspended', 'cancelled']) }).strict().parse(req.body);
    await platform.setTenantStatus(parseId(req.params.id), status);
    return { code: 200, data: { message: 'Estado actualizado' } };
}));

platformRoutesV2.get('/organizations', catchAsync(async () => ({ code: 200, data: await platform.listCatalog() })));

platformRoutesV2.post('/organizations', catchAsync(async (req) => ({
    code: 201, data: await platform.createCatalogOrganization(organizationSchema.parse(req.body)),
})));
