import { Router } from 'express';
import * as generalController from './../controllers/general.controller'
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

export const generalRoutes = Router();

// Públicas (catálogos del formulario de registro)
generalRoutes.get('/conference/states', generalController.getStates);
generalRoutes.get('/state/:id/conferences', generalController.getConferences);
generalRoutes.get('/shirt-sizes', generalController.getShirtSizes);
// Solo nombres de iglesias y su conferencia (sin datos personales)
generalRoutes.get('/churches', generalController.getChurches);

// Panel admin
generalRoutes.get('/resumen/event/:id', requireAuth, generalController.getResumen);
generalRoutes.get('/weekly-registrations/event/:id', requireAuth, generalController.weeklyRegistrationsChart);
generalRoutes.get('/gender-by-month/event/:id', requireAuth, generalController.registersForMonthAndGenderChart);
generalRoutes.get('/tshirt-sizes/event/:id', requireAuth, generalController.getTshirtSizesChart);
generalRoutes.get('/logs', requireAuth, requirePermission('viewLogs'), generalController.getLogs);
