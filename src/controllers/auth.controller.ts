import { catchAsync, AppError } from '../middlewares/errorHandler';
import * as authService from '../services/auth.service'

export const login = catchAsync(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email y password son obligatorios' });
    }
    const result = await authService.login(email, password);
    if (result) {
        return {
            code: 200,
            data: result
        };
    } else {
        return {
            code: 400,
            data: result
        };
    }
});


export const me = catchAsync(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    const token = authHeader.split(' ')[1];
    const user = await authService.verifyToken(token);
    return {
        code: 200,
        data: user
    };
});
