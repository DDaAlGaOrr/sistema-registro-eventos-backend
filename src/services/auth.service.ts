import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import * as authModel from './../model/auth.model';
import { env } from '../config/env';
import { Role } from '../config/roles';

export interface TokenPayload {
    id: number;
    name: string;
    email: string;
    role: Role;
}

// Hash de relleno: si el correo no existe se compara igual contra algo,
// para que el tiempo de respuesta no delate qué correos están registrados.
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', 12);

export async function login(email: string, password: string) {
    const user = await authModel.findByEmail(email);

    const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !user.activo || !valid) {
        return null;
    }

    const payload: TokenPayload = {
        id: user.id,
        name: user.nombre,
        email: user.correo,
        role: user.rol,
    };

    const token = jwt.sign(payload, env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });

    return {
        token,
        user: payload,
    };
}

export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as TokenPayload;
}
