import { Router } from 'express';
import { z } from 'zod';
import { catchAsync } from '../../middlewares/errorHandler';
import { isoDateTimeSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import { listAudit } from './audit.service';

const querySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    eventId: z.coerce.number().int().positive().optional(),
    entityType: z.string().trim().max(40).optional(),
    entityId: z.string().trim().max(40).optional(),
    actorUserId: z.coerce.number().int().positive().optional(),
    action: z.string().trim().max(60).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
});

/** /api/v2/audit — log de auditoría del cliente (owner y admin de plataforma). */
export const auditRoutesV2 = Router();

auditRoutesV2.use(requireTenant, authenticate, requirePermission('audit.read'));

auditRoutesV2.get('/', catchAsync(async (req) => {
    const { page, pageSize, ...filters } = querySchema.parse(req.query);
    return { code: 200, data: await listAudit(filters, page, pageSize) };
}));
