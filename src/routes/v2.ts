import { Router } from 'express';
import { tenantMiddleware } from '../modules/tenants/tenant.resolver';
import { authRoutesV2 } from '../modules/auth/auth.routes';
import { eventRoutesV2 } from '../modules/events/events.routes';
import { userRoutesV2 } from '../modules/users/users.routes';
import { organizationRoutesV2 } from '../modules/organizations/organizations.routes';
import { tenantRoutesV2 } from '../modules/tenants/tenant.routes';
import { platformRoutesV2 } from '../modules/platform/platform.routes';
import { eventFormRoutesV2, formRoutesV2 } from '../modules/forms/forms.routes';
import { publicRoutesV2 } from '../modules/public/public.routes';

/** API V2 (multitenant). Convive con V1 en /api hasta que el Front migre. */
export const routerV2 = Router();

routerV2.use(tenantMiddleware);
routerV2.use('/auth', authRoutesV2);
routerV2.use('/tenant', tenantRoutesV2);
routerV2.use('/users', userRoutesV2);
routerV2.use('/organizations', organizationRoutesV2);
routerV2.use('/events/:eventId/forms', eventFormRoutesV2);
routerV2.use('/events', eventRoutesV2);
routerV2.use('/forms', formRoutesV2);
routerV2.use('/platform', platformRoutesV2);
routerV2.use('/public', publicRoutesV2);
