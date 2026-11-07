import nodemailer from 'nodemailer';
import { UserDataRegister } from '../interfaces/register.interface';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

export const sendConfirmationMail = async (data: UserDataRegister) => {
    try {
        const emergenciaTexto = `${data.contacto_emergencia.nombre_contacto || 'No especificado'} · ${data.contacto_emergencia.telefono_contacto || ''}`;

        const htmlTemplate = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #f8fafc; color: #334155;">
                
                <!-- Encabezado -->
                <div style="text-align: center; margin-bottom: 25px;">
                    <h1 style="color: #0f172a; margin-bottom: 5px; font-size: 26px;">¡Registro Confirmado!</h1>
                    <p style="color: #64748b; margin-top: 0; font-size: 15px;">FEJA Nivel Union - 2026</p>
                </div>

                <!-- Tarjeta de Resumen Blanca -->
                <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 30px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                    <p style="text-align: center; color: #475569; margin-top: 0; margin-bottom: 30px; font-size: 15px; line-height: 1.5;">
                        Tu información ha sido guardada correctamente.<br/>
                        A continuación, te presentamos el resumen de tu registro al congreso.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 15px;">
                        <!-- Fila Nombre -->
                        <tr>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9;">
                                <strong style="color: #1e293b;">Nombre completo:</strong>
                            </td>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9; color: #64748b; text-align: right;">
                                ${data.nombre}  ${data.apellidos}
                            </td>
                        </tr>
                        
                        <!-- Fila Conferencia -->
                        <tr>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9;">
                                <strong style="color: #1e293b;">Conferencia:</strong>
                            </td>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9; color: #64748b; text-align: right;">
                                ${data.nombre_conferencia}
                            </td>
                        </tr>

                        <!-- Fila Estado -->
                        <tr>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9;">
                                <strong style="color: #1e293b;">Estado:</strong>
                            </td>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9; color: #64748b; text-align: right;">
                                ${data.nombre_estado}
                            </td>
                        </tr>

                        <!-- Fila Iglesia -->
                        <tr>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9;">
                                <strong style="color: #1e293b;">Iglesia:</strong>
                            </td>
                            <td style="padding: 16px 0; border-bottom: 1px solid #f1f5f9; color: #64748b; text-align: right;">
                                ${data.iglesia}
                            </td>
                        </tr>

                        <!-- Fila Emergencia -->
                        <tr>
                            <td style="padding: 16px 0;">
                                <strong style="color: #1e293b;">Contacto de emergencia:</strong>
                            </td>
                            <td style="padding: 16px 0; color: #64748b; text-align: right;">
                                Relación: ${data.contacto_emergencia.relacion}, ${emergenciaTexto}
                            </td>
                        </tr>
                    </table>
                </div>

                <!-- Botón Decorativo Inferior -->
                <div style="text-align: center; margin-top: 35px;">
                    <a href="https://congreso-union.fesjaz.com" style="background-color: #0f172a; color: #ffffff; padding: 14px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block;">
                        Ir a la página del evento
                    </a>
                </div>
                
                <p style="text-align: center; font-size: 12px; color: #94a3b8; margin-top: 40px; line-height: 1.5;">
                    Este es un correo automático generado por el sistema de registro.<br/>Por favor no respondas a esta dirección.
                </p>
            </div>
        `;

        const correoDestino = data.correo || data.correo;

        const mailOptions = {
            from: `FEJA 2026 ${process.env.EMAIL_USER}`,
            to: correoDestino,
            subject: 'Confirmación de Registro - FEJA 2026 🎉',
            html: htmlTemplate
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Correo de resumen enviado exitosamente: ' + info.messageId);

        return true;
    } catch (error) {
        console.error('Error al enviar el correo:', error);
        return false;
    }
};

