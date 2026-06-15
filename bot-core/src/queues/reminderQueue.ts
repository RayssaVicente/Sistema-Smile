import { Queue, Worker } from 'bullmq';
import axios from 'axios';

// Conexão com o Redis existente no seu Docker
const redisConnection = { host: 'localhost', port: 6379 };

// 1. Criar a Fila de Lembretes
export const reminderQueue = new Queue('reminderQueue', { connection: redisConnection });

// 2. Criar o Worker que vai de fato processar e enviar as mensagens na hora certa
const reminderWorker = new Worker('reminderQueue', async (job) => {
    const { phone, patientName, type, dateStr } = job.data;
    
    let textMessage = '';
    if (type === '24h') {
        textMessage = `Olá, ${patientName}! Seu sorriso tem um encontro marcado amanhã às ${dateStr} na Clínica Smile. Confirma sua presença? 😊🦷`;
    } else if (type === '1h') {
        textMessage = `Falta apenas 1 hora para o seu atendimento, ${patientName}! Estamos te aguardando às ${dateStr}. Se tiver algum imprevisto, nos avise. 🕒`;
    }

    try {
        await axios.post(
            `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.INSTANCE_NAME}`,
            { number: phone, text: textMessage },
            { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } }
        );
        console.log(`📡 [BullMQ] Lembrete de ${type} enviado com sucesso para ${phone}`);
    } catch (error: any) {
        console.error(`❌ [BullMQ] Erro ao enviar lembrete de ${type}:`, error.message);
    }
}, { connection: redisConnection });

// Função auxiliar para calcular o delay e adicionar na fila
export async function scheduleAppointmentReminders(patientName: string, phone: string, appointmentDate: Date, dateStr: string) {
    const now = Date.now();
    const appointmentTime = appointmentDate.getTime();

    // Tempos de antecedência em milissegundos
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const oneHourInMs = 1 * 60 * 60 * 1000;

    const delay24h = (appointmentTime - oneDayInMs) - now;
    const delay1h = (appointmentTime - oneHourInMs) - now;

    // Agenda o lembrete de 24h se a consulta for daqui a mais de 24h
    if (delay24h > 0) {
        await reminderQueue.add(`reminder-24h-${phone}`, 
            { phone, patientName, type: '24h', dateStr }, 
            { delay: delay24h }
        );
        console.log(`⏳ Lembrete de 24h agendado com delay de ${Math.round(delay24h / 60000)} minutos.`);
    }

    // Agenda o lembrete de 1h se a consulta for daqui a mais de 1h
    if (delay1h > 0) {
        await reminderQueue.add(`reminder-1h-${phone}`, 
            { phone, patientName, type: '1h', dateStr }, 
            { delay: delay1h }
        );
        console.log(`⏳ Lembrete de 1h agendado com delay de ${Math.round(delay1h / 60000)} minutos.`);
    }
}