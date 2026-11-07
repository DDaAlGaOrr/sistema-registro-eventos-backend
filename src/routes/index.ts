import { Router } from 'express';
import { eventRoutes } from './event.routes';
import { generalRoutes } from './general.routes';
import { authRoutes } from './auth.routes'

export const router = Router();

router.use('/events', eventRoutes);
router.use('', generalRoutes);
router.use('/auth', authRoutes);