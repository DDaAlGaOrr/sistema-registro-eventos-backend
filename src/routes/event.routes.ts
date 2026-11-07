import { Router } from 'express';
import * as eventsController from './../controllers/event.controller'
import { requireAuth } from '../middlewares/auth.middleware';

export const eventRoutes = Router();

eventRoutes.get('/', eventsController.getEvents);
eventRoutes.get('/stream', eventsController.stream);
eventRoutes.get('/recent-activity/:id', eventsController.recentActivity);
eventRoutes.get('/registration/:id', requireAuth, eventsController.getRegistration);
eventRoutes.post('/:id/register', eventsController.saveUserRegister);
eventRoutes.get('/:id/registrations', requireAuth, eventsController.getEventRegistrations);
eventRoutes.get('/register/:id/checkin', requireAuth, eventsController.checkIn);
eventRoutes.post('/register/:id/updatePayment', requireAuth, eventsController.updatePaymentRegister);
eventRoutes.delete('/register/:id/delete', requireAuth, eventsController.removeRegister);
eventRoutes.put('/register/:id/update', requireAuth, eventsController.updateRegister);
eventRoutes.get('/:id', eventsController.getEventById);
eventRoutes.get('/register/:id/was-food-paid', requireAuth, eventsController.wasFoodPaid);
