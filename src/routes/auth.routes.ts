import { Router } from 'express';
import * as authController from './../controllers/auth.controller'
import { requireAuth } from '../middlewares/auth.middleware';
import { loginLimiter } from '../middlewares/rateLimit';

export const authRoutes = Router();

authRoutes.post('/login', loginLimiter, authController.login);
authRoutes.get('/me', requireAuth, authController.me);
