import { Router } from 'express';
import * as generalController from './../controllers/general.controller'
import { requireAuth } from '../middlewares/auth.middleware';

export const generalRoutes = Router();

generalRoutes.get('/conference/states', generalController.getStates);
generalRoutes.get('/state/:id/conferences', generalController.getConferences);
generalRoutes.get('/shirt-sizes', generalController.getShirtSizes);
generalRoutes.get('/resumen/event/:id', generalController.getResumen);
generalRoutes.get('/weekly-registrations/event/:id', generalController.weeklyRegistrationsChart);
generalRoutes.get('/gender-by-month/event/:id', generalController.registersForMonthAndGenderChart);
generalRoutes.get('/tshirt-sizes/event/:id', generalController.getTshirtSizesChart);
generalRoutes.get('/logs', generalController.getLogs);
generalRoutes.get('/churches', generalController.getChurches);
