import { PrismaClient } from '@prisma/client';
import { getBotSettings } from '../services/configService.js';

const prisma = new PrismaClient();

export async function handleFeedbackFlow(telefone: string, nomeCliente: string, mensagemRecebida: string, sendMessage: Function) {
    const textoLimpo = mensagemRecebida.trim();

    // Busca o paciente no banco pelo telefone para saber o status atual dele
    const patient = await prisma.patient.findUnique({
        where: { phone: telefone }
    });

    // Se o paciente não existe ou o status dele é IDLE (normal), o feedback não interfere em nada
    if (!patient || patient.status === 'IDLE' || !patient.status) {
        return false; // Retorna false para indicar que o fluxo de feedback ignorou a mensagem e o bot livre pode processar
    }

    // ETAPA 1: O BOT JÁ PEDIU A NOTA E ESTÁ AGUARDANDO A RESPOSTA NUMÉRICA
    if (patient.status === 'AGUARDANDO_NOTA') {
        const nota = parseInt(textoLimpo);

        if (isNaN(nota) || nota < 1 || nota > 5) {
            await sendMessage(telefone, "Por favor, responda apenas com um número de *1 a 5* estrelas para avaliarmos nosso atendimento.");
            return true; // Mensagem tratada pelo fluxo de feedback
        }

        await processarNota(patient.id, telefone, nomeCliente, nota, sendMessage);
        return true;
    }

    // ETAPA 2: O CLIENTE DEU NOTA BAIXA E ESTÁ DIGITANDO O COMENTÁRIO
    if (patient.status === 'AGUARDANDO_COMENTARIO') {
        const comentario = textoLimpo;

        // Atualiza o último feedback pendente com o comentário real do cliente
        const ultimoFeedback = await prisma.feedback.findFirst({
            where: { telefone },
            orderBy: { criadoEm : 'desc' }
        });

        if (ultimoFeedback) {
            await prisma.feedback.update({
                where: { id: ultimoFeedback.id },
                data: { comentario }
            });
        } else {
            await prisma.feedback.create({
                data: { telefone, nome: nomeCliente, nota: 1, comentario }
            });
        }

        // Reseta o status do paciente de volta para IDLE (liberando o chat normal)
        await prisma.patient.update({
            where: { id: patient.id },
            data: { status: 'IDLE' }
        });

        await sendMessage(
            telefone, 
            `Muito obrigado pelo seu feedback, ${nomeCliente}. Já repassamos sua mensagem para a nossa gestão para resolvermos isso o mais rápido possível. Pedimos desculpas por qualquer transtorno!`
        );

        // Dispara o alerta para a Valdirene com o link wa.me limpo e direto
        const settings = await getBotSettings();
        const NUMERO_ATENDENTE = settings.assistantNumber || process.env.SECRETARY_NUMBER || '';
        const numeroValdireneLimpo = NUMERO_ATENDENTE.replace(/\D/g, '');

        if (numeroValdireneLimpo) {
            const linkWaPaciente = `https://wa.me/55${telefone}`;
            const alertaGestao = `🚨 *ALERTA DE INSATISFAÇÃO (NOTA BAIXA)*\n\n` +
                                 `O(a) paciente *${nomeCliente}* (${telefone}) relatou um problema:\n` +
                                 `_"${comentario}"_\n\n` +
                                 `👉 [Ligar/Falar com o paciente](${linkWaPaciente})`;

            await sendMessage(numeroValdireneLimpo, alertaGestao);
        }

        console.log(`[ALERTA GESTÃO] Feedback de ${nomeCliente} (${telefone}). Comentário: "${comentario}"`);
        return true;
    }

    return false;
}

async function processarNota(patientId: string, telefone: string, nome: string, nota: number, sendMessage: Function) {
    const settings = await getBotSettings();
    const linkAvaliacaoGoogle = settings.evaluationLink || "https://g.page/r/SEU_LINK_DE_AVALIACAO_AQUI/review";

    if (nota >= 4) {
        // Nota Alta -> Salva feedback e envia link do Google
        await prisma.feedback.create({
            data: { telefone, nome, nota, comentario: "Nota alta - Google enviado" }
        });

        await prisma.patient.update({
            where: { id: patientId },
            data: { status: 'IDLE' }
        });

        await sendMessage(
            telefone,
            `Ficamos extremamente felizes em saber disso! ⭐\n\nPoderia nos fazer um favorzinho e deixar sua avaliação no nosso Google para ajudar mais pessoas a sorrirem com a gente? Segue o link:\n👉 ${linkAvaliacaoGoogle}\n\nMuito obrigado(a)!`
        );
    } else {
        // Nota Baixa -> Salva nota provisória, MUDA O STATUS para AGUARDANDO_COMENTARIO,
        // MAS ENVIA O LINK DO GOOGLE IGUALMENTE (Conformidade com a política do Google)
        await prisma.feedback.create({
            data: { telefone, nome, nota, comentario: "Aguardando comentário de insatisfação" }
        });

        await prisma.patient.update({
            where: { id: patientId },
            data: { status: 'AGUARDANDO_COMENTARIO' }
        });

        await sendMessage(
            telefone,
            `Poxa, sentimos muito por isso. Queremos muito melhorar. O que aconteceu para você dar essa nota? Seu feedback é muito importante para nós. 💙\n\nCaso queira registrar sua experiência publicamente, também deixamos nosso link do Google à disposição:\n👉 ${linkAvaliacaoGoogle}`
        );
    }
}