import { PrismaClient } from '@prisma/client';
import { CronJob } from 'cron';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

export const feedbackWorker = new CronJob('*/10 * * * *', async () => {
    console.log("🔍 [Worker] Verificando consultas para feedback...");
    
    const consultas = await prisma.appointment.findMany({
        where: { 
            status: 'CONCLUIDO', 
            linkSent: false 
        },
        include: { patient: true },
        take: 5 
    });

    for (const appt of consultas) {
        try {
            // 1. Trava de segurança no appointment
            await prisma.appointment.update({
                where: { id: appt.id },
                data: { linkSent: true }
            });

            // 2. Atualiza o status do paciente no banco para travar no fluxo de nota
            await prisma.patient.update({
                where: { id: appt.patient.id },
                data: { status: 'AGUARDANDO_NOTA' }
            });

            // 3. Dispara a mensagem via Evolution API
            await axios.post(
                `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.INSTANCE_NAME}`,
                { 
                    number: appt.patient.phone, 
                    text: `Olá ${appt.patient.name}, tudo bem? Aqui é da Smille Odontologia! 🦷\n\nEsperamos que sua consulta tenha sido excelente. De 1 a 5 estrelas, como você avalia nosso atendimento de hoje?` 
                },
                { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } }
            );

            console.log(`🚀 Feedback enviado com sucesso para: ${appt.patient.name}`);
        } catch (e) {
            console.error(`❌ Erro ao enviar feedback para ${appt.patient.phone}:`, e);
        }
    }
}, null, true, 'America/Sao_Paulo');