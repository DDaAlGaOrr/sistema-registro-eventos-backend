import { UserDataRegister } from '../interfaces/register.interface';
import { catchAsync, AppError, parseId } from '../middlewares/errorHandler';
import { AuthRequest } from '../middlewares/auth.middleware';
import { Response } from 'express';
import { sendConfirmationMail } from '../services/mail.service';
import { EDITABLE_FIELDS_BY_ROLE } from '../config/roles';
import { paymentSchema, registerSchema, updateRegisterSchema } from '../validators/register.schema';
import * as eventModel from '../model/event.model'

let clients: Response[] = [];

export const getEvents = catchAsync(async (req, res) => {
    const result = await eventModel.getEvents()
    return {
        code: 200,
        data: result
    };
});


export const getEventById = catchAsync(async (req, res) => {
    const eventId = parseId(req.params.id);
    const result = await eventModel.getEventById(eventId)
    if (!result[0]) {
        throw new AppError(404, 'Evento no encontrado');
    }
    return {
        code: 200,
        data: result[0]
    };
});



export const saveUserRegister = catchAsync(async (req, res) => {
    const eventId = parseId(req.params.id);
    const input = registerSchema.parse(req.body);

    const [event] = await eventModel.getEventById(eventId);
    if (!event || !event.activo) {
        throw new AppError(404, 'Evento no encontrado o cerrado');
    }

    const data: UserDataRegister = {
        ...input,
        pago_camiseta: input.incluir_camisa ? 'pendiente' : 'no_aplica',
        pago_lunchtime: input.incluir_lunchtime ? 'pendiente' : 'no_aplica',
        tipo_alimento: input.incluir_lunchtime ? (input.tipo_alimento ?? 'normal') : 'normal',
    };
    const result = await eventModel.saveUserRegister(data, eventId)


    const activityData = {
        nombre: `${data.nombre}`.trim(),
        apellidos: data.apellidos,
        conferencia: data.nombre_conferencia,
        correo: data.correo,
        created_at: new Date().toISOString(),
    };

    emitNewRegistration(activityData);

    sendConfirmationMail(data)
        .catch(err => console.error('Fallo al enviar el correo:', err));

    return {
        code: 200,
        data: result
    };
});

export const getEventRegistrations = catchAsync(async (req, res) => {
    const eventId = parseId(req.params.id);
    const registrations = await eventModel.getEventRegistrations(eventId)
    return {
        code: 200,
        data: registrations
    };
});

export const getRegistration = catchAsync(async (req, res) => {
    const registerId = parseId(req.params.id);
    const registration = await eventModel.getRegistration(registerId)
    if (!registration) {
        throw new AppError(404, 'Registro no encontrado');
    }
    return {
        code: 200,
        data: registration
    };
});

export const checkIn = catchAsync(async (req: AuthRequest, res: Response) => {
    const registerId = parseId(req.params.id);
    await eventModel.checkIn(registerId, req.user!.id);
    return {
        code: 200,
        data: { message: 'Check-in realizado con éxito' }
    };
});

export const updatePaymentRegister = catchAsync(async (req: AuthRequest, res: Response) => {
    const registerId = parseId(req.params.id);
    const data = paymentSchema.parse(req.body);

    await eventModel.updatePaymentRegister(registerId, req.user!.id, {
        concepto: data.concepto,
        estatus_nuevo: data.estatus_nuevo,
        notas: data.notas ?? undefined,
    });

    return {
        code: 200,
        data: { message: `Estatus de ${data.concepto} actualizado correctamente` }
    };
});


export const removeRegister = catchAsync(async (req: AuthRequest, res: Response) => {
    const registerId = parseId(req.params.id);
    await eventModel.removeRegister(registerId, req.user!.id);
    return {
        code: 200,
        data: { message: 'registro eliminado' }
    };
});


export const updateRegister = catchAsync(async (req: AuthRequest, res: Response) => {
    const registerId = parseId(req.params.id);
    const data = updateRegisterSchema.parse(req.body ?? {});

    // Cada rol solo puede tocar ciertos campos (ej. staff no cambia pagos)
    const allowed: readonly string[] = EDITABLE_FIELDS_BY_ROLE[req.user!.role] ?? [];
    const forbidden = Object.keys(data).filter(field => !allowed.includes(field));
    if (forbidden.length > 0) {
        throw new AppError(403, `Tu rol no puede modificar: ${forbidden.join(', ')}`, { fields: forbidden });
    }

    await eventModel.updateRegister(data, registerId, req.user!.id)
    return {
        code: 200,
        data: { message: 'registro actualizado' }
    };
});

export const stream = catchAsync(async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.push(res);

    // Mantiene viva la conexión detrás de proxies que cortan conexiones inactivas
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        clients = clients.filter(client => client !== res);
    });
})
export const recentActivity = catchAsync(async (req, res) => {
    const eventId = parseId(req.params.id);
    const registers = await eventModel.lastRegisters(eventId);
    return {
        code: 200,
        data: registers
    };
})

export const emitNewRegistration = (newRecord: any) => {
    const sseData = `data: ${JSON.stringify(newRecord)}\n\n`;

    clients.forEach(client => client.write(sseData));
};


export const wasFoodPaid = catchAsync(async (req: AuthRequest, res: Response) => {
    const registerId = parseId(req.params.id);
    const wasFoodPaid = await eventModel.wasFoodPaid(registerId)
    return {
        code: 200,
        data: wasFoodPaid
    };
});
