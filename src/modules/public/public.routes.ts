import { Router } from 'express';
import { z } from 'zod';
import { AppError, catchAsync, parseId } from '../../middlewares/errorHandler';
import { citiesLimiter, registerLimiter } from '../../middlewares/rateLimit';
import { verifyCaptcha } from '../../core/captcha';
import { getContext } from '../../core/request-context';
import { requireTenant } from '../tenants/tenant.resolver';
import { kickEmailWorker } from '../email/email-queue';
import { createPublicRegistration, getPublicRegistration, retryCheckoutByCode } from '../registrations/public-registration.service';
import { citiesOfState } from './cities.service';
import { getPublicChurches, getPublicEvent, getPublicForm, getPublicLocations, listPublicEvents } from './public.service';

const registrationSchema = z.object({
    answers: z.record(z.unknown()),
    locale: z.enum(['es', 'en']).default('es'),
    paymentMethod: z.enum(['online', 'offline']).optional(),
    captchaToken: z.string().max(2048).optional(),
}).strict();

/** /api/v2/public — sin sesión, siempre dentro del cliente de la petición. */
export const publicRoutesV2 = Router();

publicRoutesV2.use(requireTenant);

publicRoutesV2.get('/events', catchAsync(async () => ({ code: 200, data: await listPublicEvents() })));

publicRoutesV2.get('/events/:slug', catchAsync(async (req) => ({
    code: 200, data: await getPublicEvent(String(req.params.slug)),
})));

publicRoutesV2.get('/forms/:formId', catchAsync(async (req) => ({
    code: 200, data: await getPublicForm(parseId(req.params.formId, 'formId')),
})));

publicRoutesV2.get('/locations', catchAsync(async () => ({ code: 200, data: await getPublicLocations() })));

/** Sugerencias de ciudad del estado (código de 2 letras). */
publicRoutesV2.get('/states/:code/cities', citiesLimiter, catchAsync(async (req, res) => {
    const code = String(req.params.code);
    if (!/^[A-Za-z]{2}$/.test(code)) throw new AppError(404, 'Estado no encontrado');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return { code: 200, data: await citiesOfState(code) };
}));

publicRoutesV2.get('/conferences/:conferenceId/churches', catchAsync(async (req) => ({
    code: 200, data: await getPublicChurches(parseId(req.params.conferenceId, 'conferenceId')),
})));

publicRoutesV2.post('/forms/:formId/registrations', registerLimiter, catchAsync(async (req) => {
    const body = registrationSchema.parse(req.body ?? {});
    if (!(await verifyCaptcha(body.captchaToken, getContext()?.ip))) {
        throw new AppError(400, 'No pudimos verificar que no eres un robot. Intenta de nuevo.', { reason: 'captcha' });
    }
    const result = await createPublicRegistration(parseId(req.params.formId, 'formId'), body);
    kickEmailWorker();
    return { code: 201, data: result };
}));

publicRoutesV2.post('/registrations/:publicCode/checkout', registerLimiter, catchAsync(async (req) => {
    const code = String(req.params.publicCode);
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(code)) throw new AppError(404, 'Registro no encontrado');
    return { code: 200, data: await retryCheckoutByCode(code) };
}));

publicRoutesV2.get('/registrations/:publicCode', catchAsync(async (req) => {
    const code = String(req.params.publicCode);
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(code)) throw new AppError(404, 'Registro no encontrado');
    return { code: 200, data: await getPublicRegistration(code.toUpperCase()) };
}));
