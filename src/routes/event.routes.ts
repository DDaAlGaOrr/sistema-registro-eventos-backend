import { Router } from 'express';
import * as eventsController from './../controllers/event.controller'
import { requireAuth, requireAuthSse, requirePermission } from '../middlewares/auth.middleware';
import { registerLimiter } from '../middlewares/rateLimit';

export const eventRoutes = Router();

// Públicas (las usa el formulario de registro)
eventRoutes.get('/', eventsController.getEvents);
eventRoutes.post('/:id/register', registerLimiter, eventsController.saveUserRegister);

// Panel admin: lectura
eventRoutes.get('/stream', requireAuthSse, eventsController.stream);
eventRoutes.get('/recent-activity/:id', requireAuth, eventsController.recentActivity);
eventRoutes.get('/registration/:id', requireAuth, eventsController.getRegistration);
eventRoutes.get('/:id/registrations', requireAuth, eventsController.getEventRegistrations);
eventRoutes.get('/register/:id/was-food-paid', requireAuth, eventsController.wasFoodPaid);

// Panel admin: acciones según rol
eventRoutes.get('/register/:id/checkin', requireAuth, requirePermission('checkIn'), eventsController.checkIn);
eventRoutes.post('/register/:id/updatePayment', requireAuth, requirePermission('payments'), eventsController.updatePaymentRegister);
eventRoutes.delete('/register/:id/delete', requireAuth, requirePermission('deleteRegister'), eventsController.removeRegister);
// Además, el controlador valida qué campos puede tocar cada rol
eventRoutes.put('/register/:id/update', requireAuth, requirePermission('editRegister'), eventsController.updateRegister);

// Pública; va al final para no capturar las rutas de arriba
eventRoutes.get('/:id', eventsController.getEventById);
