import Fastify from 'fastify';
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import cors from '@fastify/cors';

import { getChatHistory, saveChatMessage, getHistoryForSecretary } from '../lib/memory.js';
import { scheduleAppointmentReminders } from '../queues/reminderQueue.js';
import { handleFeedbackFlow } from '../lib/feedbackFlow.js';
import { iniciarAgendamentos, isBusinessHours } from '../lib/schedule.js';
import { getBotSettings } from '../services/configService.js';
import { sendWhatsAppMessage, getAudioBase64, transcribeAudio, sendWhatsAppMedia } from '../flows/messageFlow.js';

import { GoogleGenAI } from '@google/genai';
import { 
    handleMainMenuFlow, 
    handleVideoSubmenusFlow, 
    handleCategoryVideoCodeFlow,
    getMainMenuText,
    getVideoMenuText,
    PROCEDURES
} from '../flows/menuFlow.js';

// Configuração do Gemini (Google GenAI)
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("❌ ERRO CRÍTICO: GEMINI_API_KEY não foi definida no arquivo .env");
}
const ai = new GoogleGenAI({ apiKey: apiKey! });

// Configuração do banco de dados
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("❌ ERRO CRÍTICO: DATABASE_URL não foi definida no arquivo .env!");
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: dbUrl || ''
    },
  },
});

const app = Fastify();

await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
});

iniciarAgendamentos();

// 3. Lista fixa de palavras de urgência (Fail-Safe independente da IA)
const PALAVRAS_URGENCIA = ['sangramento', 'sangrando', 'dor forte', 'inchaço', 'febre', 'pus', 'urgência', 'emergência'];

