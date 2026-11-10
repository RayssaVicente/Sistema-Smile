import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

export async function getBotSettings() {
  let config = await prisma.informacao.findFirst();

  if (!config) {
    config = await prisma.informacao.create({
      data: {
        id: 1,
        botNumber: process.env.BOT_NUMBER || "",
        assistantNumber: process.env.SECRETARY_NUMBER || "",
        evaluationLink: "https://g.page/r/SEU_LINK_DE_AVALIACAO_AQUI/review",
        botPrompt: "Você é o assistente da Clínica Smille..."
      }
    });
  }
  return config;
}

export async function getHistoryForSecretary(phone: string) {
  const cleanPhone = phone.replace(/\D/g, '');

  // Busca as mensagens reais gravadas no banco para o paciente
  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { patient: { phone: { contains: cleanPhone } } },
        { remoteJid: { contains: cleanPhone } }
      ]
    },
    orderBy: { createdAt: 'asc' },
    take: 50
  });

  if (!messages || messages.length === 0) {
    return `Nenhum histórico encontrado para o número: ${cleanPhone}`;
  }

  return messages
    .map((msg: any) => {
      const remetente = msg.role === 'user' ? '👤 Paciente' : '🤖 Robô';
      const horario = new Date(msg.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return `[${horario}] ${remetente}: ${msg.content}`;
    })
    .join('\n');
}