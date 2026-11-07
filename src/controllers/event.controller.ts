import { PayData, UserDataRegister } from '../interfaces/register.interface';
import { catchAsync, AppError } from '../middlewares/errorHandler';
import { AuthRequest } from '../middlewares/auth.middleware';
import { Request, Response } from 'express';
import { sendConfirmationMail } from '../services/mail.service';
import { logAdminAction } from '../services/log.service';
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
    const { id } = req.params;
    if (!id) {
        throw new AppError(400, 'El campo id es necesario');
    }
    const eventId = parseInt(id as string, 10);
    const result = await eventModel.getEventById(eventId)
    return {
        code: 200,
        data: result[0]
    };
});



export const saveUserRegister = catchAsync(async (req, res) => {
    const eventId = parseInt(req.params.id as string, 10);
    const data = req.body as UserDataRegister;
    data.pago_camiseta = data.incluir_camisa ? 'pendiente' : 'no_aplica';
    data.pago_lunchtime = data.incluir_lunchtime ? 'pendiente' : 'no_aplica';
    data.tipo_alimento = data.incluir_lunchtime ? data.tipo_alimento : 'normal';
    const result = await eventModel.saveUserRegister(data, eventId)


    const activityData = {
        nombre: `${data.nombre}`.trim(),
        apellidos: data.apellidos,
        conferencia: data.nombre_conferencia,
        correo: data.correo,
        created_at: new Date().toISOString(),
    };

    emitNewRegistration(activityData);

    if (data.correo && data.nombre) {
        sendConfirmationMail(data)
            .catch(err => console.error('Fallo al enviar el correo:', err));
    }
    return {
        code: 200,
        data: result
    };
});

export const getEventRegistrations = catchAsync(async (req, res) => {
    const { id } = req.params;
    if (!id) {
        throw new AppError(400, 'El campo id es necesario');
    }
    const eventId = parseInt(id as string, 10);
    const registrations = await eventModel.getEventRegistrations(eventId)
    return {
        code: 200,
        data: registrations
    };
});

export const getRegistration = catchAsync(async (req, res) => {
    const { id } = req.params;
    if (!id) {
        throw new AppError(400, 'El campo id es necesario');
    }
    const registerId = parseInt(id as string, 10);
    const registration = await eventModel.getRegistration(registerId)
    return {
        code: 200,
        data: registration[0]
    };
});

export const checkIn = catchAsync(async (req: AuthRequest, res: Response) => {
    const registerId = parseInt(req.params.id as string, 10);
    const adminId = req.user.id;
    await eventModel.checkIn(registerId, adminId);
    await logAdminAction(adminId, 'CHECK_IN', registerId);
    return {
        code: 200,
        data: { message: 'Check-in realizado con éxito' }
    };
});

export const updatePaymentRegister = catchAsync(async (req: AuthRequest, res: Response) => {
    const authReq = req as AuthRequest;

    const registerId = parseInt(req.params.id as string, 10);
    const adminId = authReq.user.id;
    const data = req.body as PayData;

    if (!['camiseta', 'lunchtime'].includes(data.concepto)) {
        return {
            code: 400,
            data: { message: 'Concepto de pago no válido' }
        };
    }
    await logAdminAction(adminId, 'UPDATE_PAYMENT', registerId, {
        concepto: data.concepto,
        nuevo_estatus: data.estatus_nuevo
    });
    await eventModel.updatePaymentRegister(registerId, adminId, data);

    return {
        code: 200,
        data: { message: `Estatus de ${data.concepto} actualizado correctamente` }
    };
});


export const removeRegister = catchAsync(async (req: AuthRequest, res: Response) => {
    const authReq = req as AuthRequest;
    const registerId = parseInt(req.params.id as string, 10);
    const registration = await eventModel.getRegistration(registerId)
    const adminId = authReq.user.id;
    if (!registration) {
        return {
            code: 200,
            data: { message: 'Registro no encontrado' }
        };
    }
    await eventModel.removeRegister(registerId);
    await logAdminAction(adminId, 'DELETE_REGISTER', registerId, {
        nombre_eliminado: registration.nombre
    });
    return {
        code: 200,
        data: { message: 'registro eliminado' }
    };
});


export const updateRegister = catchAsync(async (req: AuthRequest, res: Response) => {
    const registerId = parseInt(req.params.id as string, 10);
    const authReq = req as AuthRequest;
    const data = req.body as any;
    const adminId = authReq.user.id;
    await eventModel.updateRegister(data, registerId, adminId)
    await logAdminAction(adminId, 'UPDATE_REGISTER', registerId, data);
    return {
        code: 200,
        data: { message: 'registro actualizado' }
    };
});

export const stream = catchAsync(async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    clients.push(res);


    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
})
export const recentActivity = catchAsync(async (req, res) => {
    const eventId = parseInt(req.params.id as string, 10);
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
    const registerId = parseInt(req.params.id as string, 10);
    const wasFoodPaid =  await eventModel.wasFoodPaid(registerId)
    return {
        code: 200,
        data: wasFoodPaid
    };
});