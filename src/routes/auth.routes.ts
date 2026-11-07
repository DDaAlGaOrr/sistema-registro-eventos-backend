import { Router } from 'express';
import * as authController from './../controllers/auth.controller'

export const authRoutes = Router();

authRoutes.post('/login', authController.login);
authRoutes.get('/me', authController.me);