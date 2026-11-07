import { Router } from 'express';
import { tenantMiddleware } from '../modules/tenants/tenant.resolver';
import { authRoutesV2 } from '../modules/auth/auth.routes';
import { eventRoutesV2 } from '../modules/events/events.routes';

/** API V2 (multitenant). Convive con V1 en /api hasta que el Front migre. */
export const routerV2 = Router();

routerV2.use(tenantMiddleware);
routerV2.use('/auth', authRoutesV2);
routerV2.use('/events', eventRoutesV2);