// Middleware de autenticação Admin
const adminAuth = async (request: any, reply: any) => {
    const authHeader = request.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.SHARED_TOKEN}`) {
        return reply.status(401).send({ error: 'Unauthorized' });
    }
};

/* =========================================================
    ROTAS ADMINISTRATIVAS / CRM
========================================================= */

app.get('/admin/config', { preHandler: adminAuth }, async (request, reply) => {
    const settings = await getBotSettings();
    return reply.send(settings);
});

app.post('/admin/config', { preHandler: adminAuth }, async (request: any, reply) => {
    const { assistantNumber, evaluationLink } = request.body as any;
    
    const updated = await prisma.informacao.upsert({
        where: { id: 1 },
        update: { assistantNumber, evaluationLink },
        create: { id: 1, assistantNumber, evaluationLink, botNumber: process.env.BOT_NUMBER || "" }
    });

    return reply.send({ success: true, updated });
});

app.get('/admin/historico/:phone', { preHandler: adminAuth }, async (request: any, reply) => {
    const { phone } = request.params as { phone: string };
    const historico = await getHistoryForSecretary(phone);
    return reply.send({ phone, historico });
});

app.get('/admin/agendamentos', { preHandler: adminAuth }, async (request, reply) => {
    const agendamentos = await prisma.appointment.findMany({
        include: { patient: true },
        orderBy: { date: 'desc' },
        take: 50
    });
    return reply.send(agendamentos);
});

app.get('/admin/avaliacoes', { preHandler: adminAuth }, async (request, reply) => {
    const avaliacoes = await prisma.appointment.findMany({
        where: { status: 'CONCLUIDO' },
        include: { patient: true },
        orderBy: { date: 'desc' }
    });
    return reply.send(avaliacoes);
});

app.post('/admin/cobranca', { preHandler: adminAuth }, async (request: any, reply) => {
    const { telefone, nome, descricao, valor, vencimento, link_pagamento } = request.body as any;
    const limpaTelefone = telefone.replace(/\D/g, '');

    const mensagem = `Olá ${nome}, tudo bem?\n\n` +
                     `Passando para lembrar da sua cobrança: ${descricao}.\n` +
                     `Valor: R$ ${valor}\n` +
                     `Vencimento: ${vencimento}\n\n` +
                     `Clique aqui para pagar: ${link_pagamento}`;

    await sendWhatsAppMessage(limpaTelefone, mensagem);
    return reply.send({ success: true, message: "Cobrança enviada com sucesso!" });
});

// Finalizar atendimento (Envia o link do Google para TODOS - Compliance)
app.post('/admin/finalizar', { preHandler: adminAuth }, async (request: any, reply) => {
    const { telefone } = request.body as any;
    const limpaTelefone = telefone.replace(/\D/g, '');

    const updated = await prisma.appointment.updateMany({
        where: { 
            patient: { phone: { contains: limpaTelefone } },
            status: { not: 'CONCLUIDO' }
        },
        data: { status: 'CONCLUIDO' }
    });

    if (updated.count > 0) {
        const settings = await getBotSettings();
        const linkAvaliacaoGoogle = settings.evaluationLink || "https://g.page/r/SEU_LINK/review";
        
        const msgAvaliacao = `Olá! Esperamos que tenha gostado do seu atendimento na Clínica Smille! 💙\n\n` +
                             `Para nos ajudar a melhorar cada vez mais, poderias avaliar sua experiência no Google? Leva menos de 1 minutinho:\n` +
                             `${linkAvaliacaoGoogle}\n\n` +
                             `De 1 a 5, qual nota você daria para o nosso atendimento hoje?`;

        await sendWhatsAppMessage(limpaTelefone, msgAvaliacao);

        const patient = await prisma.patient.findUnique({ where: { phone: limpaTelefone } });
        if (patient) {
            await prisma.patient.update({
                where: { id: patient.id },
                data: { status: 'AGUARDANDO_NOTA' }
            });
        }

        return reply.send({ success: true, message: `Atendimento de ${limpaTelefone} finalizado e pesquisa enviada.` });
    }

    return reply.status(404).send({ error: `Nenhuma consulta pendente encontrada para ${limpaTelefone}.` });
});


/* =========================================================
    WEBHOOK PRINCIPAL DO WHATSAPP
========================================================= */
app.post('/webhook/whatsapp', async (request, reply) => {
    console.log("[Webhook] Nova requisição recebida.");
    
    const payload = request.body as any;
    const data = payload?.data;
    if (!data?.key || data.key.fromMe) return reply.send({ status: 'IGNORED' });

    const messageId = data.key?.id;
    const remoteJid = data.key.remoteJid;
    const cleanNumber = remoteJid.split('@')[0].replace(/\D/g, '');
   
    const settings = await getBotSettings();
    const NUMERO_ATENDENTE = settings.assistantNumber || process.env.SECRETARY_NUMBER || '';
    const numeroValdireneLimpo = NUMERO_ATENDENTE.replace(/\D/g, '');
    
    let messageText = data.message?.conversation || data.message?.extendedTextMessage?.text || '';

    // 5. Histórico: Salva mensagem do usuário
    if (messageText) {
        await saveChatMessage(cleanNumber, 'user', messageText);
    }

    // 3. Urgência (Fail-Safe por Palavras-Chave independente da IA)
    const lowerInput = messageText.toLowerCase();
    const temUrgencia = PALAVRAS_URGENCIA.some(termo => lowerInput.includes(termo));

    if (temUrgencia) {
        const linkWaPaciente = `https://wa.me/55${cleanNumber}`;
        const alertaUrgencia = `🚨 *URGÊNCIA DETECTADA (SISTEMA DE SEGURANÇA)*\n\n` +
                               `O paciente *${cleanNumber}* relatou um sintoma crítico:\n` +
                               `_"${messageText}"_\n\n` +
                               `👉 [Abrir conversa com o paciente](${linkWaPaciente})`;

        if (numeroValdireneLimpo) {
            await sendWhatsAppMessage(numeroValdireneLimpo, alertaUrgencia);
        }
        
        const respostaUrgencia = "⚠️ Detectamos que você mencionou um sintoma que requer atenção imediata. Nossa equipe foi alertada e entrará em contato com você agora mesmo!";
        await saveChatMessage(cleanNumber, 'assistant', respostaUrgencia);
        await sendWhatsAppMessage(cleanNumber, respostaUrgencia);
        return reply.send({ status: 'URGENCY_TRIGGERED' });
    }

    // 1 & 2. Interceptador de Feedback (Gerencia nota 1 a 5 e comentários)
    const feedbackTratado = await handleFeedbackFlow(cleanNumber, 'Paciente', messageText, sendWhatsAppMessage);
    if (feedbackTratado) {
        return reply.send({ status: 'FEEDBACK_PROCESSED' });
    }

    // Comandos diretos enviados pelo número da atendente/secretária
    if (cleanNumber === numeroValdireneLimpo) {
        if (messageText.startsWith('/agendar')) {
            const bodyPayload = messageText.replace('/agendar', '').trim();
            const partes = bodyPayload.split('|').map((p: string) => p.trim());

            if (partes.length < 5) {
                await sendWhatsAppMessage(remoteJid, "⚠️ Formato incorreto. Use:\n/agendar Nome | Telefone | Dia/Mês | Hora | Procedimento");
                return reply.send({ status: 'ERROR' });
            }

            const [nomePaciente, telefonePaciente, dataStr, hora, procedimento] = partes;
            const limpaTelefone = telefonePaciente.replace(/\D/g, '');

            let patient = await prisma.patient.findFirst({
                where: { phone: { contains: limpaTelefone } }
            });

            if (!patient) {
                patient = await prisma.patient.create({
                    data: { name: nomePaciente, phone: limpaTelefone }
                });
            } else {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { name: nomePaciente }
                });
            }

            const [dia, mes] = dataStr.split("/");
            const ano = new Date().getFullYear();
            const dataFormatada = new Date(`${ano}-${mes}-${dia}T${hora}:00`);

            await prisma.appointment.create({
                data: {
                    patientId: patient.id,
                    date: dataFormatada,
                    treatment: procedimento,
                    status: 'CONFIRMADO',
                    isConfirmed: true
                }
            });

            const msgConfirmacao = `✅ Agendamento salvo!\n*Paciente:* ${patient.name}\n*Tel:* ${limpaTelefone}\n*Data:* ${dataStr} às ${hora}\n*Procedimento:* ${procedimento}`;
            await saveChatMessage(remoteJid, 'assistant', msgConfirmacao);
            await sendWhatsAppMessage(remoteJid, msgConfirmacao);
            
            const msgPaciente = `Olá ${patient.name}! Sua consulta de ${procedimento} foi agendada para o dia ${dataStr} às ${hora}. Estamos aguardando você! 😊`;
            await saveChatMessage(limpaTelefone, 'assistant', msgPaciente);
            await sendWhatsAppMessage(limpaTelefone, msgPaciente);
            
            return reply.send({ status: 'SUCCESS' });
        }
        
        if (messageText.startsWith('/historico ')) {
            const partes = messageText.split(" ");
            const phoneToSearch = partes[1];  

            if (!phoneToSearch) {
                await sendWhatsAppMessage(remoteJid, "⚠️ Por favor, digite o número após o comando. Ex: /historico 5583999999999");
                return reply.send({ status: 'ERROR' });
            }

            const historicoFormatado = await getHistoryForSecretary(phoneToSearch);
            await sendWhatsAppMessage(remoteJid, `📜 *Histórico de ${phoneToSearch}:*\n\n${historicoFormatado || "Nenhuma mensagem encontrada."}`);
            return reply.send({ status: 'SUCCESS' });
        }
    }

    try {
        if (data.message?.audioMessage || data.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage) {
            const audioBase64 = await getAudioBase64(messageId); 
            if (audioBase64) {
                messageText = await transcribeAudio(audioBase64);
                await saveChatMessage(cleanNumber, 'user', `[Áudio transcrito]: ${messageText}`);
            }
        }

        if (!messageText || messageText.trim() === "") {
            return reply.send({ status: 'EMPTY' });
        }

        const trimmedInput = messageText.trim();
        const optionMatch = trimmedInput.match(/\d+/); 
        const selectedOption = optionMatch ? optionMatch[0] : trimmedInput.toLowerCase();

        let patient = await prisma.patient.upsert({
            where: { phone: cleanNumber },
            update: {},
            create: { 
                phone: cleanNumber, 
                name: "Novo Paciente", 
                status: "AWAITING_NAME" 
            }
        });

        let safePatientName = patient.name || "Novo Paciente";
        let safePatientStatus = patient.status || "MAIN_MENU";

        // Interceptador de Comprovantes com Link wa.me direto para Valdirene
        if (lowerInput.includes("pago") || lowerInput.includes("comprovante")) {
            const linkWaPaciente = `https://wa.me/55${cleanNumber}`;
            const paymentAlert = `*ALERTA DE COMPROVANTE*\n\nO paciente *${safePatientName}* (${cleanNumber}) enviou uma mensagem mencionando pagamento/comprovante.\n\n👉 [Falar com o paciente](${linkWaPaciente})`;
            
            if (numeroValdireneLimpo) {
                await sendWhatsAppMessage(numeroValdireneLimpo, paymentAlert);
            }
            
            const msgRetorno = "Obrigado por enviar! Nossa equipe validará o comprovante em instantes.";
            await saveChatMessage(cleanNumber, 'assistant', msgRetorno);
            await sendWhatsAppMessage(cleanNumber, msgRetorno);
            return reply.send({ status: 'SUCCESS' });
        }

        // Atalho Global para retorno ao menu
        if ((lowerInput === 'menu' || lowerInput === 'voltar') && safePatientStatus !== "AWAITING_NAME" && safePatientStatus !== "SUBMENU_ESTETICA") {
            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { status: "MAIN_MENU", tempProcedure: null }
            });
            const menuText = getMainMenuText(safePatientName);
            await saveChatMessage(cleanNumber, 'assistant', menuText);
            await sendWhatsAppMessage(cleanNumber, menuText);
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 0: Captura do Nome
        if (safePatientStatus === "AWAITING_NAME") {
            if (safePatientName === "Novo Paciente" && (lowerInput === "oi" || lowerInput === "olá" || lowerInput === "bom dia" || lowerInput === "boa tarde")) {
                const msgBoasVindas = "Olá! Seja muito bem-vindo(a) à Clínica Smile. 🦷\n\nPara iniciarmos o seu atendimento, por favor, digite o seu **nome completo**:";
                await saveChatMessage(cleanNumber, 'assistant', msgBoasVindas);
                await sendWhatsAppMessage(cleanNumber, msgBoasVindas);
                return reply.send({ status: 'SUCCESS' });
            }

            const nameParserCompletion = await ai.models.generateContent({
                model: 'gemini-flash-lite-latest',
                contents: `Você é um extrator de nomes próprios. Extraia APENAS o nome completo digitado pelo usuário. Formate com iniciais maiúsculas. Retorne somente o nome limpo.\n\nUsuário: ${trimmedInput}`
            });

            const extractedName = nameParserCompletion.text?.trim() || trimmedInput;
            
            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { name: extractedName, status: "MAIN_MENU" }
            });

            const menuText = getMainMenuText(extractedName);
            await saveChatMessage(cleanNumber, 'assistant', menuText);
            await sendWhatsAppMessage(cleanNumber, menuText);
            return reply.send({ status: 'SUCCESS' });
        }

        const menuTratado = await handleMainMenuFlow(
            safePatientStatus, selectedOption, safePatientName, cleanNumber, patient, prisma, reply, sendWhatsAppMessage, isBusinessHours
        );
        if (menuTratado) return;

        return reply.send({ status: 'SUCCESS' });

    } catch (err: any) {
        console.error('❌ [Erro Crítico no Webhook]:', err.message);
        return reply.status(500).send({ status: 'ERROR', error: err.message });
    }
});

const PORT = Number(process.env.PORT) || 8010; 
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
    console.log(`\n🚀 Bot iniciado e escutando na porta: ${PORT}`);
}).catch((err) => {
    console.error("Erro ao iniciar:", err);
    process.exit(1);
});