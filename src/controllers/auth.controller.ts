import { z } from 'zod';
import { catchAsync, AppError } from '../middlewares/errorHandler';
import { AuthRequest } from '../middlewares/auth.middleware';
import * as authService from '../services/auth.service'

const loginSchema = z.object({
    email: z.string().trim().min(1, 'Email y password son obligatorios').max(150),
    password: z.string().min(1, 'Email y password son obligatorios').max(200),
});

export const login = catchAsync(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body ?? {});
    const result = await authService.login(email, password);
    if (!result) {
        throw new AppError(401, 'Credenciales incorrectas');
    }
    return {
        code: 200,
        data: result
    };
});

// La ruta usa requireAuth, así que aquí el token ya está verificado.
export const me = catchAsync(async (req: AuthRequest, res) => {
    return {
        code: 200,
        data: req.user
    };
});
