import { connection } from './redis.js';

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// export async function getChatHistory(remoteJid: string) {
//   // 1. Tenta pegar do Redis (Cache rápido)
//   const history = await connection.lrange(`chat:${remoteJid}`, 0, 10);
  
//   if (history.length > 0) {
//     return history.reverse().map(msg => JSON.parse(msg));
//   }

//   // 2. Se não tiver no Redis, busca no Prisma (Backup persistente)
//   const dbHistory = await prisma.message.findMany({
//     where: { patient: { phone: remoteJid } },
//     orderBy: { createdAt: 'desc' },
//     take: 10
//   });

//   return dbHistory.reverse().map(msg => ({ role: msg.role, content: msg.content }));
// }
 export async function getChatHistory(remoteJid: string) {
    try {
        const cleanPhone = remoteJid.replace(/\D/g, '');

        // 1. Tenta pegar do Redis primeiro (já que o bot interage por lá em tempo real)
        const redisHistory = await connection.lrange(`chat:${remoteJid}`, 0, 20);
        if (redisHistory && redisHistory.length > 0) {
            return redisHistory.reverse().map(msg => {
                const parsed = JSON.parse(msg);
                return {
                    role: parsed.role,
                    content: parsed.content,
                    createdAt: new Date()
                };
            });
        }

        // 2. Se não estiver no Redis, busca no Prisma pelo telefone do paciente
        const patient = await prisma.patient.findFirst({
            where: {
                OR: [
                    { phone: remoteJid },
                    { phone: cleanPhone }
                ]
            },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });

        if (!patient || !patient.messages || patient.messages.length === 0) {
            return [];
        }

        return patient.messages.map(msg => ({
            role: msg.role,
            content: msg.content,
            createdAt: msg.createdAt
        }));
    } catch (error) {
        console.error("Erro ao buscar histórico:", error);
        return [];
    }
}
export async function saveChatMessage(remoteJid: string, role: 'user' | 'assistant', content: string) {
    // 1. Lógica do Redis (mantém a performance e o limite de 10 mensagens)
    const message = JSON.stringify({ role, content });
    await connection.lpush(`chat:${remoteJid}`, message);
    await connection.ltrim(`chat:${remoteJid}`, 0, 10);
    await connection.expire(`chat:${remoteJid}`, 3600);

    // 2. Lógica do Prisma (mantém a persistência no banco para o Prisma Studio)
    try {
        const patient = await prisma.patient.findUnique({ where: { phone: remoteJid } });
        if (patient) {
            await prisma.message.create({
                data: { role, content, patientId: patient.id }
            });
        }
    } catch (error) {
        console.error("Erro ao persistir mensagem no banco:", error);
    }
}

export async function getHistoryForSecretary(remoteJid: string) {
    // Busca as últimas 5 mensagens
    const history = await prisma.message.findMany({
        where: { patient: { phone: remoteJid } },
        orderBy: { createdAt: 'desc' },
        take: 5
    });

    // Inverte para ficar na ordem cronológica (da mais antiga para a mais nova)
    return history.reverse().map(msg => {
        const roleLabel = msg.role === 'user' ? '👤 Paciente' : '🤖 Bot';
        return `*${roleLabel}*: ${msg.content}`;
    }).join('\n');
}



