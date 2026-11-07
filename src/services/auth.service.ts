const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
import * as authModel from './../model/auth.model';
import { AppError } from '../middlewares/errorHandler';

import dotenv from 'dotenv';

dotenv.config();

const SECRET = process.env.JWT_SECRET
const EXPIRES = process.env.JWT_EXPIRES_IN

export async function login(email: string, password: string) {
    const user = await authModel.findByEmail(email);
    if (!user) {
        return false
    }
    if (!user.activo) {
        return false
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
        return false
    }

    const payload = {
        id: user.id,
        name: user.name,
        email: user.correo,
        role: user.rol,
    };

    const token = jwt.sign(payload, SECRET, { expiresIn: EXPIRES });

    return {
        token,
        user: payload,
    };
}

export function verifyToken(token: string) {
    return jwt.verify(token, SECRET);

}