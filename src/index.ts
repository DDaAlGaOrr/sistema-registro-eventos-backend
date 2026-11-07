import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { router } from './routes';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/test', (req: Request, res: Response) => {
    res.json({
        message: '¡Hola, mundo!',
        status: 'success'
    });
});

app.use('/api', router);

app.listen(port, () => {
    console.log(`[server]: El servidor está corriendo en http://localhost:${port}`);
});