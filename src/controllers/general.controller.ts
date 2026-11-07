import { AuthRequest } from '../middlewares/auth.middleware';
import { Request, Response } from 'express';
import { catchAsync, AppError } from '../middlewares/errorHandler';
import * as generalModel from '../model/general.model'

export const getConferences = catchAsync(async (req, res) => {
    const { id } = req.params;
    if (!id) {
        throw new AppError(400, 'El campo id es necesario');
    }
    const conferenceId = parseInt(id as string, 10);
    const result = await generalModel.getConferences(conferenceId)
    return {
        code: 200,
        data: result
    };
});

export const getStates = catchAsync(async (req, res) => {
    const result = await generalModel.getStates()
    return {
        code: 200,
        data: result
    };
});

export const getShirtSizes = catchAsync(async (req, res) => {
    const result = await generalModel.getShirtSizes()
    return {
        code: 200,
        data: result
    };
});


export const getResumen = catchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    if (!id) {
        throw new AppError(400, 'El campo id es necesario');
    }
    const eventId = parseInt(id as string, 10);
    const totalRegistrados = await generalModel.totalRegistrados(eventId)
    const totalCheckin = await generalModel.totalCheckin(eventId)
    const totalCamisaPagada = await generalModel.totalCamisaPagada(eventId)
    const totalLunchPagada = await generalModel.totalLunchPagada(eventId)
    const result = [
        { icon: "registered.svg", label: "Total Registrados", value: totalRegistrados },
        { icon: "check-ed.svg", label: "Check-in Realizados", value: totalCheckin },
        { icon: "shirts.svg", label: "Camisetas Pagadas", value: totalCamisaPagada },
        { icon: "lunch.svg", label: "Comidas pagadas", value: totalLunchPagada }
    ]
    return {
        code: 200,
        data: result
    };
});

export const registersForMonthAndGenderChart = catchAsync(async (req: AuthRequest, res: Response) => {
    const eventId = parseInt(req.params.id as string, 10);

    const rows = await generalModel.registersForMonthAndGender(eventId);

    const categories: string[] = [];
    const dataHombres: number[] = [];
    const dataMujeres: number[] = [];

    rows.forEach(row => {
        categories.push(row.mes_nombre);
        dataHombres.push(Number(row.total_hombres));
        dataMujeres.push(Number(row.total_mujeres));
    });

    return {
        code: 200,
        data: {
            categories: categories,
            series: [
                { name: 'Hombres', data: dataHombres },
                { name: 'Mujeres', data: dataMujeres }
            ]
        }
    };
});

export const weeklyRegistrationsChart = catchAsync(async (req, res) => {
    const eventId = parseInt(req.params.id as string, 10);

    const rows = await generalModel.weeklyRegistrations(eventId);

    const categories: string[] = [];
    const seriesData: number[] = [];
    let totalInscripciones = 0;
    rows.forEach((row: any) => {
        categories.push(`Semana ${row.numero_semana}`);
        const cantidad = Number(row.inscripciones);
        seriesData.push(cantidad);
        totalInscripciones += cantidad;
    });

    return {
        code: 200,
        data: {
            categories: categories,
            seriesData: seriesData,
            total: totalInscripciones
        }
    };
});

export const getTshirtSizesChart = catchAsync(async (req, res) => {
    const eventId = parseInt(req.params.id as string, 10);

    const rows = await generalModel.registersSizes(eventId);

    const seriesData: number[] = [];
    const labelsData: string[] = [];

    let totalCamisas = 0;
    rows.forEach(row => {
        totalCamisas += Number(row.cantidad);
    });

    rows.forEach(row => {
        labelsData.push(row.talla);

        seriesData.push(Number(row.cantidad));
    });

    return {
        code: 200,
        data: {
            series: seriesData,
            labels: labelsData
        }
    };
});

export const getLogs = catchAsync(async (req: AuthRequest, res: Response) => {
    const result = await generalModel.getLogs()
    return {
        code: 200,
        data: result
    };
})

export const getChurches = catchAsync(async (req, res) => {
    const result = await generalModel.getChurches()
    return {
        code: 200,
        data: result
    };
})


