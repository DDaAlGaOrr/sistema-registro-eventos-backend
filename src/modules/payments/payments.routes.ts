import { Router } from 'express';
import { z } from 'zod';
import { catchAsync, parseId } from '../../middlewares/errorHandler';
import { isoDateTimeSchema } from '../../core/validation';
import { authenticate, requirePermission } from '../auth/auth.middleware';
import { requireTenant } from '../tenants/tenant.resolver';
import { recordManualPayment, voidManualPayment } from './manual-payments.service';
import { refundPayment } from './refunds.service';
import { getStripeAccount, refreshStripeAccount, startStripeOnboarding } from './stripe.service';
import { listEventPayments } from './payments.repository';

const manualSchema = z.object({
    method: z.enum(['cash', 'check', 'zelle', 'other']),
    itemIds: z.array(z.number().int().positive()).max(50).optional(),
    reference: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    paidAt: isoDateTimeSchema.optional(),
}).strict();

const refundSchema = z.object({
    amountCents: z.number().int().positive().optional(),
    reason: z.string().trim().min(3).max(255),
}).strict();

const listSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    method: z.enum(['stripe', 'cash', 'check', 'zelle', 'other', 'legacy']).optional(),
    status: z.enum(['pending', 'succeeded', 'failed', 'canceled', 'refunded', 'partially_refunded']).optional(),
});

/** /api/v2/payments */
export const paymentRoutesV2 = Router();
paymentRoutesV2.use(requireTenant, authenticate);

// Cuenta de Stripe del cliente (owner)
paymentRoutesV2.get('/stripe/account', requirePermission('tenant.settings'), catchAsync(async () => ({
    code: 200, data: await getStripeAccount(),
})));
paymentRoutesV2.post('/stripe/connect', requirePermission('tenant.settings'), catchAsync(async () => ({
    code: 200, data: await startStripeOnboarding(),
})));
paymentRoutesV2.post('/stripe/refresh', requirePermission('tenant.settings'), catchAsync(async () => ({
    code: 200, data: await refreshStripeAccount(),
})));

// Finanzas
paymentRoutesV2.post('/:paymentId/void', requirePermission('payments.write'), catchAsync(async (req) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(255) }).strict().parse(req.body);
    return { code: 200, data: await voidManualPayment(parseId(req.params.paymentId, 'paymentId'), reason) };
}));
paymentRoutesV2.post('/:paymentId/refund', requirePermission('payments.write'), catchAsync(async (req) => ({
    code: 200, data: await refundPayment(parseId(req.params.paymentId, 'paymentId'), refundSchema.parse(req.body)),
})));

/** /api/v2/registrations/:id/payments — se monta junto a las rutas de registros. */
export const registrationPaymentRoutesV2 = Router({ mergeParams: true });
registrationPaymentRoutesV2.use(requireTenant, authenticate, requirePermission('payments.write'));
registrationPaymentRoutesV2.post('/', catchAsync(async (req) => ({
    code: 201, data: await recordManualPayment(parseId(req.params.id), manualSchema.parse(req.body)),
})));

/** /api/v2/events/:eventId/payments — vista "Pagos". */
export const eventPaymentRoutesV2 = Router({ mergeParams: true });
eventPaymentRoutesV2.use(requireTenant, authenticate, requirePermission('registrations.read'));
eventPaymentRoutesV2.get('/', catchAsync(async (req) => {
    const { page, pageSize, ...filters } = listSchema.parse(req.query);
    return { code: 200, data: await listEventPayments(parseId(req.params.eventId, 'eventId'), filters, page, pageSize) };
}));
