import cron from 'node-cron';
import { prisma } from './prisma.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { syncConsultasComBanco } from '../workers/syncConsultas.js';

export function isBusinessHours() {
    const now = new Date();
    // Ajuste para o fuso horário da sua região (ex: BRT -03:00)
    const brazilTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));

    const day = brazilTime.getDay(); // 0 = Domingo, 6 = Sábado
    const hour = brazilTime.getHours();

    const isWeekend = day === 0 || day === 6;
    const isWorkingHour = hour >= 8 && hour < 18;

    return !isWeekend && isWorkingHour;
}

// Função que verifica automaticamente as consultas finalizadas e envia a avaliação do Google
export async function verificarConsultasConcluidas() {
    try {
        const agora = new Date();

        // Busca consultas que ainda não foram concluídas e cujo horário já passou há mais de 40 minutos
        const consultasParaFinalizar = await prisma.appointment.findMany({
            where: {
                status: { not: 'CONCLUIDO' },
                linkSent: false,
                date: {
                    lte: new Date(agora.getTime() - 40 * 60000) // 40 minutos atrás
                }
            },
            include: {
                patient: true
            }
        });

        // Dentro da sua função verificarConsultasConcluidas no schedule.ts:
        for (const app of consultasParaFinalizar) {
            if (!app.patient?.phone) continue;

            // 1. Atualiza o status para CONCLUIDO e marca o link como enviado
            await prisma.appointment.update({
                where: { id: app.id },
                data: { 
                    status: 'CONCLUIDO',
                    linkSent: true 
                }
            });

            // 2. Dispara a mensagem inicial de feedback (que ativa o handleFeedbackFlow)
            const nomeCliente = app.patient.name || 'Paciente';
            const mensagemInicial = `Olá *${nomeCliente}*, aqui é da Smille Odontologia! 🦷✨\n\nEsperamos que sua consulta tenha sido excelente. De 1 a 5 estrelas, como você avalia nosso atendimento de hoje?`;

            await sendWhatsAppMessage(app.patient.phone, mensagemInicial);
            console.log(`✅ Consulta finalizada e pesquisa de satisfação enviada para: ${nomeCliente}`);
        }
    } catch (error) {
        console.error("Erro ao verificar consultas concluídas:", error);
    }
}

// Inicia todos os agendamentos (Cron)
export function iniciarAgendamentos() {
    // 1. Sincroniza com o EasyDental a cada 1 hora (das 08h às 18h)
    cron.schedule('0 8-18 * * *', () => {
        console.log("⏱️ Executando sincronização automática do EasyDental...");
        syncConsultasComBanco().catch(console.error);
    });

    // 2. Verifica consultas finalizadas a cada 10 minutos para disparar o Google Review
    cron.schedule('*/10 * * * *', () => {
        verificarConsultasConcluidas().catch(console.error);
    });
    
    console.log("✅ Agendador de tarefas (Cron) e automações iniciados com sucesso!");
}