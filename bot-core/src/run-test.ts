import Fastify from 'fastify';
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

import { PrismaClient } from '@prisma/client';
import { getChatHistory, saveChatMessage,getHistoryForSecretary  } from './lib/memory.js';
import { scheduleAppointmentReminders } from './queues/reminderQueue.js';
import { handleFeedbackFlow } from './lib/feedbackFlow.js';

import { iniciarAgendamentos, isBusinessHours } from './lib/schedule.js';
import { getBotSettings } from './services/configService.js';
import { getVideosByCategoryKey } from './queues/videoQueue.js'; // ou o caminho relativo correto para a pasta services onde você salvou o arquivo

import { GoogleGenAI } from '@google/genai';
import { 
    handleMainMenuFlow, 
    handleVideoSubmenusFlow, 
    handleCategoryVideoCodeFlow ,
    getMainMenuText,
    getVideoMenuText,
    PROCEDURES
} from './flows/menuFlow.js';

import { sendWhatsAppMessage, getAudioBase64, transcribeAudio, sendWhatsAppMedia, handleMessageFlow } from './flows/messageFlow.js';

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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = Fastify();

// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });


//  const processedMessages = new Set<string>();
 
 iniciarAgendamentos();

/* =========================================================
   WEBHOOK PRINCIPAL
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
    const NUMERO_ATENDENTE = settings.assistantNumber || process.env.SECRETARY_NUMBER;
    
    // Mova a extração para o início, logo abaixo de cleanNumber
    let messageText = data.message?.conversation || data.message?.extendedTextMessage?.text || '';

    if (messageText) {
        await saveChatMessage(cleanNumber, 'user', messageText);
    }

    
    

    // 1. INTERCEPTADOR DO FLUXO DE FEEDBACK (Colocado aqui para responder quem está avaliando)
   await handleFeedbackFlow(cleanNumber, 'Paciente', messageText, sendWhatsAppMessage);


        
    if (cleanNumber === NUMERO_ATENDENTE) {
    
        // Comando /agendar (Automático ou simplificado pela atendente)
        
        if (messageText.startsWith('/agendar')) {
            const payload = messageText.replace('/agendar', '').trim();
            const partes = payload.split('|').map((p: string) => p.trim());

            if (partes.length < 5) {
                await sendWhatsAppMessage(remoteJid, "⚠️ Formato incorreto. Use:\n/agendar Nome | Telefone | Dia/Mês | Hora | Procedimento");
                return reply.send({ status: 'ERROR' });
            }

            const [nomePaciente, telefonePaciente, dataStr, hora, procedimento] = partes;
            const limpaTelefone = telefonePaciente.replace(/\D/g, '');

            // 1. Busca ou cria o paciente no banco de dados automaticamente
            let patient = await prisma.patient.findFirst({
                where: { phone: { contains: limpaTelefone } }
            });

            if (!patient) {
                patient = await prisma.patient.create({
                    data: {
                        name: nomePaciente,
                        phone: limpaTelefone
                    }
                });
            } else {
                // Atualiza o nome caso tenha mudado no Easy Dental
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { name: nomePaciente }
                });
            }

            // 2. Formata a data e cria a consulta
            const [dia, mes] = dataStr.split("/");
            const ano = new Date().getFullYear();
            const dataFormatada = new Date(`${ano}-${mes}-${dia}T${hora}:00`);

            const appointment = await prisma.appointment.create({
                data: {
                    patientId: patient.id,
                    date: dataFormatada,
                    treatment: procedimento,
                    status: 'CONFIRMADO',
                    isConfirmed: true
                }
            });

            // 3. Confirmação para a atendente e aviso ao paciente
            await sendWhatsAppMessage(remoteJid, `✅ Agendamento salvo!\n*Paciente:* ${patient.name}\n*Tel:* ${limpaTelefone}\n*Data:* ${dataStr} às ${hora}\n*Procedimento:* ${procedimento}`);
            
            await sendWhatsAppMessage(
                patient.phone, 
                `Olá ${patient.name}! Sua consulta de ${procedimento} foi agendada para o dia ${dataStr} às ${hora}. Estamos aguardando você! 😊`
            );
            
            return reply.send({ status: 'SUCCESS' });
        }

        
        
        // Comando /finalizar 
        if (messageText.startsWith('/finalizar')) {
            const telefoneParaFinalizar = messageText.split(' ')[1]?.replace(/\D/g, '');  
            
            if (!telefoneParaFinalizar) {
                await sendWhatsAppMessage(remoteJid, "⚠️ Informe o número do paciente. Ex: /finalizar 5583999999999");
                return reply.send({ status: 'ERROR' });
            }

            const updated = await prisma.appointment.updateMany({
                where: { 
                    patient: { phone: { contains: telefoneParaFinalizar } },
                    status: { not: 'CONCLUIDO' }
                },
                data: { status: 'CONCLUIDO' }
            });

            if (updated.count > 0) {
                await sendWhatsAppMessage(remoteJid, `✅ Sucesso! Consulta de ${telefoneParaFinalizar} finalizada.`);

                // PUXA O LINK ATUALIZADO DIRETO DO BANCO DE DADOS!
                const linkAvaliacaoGoogle = settings.evaluationLink || "https://g.page/r/SEU_LINK_DE_AVALIACAO_AQUI/review";

                // Envia a mensagem de agradecimento e avaliação do Google no WhatsApp do paciente
                const mensagemAvaliacao = `Olá! Esperamos que tenha gostado do atendimento de hoje. 💙\n\nPara nos ajudar a melhorar cada vez mais, poderias avaliar sua experiência no Google? Leva menos de 1 minutinho:\n${linkAvaliacaoGoogle}\n\nMuito obrigado(a)!`;
                
                await sendWhatsAppMessage(telefoneParaFinalizar, mensagemAvaliacao);

            } else {
                await sendWhatsAppMessage(remoteJid, `⚠️ Nenhuma consulta pendente encontrada para ${telefoneParaFinalizar}.`);
            }
            
            return reply.send({ status: 'SUCCESS' });
        }

        // Comando /historico
        if (messageText.startsWith("/historico ")) {
            const partes = messageText.split(" ");
            const phoneToSearch = partes[1];  

            if (!phoneToSearch) {
                await sendWhatsAppMessage(remoteJid, "⚠️ Por favor, digite o número após o comando. Ex: /historico 5583999999999");
                return reply.send({ status: 'ERROR' });
            }

            const historicoFormatado = await getHistoryForSecretary(phoneToSearch);
            
            await sendWhatsAppMessage(remoteJid, 
                `📜 *Histórico de ${phoneToSearch}:*\n\n${historicoFormatado || "Nenhuma mensagem encontrada."}`
            );
            return reply.send({ status: 'SUCCESS' });
        }
        

        
    }

    

   
    
    try {
       
    // 1. Tentar capturar texto ou áudio
    let messageText = data.message?.conversation || data.message?.extendedTextMessage?.text || '';

    // 2. Se for áudio, tente transcrever com RETENTATIVA
    if (data.message?.audioMessage || data.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage) {
        console.log("Áudio detectado, processando...");
        const audioBase64 = await getAudioBase64(messageId); 
        if (audioBase64) {
            messageText = await transcribeAudio(audioBase64);
            console.log("Texto transcrito:", messageText);
        }
    }

    // 3. Se ainda não houver texto, não bloqueie, apenas ignore para evitar erro
    if (!messageText || messageText.trim() === "") {
        console.log(" Mensagem sem texto ou falha na transcrição.");
        return reply.send({ status: 'EMPTY' });
    }

        const trimmedInput = messageText.trim();

        // Use uma regex para extrair apenas o primeiro número que aparecer
        const optionMatch = trimmedInput.match(/\d+/); 
        const selectedOption = optionMatch ? optionMatch[0] : trimmedInput.toLowerCase();
        const lowerInput = trimmedInput.toLowerCase();

        const existingPatient = await prisma.patient.findUnique({ where: { phone: cleanNumber } });
        
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

        // Interceptador de Comprovantes Financeiros
        if (lowerInput.includes("pago") || lowerInput.includes("comprovante")) {
            const paymentAlert = `*ALERTA DE COMPROVANTE*\n\nO paciente *${safePatientName}* (${cleanNumber}) enviou uma mensagem mencionando pagamento/comprovante.`;
            await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', paymentAlert);
            await sendWhatsAppMessage(cleanNumber, "Obrigado por enviar! Nossa equipe validará o comprovante em instantes.");
            return reply.send({ status: 'SUCCESS' });
        }

        // Atalho Global para retorno (exceto se estiver digitando o nome)
        if ((lowerInput === 'menu' || lowerInput === 'voltar') && safePatientStatus !== "AWAITING_NAME" && safePatientStatus !== "SUBMENU_ESTETICA") {
            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { status: "MAIN_MENU",tempProcedure: null }
            });
            await sendWhatsAppMessage(cleanNumber, getMainMenuText(safePatientName));
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 0: Captura do Nome
       if (safePatientStatus === "AWAITING_NAME") {
            if (!existingPatient || safePatientName === "Novo Paciente" && (lowerInput === "oi" || lowerInput === "olá" || lowerInput === "bom dia")) {
                await sendWhatsAppMessage(cleanNumber, "Olá! Seja muito bem-vindo(a) à Clínica Smile. 🦷\n\nPara iniciarmos o seu atendimento, por favor, digite o seu **nome completo**:");
                return reply.send({ status: 'SUCCESS' });
            }

            // Extração do nome utilizando o Google Gemini
            const nameParserCompletion = await ai.models.generateContent({
                model: 'gemini-flash-lite-latest',
                contents: `Você é um extrator de nomes próprios. Extraia APENAS o nome completo digitado pelo usuário, limpando frases como "Meu nome é", "Nome:" ou erros de digitação como "Meu ome é". Formate com iniciais maiúsculas. Retorne somente o nome limpo.\n\nUsuário: ${trimmedInput}`
            });

            const extractedName = nameParserCompletion.text?.trim() || trimmedInput;
            
            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { name: extractedName, status: "MAIN_MENU" }
            });

            await sendWhatsAppMessage(cleanNumber, getMainMenuText(extractedName));
            return reply.send({ status: 'SUCCESS' });
        }

        const menuTratado = await handleMainMenuFlow(
            safePatientStatus, 
            selectedOption, 
            safePatientName, 
            cleanNumber, 
            patient, 
            prisma, 
            reply, 
            sendWhatsAppMessage, 
            isBusinessHours
        );
        if (menuTratado) return;

        const videoTratado = await handleVideoSubmenusFlow(
            safePatientStatus, 
            selectedOption, 
            cleanNumber, 
            safePatientName, 
            patient, 
            prisma, 
            reply, 
            sendWhatsAppMessage, 
            sendWhatsAppMedia
        );
        if (videoTratado) return;

        const categoriaTratada = await handleCategoryVideoCodeFlow(
            safePatientStatus, 
            lowerInput, 
            cleanNumber, 
            patient, 
            reply, 
            processarVideoDoBanco
        );
        if (categoriaTratada) return;


         
        // try {
        //     const response = await ai.models.generateContent({
        //         model: 'gemini-flash-lite-latest',
        //         contents: messageText,
        //         config: {
        //             systemInstruction: "Analise se a mensagem do paciente é uma emergência odontológica grave (ex: hemorragias, dificuldade respiratória, reações alérgicas severas, febre muito alta). Retorne APENAS a palavra 'SIM' ou 'NAO'.",
        //         }
        //     });

        //     const triagemResultado = response.text ? response.text.trim().toUpperCase() : '';

        //     // CORREÇÃO: Só executa o fluxo de urgência se a IA responder estritamente "SIM"
        //     if (triagemResultado === "SIM") {
        //         // 1. Defina a mensagem base para a secretaria
        //         const mensagemAtendente = `🚨 *URGÊNCIA DETECTADA (IA)*\n\n` +
        //                                     `Paciente: *${safePatientName}* (${cleanNumber})\n` +
        //                                     `Relato: "${messageText}"\n\n` +
        //                                     `*[Clique aqui para avaliar e atender](https://wa.me/${cleanNumber})*`;

        //         // 2. Lógica de decisão única
        //         if (isBusinessHours()) {
        //             // Notifica normal e avisa o paciente
        //             await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', mensagemAtendente);
        //             await sendWhatsAppMessage(cleanNumber, "Recebi sua mensagem. Nossa equipe de recepção foi notificada sobre sua urgência e entrará em contato em instantes para sua triagem.");
        //         } else {
        //             // Notifica como "Fora de Horário" e avisa o paciente sobre o pronto-socorro
        //             await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', `⚠️ *ALERTA FORA DE HORÁRIO*\n${mensagemAtendente}`);
        //             await sendWhatsAppMessage(cleanNumber, "Recebi seu relato de urgência. Como estamos fora do horário comercial, caso seja uma emergência grave (hemorragia, dificuldade para respirar), dirija-se ao pronto-socorro mais próximo. Nossa equipe verificará sua mensagem assim que iniciarmos o expediente.");
        //         }
                
        //         return reply.send({ status: 'SUCCESS' });
        //     }
        // } catch (error) {
        //     console.error("Erro na triagem com IA, seguindo fluxo normal:", error);
        //     // Caso a IA falhe, o código simplesmente continua para o menu abaixo
        // }


        
        if (safePatientStatus === "SUBMENU_PROCEDURES") {
            const selected = selectedOption;
            if (!PROCEDURES[selected]) {
                await sendWhatsAppMessage(cleanNumber, "Por favor, escolha uma opção válida. Digite um número de *1 a 8* correspondente ao procedimento ou *Voltar* para o menu:");
                return reply.send({ status: 'SUCCESS' });
            }

            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { status: "AWAITING_DATE", tempProcedure: PROCEDURES[selected] }
            });

          
            const hoje = new Date();
            const amanha = new Date(hoje);
            amanha.setDate(amanha.getDate() + 1);
            
            // Formata o dia de amanhã para exibir no exemplo
            const diaAmanha = amanha.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
            
            // Formata um exemplo para daqui a 3 dias
            const diaFuturo = new Date(hoje);
            diaFuturo.setDate(hoje.getDate() + 3);
            const diaExemplo = diaFuturo.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

            const mensagem = `Ótima escolha! Agora, digite a *data e o horário* que deseja realizar o seu atendimento para *${PROCEDURES[selected]}*.\n\n` +
                            `Exemplo: *Amanhã (${diaAmanha}) às 14:00* ou *Dia ${diaExemplo} às 10:30*.`;
            
            await sendWhatsAppMessage(cleanNumber, mensagem);
            return reply.send({ status: 'SUCCESS' });
        }


        interface VideoData {
            url: string;
            cap: string;
        }

        type VideoMap = {
            [key: string]: VideoData;
        };

        

    async function processarVideoDoBanco(
        categoryKey: string, 
        choice: string, 
        phone: string, 
        patientId: string, 
        menuAnterior: string
    ): Promise<void> {
        const videoChoice = choice.toLowerCase();

        if (videoChoice === 'voltar') {
            await prisma.patient.update({ where: { id: patientId }, data: { status: menuAnterior } });
            await sendWhatsAppMessage(phone, getVideoMenuText());
            return;
        }

        const category = await prisma.videoCategory.findUnique({
            where: { categoryKey },
            include: { videos: true }
        });

        if (!category || category.videos.length === 0) {
            await sendWhatsAppMessage(phone, "Nenhum vídeo encontrado para esta categoria.");
            return;
        }

        const videoEncontrado = category.videos.find(
            (v: any) => v.code?.toLowerCase() === videoChoice
        );

        if (videoEncontrado) {
            // Envia o vídeo real puxado do banco (com a URL do Google Drive do banco e legenda)
            await sendWhatsAppMedia(phone, videoEncontrado.url, videoEncontrado.caption);
        } else {
            await sendWhatsAppMessage(phone, "Opção inválida. Digite um código válido da lista ou *Voltar*.");
        }
    }

    // =================================================================
    // 1. FUNÇÃO PARA EXIBIR O MENU DA CATEGORIA (Busca do Banco)
        // =================================================================
        // async function enviarVideosCategoria(categoryKey: string, cleanNumber: string, reply: any) {
        //     const categoriaVideos = await getVideosByCategoryKey(categoryKey);

        //     if (!categoriaVideos || categoriaVideos.videos.length === 0) {
        //         await sendWhatsAppMessage(cleanNumber, "Desculpe, ainda não temos vídeos cadastrados para esta categoria.");
        //         return reply.send({ status: 'SUCCESS' });
        //     }

        //     let textoMenu = `*Galeria de Vídeos: ${categoriaVideos.title || 'Orientações'}*\n\n` +
        //                     `Digite o código correspondente ao vídeo que deseja assistir:\n\n`;

        //     for (const video of categoriaVideos.videos) {
        //         // Ex: *b1* - Botox que deu errado
        //         textoMenu += ` *${video.code.toLowerCase()}* - ${video.caption}\n`;
        //     }

        //     textoMenu += `\n↩️ Digite *Voltar* para retornar ao menu de vídeos.`;

        //     await sendWhatsAppMessage(cleanNumber, textoMenu);
        //     return reply.send({ status: 'SUCCESS' });
        // }

        // PASSO 3: Captura Inteligente e Agendamento da Data
        if (safePatientStatus === "AWAITING_DATE") {
            const agoraLocal = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

            // Chamada adaptada para o SDK oficial do Gemini
            const dateParserResponse = await ai.models.generateContent({
                model: 'gemini-flash-lite-latest',
                contents: trimmedInput,
                config: {
                    systemInstruction: `Você é um extrator de datas e horários. O cliente pode enviar várias opções. 
                    1. Liste todas as opções no formato: DD/MM às HH:MM.
                    2. Se possível, extraia a primeira data válida no formato ISO 8601 (Ano 2026) para salvar no sistema. Data e hora atual de referência: ${agoraLocal}.
                    Retorne o texto formatado para o usuário E a data ISO separada por um pipe (|). 
                    Exemplo: "10/05 às 14:00 e 12/05 às 10:00 | 2026-05-10T14:00:00-03:00". 
                    Se não entender, retorne "ERROR".`,
                }
            });

            const rawResult = dateParserResponse.text ? dateParserResponse.text.trim() : 'ERROR';

            if (rawResult.includes("ERROR")) {
                await sendWhatsAppMessage(cleanNumber, "Não consegui compreender o dia ou horário. Por favor, envie de forma clara (ex: 'Dia 30/05 às 15h ou dia 01/06 às 10h').");
                return reply.send({ status: 'SUCCESS' });
            }

            // Separa a lista para o usuário da data ISO para o banco
            const partes = rawResult.split('|');
            const listaDatas = partes[0]?.trim() || "Data não identificada";
            const dataISO = partes[1]?.trim();

            // Verificação de segurança para evitar o erro de tipo
            if (!dataISO) {
                await sendWhatsAppMessage(cleanNumber, "Não consegui extrair uma data válida. Por favor, tente novamente de forma simples.");
                return reply.send({ status: 'SUCCESS' });
            }

            const targetDate = new Date(dataISO);

            // 1. Salva no banco (mantendo sua lógica de agendamento)
            const chosenProcedure = patient.tempProcedure || "Consulta Geral";
            await prisma.appointment.create({
                data: { patientId: patient.id, date: targetDate, status: "pending", procedure: chosenProcedure }
            });
            await scheduleAppointmentReminders(safePatientName, cleanNumber, targetDate, "Horário a confirmar");

            // 2. Avisa a atendente com o LINK CLICÁVEL e as opções
            const summary = `🦷 *NOVO PRÉ-AGENDAMENTO*\n\n` +
                            `*Paciente:* ${safePatientName}\n` +
                            `*Procedimento:* ${chosenProcedure}\n` +
                            `*Opções do cliente:* ${listaDatas}\n\n` +
                            `*[Clique aqui para responder o cliente](https://wa.me/${cleanNumber})*`;
            
            await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', summary);

            // 3. Reseta o status e avisa o cliente
            await prisma.patient.update({ where: { id: patient.id }, data: { status: "MAIN_MENU" } });
            await sendWhatsAppMessage(cleanNumber, `Recebi suas opções: *${listaDatas}*.\n\nNossa recepção verificará a disponibilidade e te confirmará em breve!`);

            return reply.send({ status: 'SUCCESS' });
        }

      

    } catch (err: any) {
        console.error('❌ [Erro Crítico no Webhook]:', err.message);
        return reply.status(500).send({ status: 'ERROR', error: err.message });
    }
});





app.get('/bot/health', async (request, reply) => {
            // Validação manual de autenticação
            const authHeader = request.headers['authorization'];
            if (authHeader !== `Bearer ${process.env.SHARED_TOKEN}`) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }

            return {
                status: "ok",
                uptime_s: process.uptime(),
                whatsapp_conectado: true,
                fila_pendente: 0
            };
            });
            

// 3. Rota do Painel (Esta é a nova, para cobranças)

app.post('/bot/tarefa', async (request, reply) => {
    // Validação manual de autenticação
    const authHeader = request.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.SHARED_TOKEN}`) {
        return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { tarefa_id, tipo, paciente, dados } = request.body as any;

    // Lógica para tipo 'cobranca'
    if (tipo === 'cobranca') {
        const mensagem = `Olá ${paciente.nome}, tudo bem?\n\n` +
                         `Passando para lembrar da sua cobrança: ${dados.descricao}.\n` +
                         `Valor: R$ ${dados.valor}\n` +
                         `Vencimento: ${dados.vencimento}\n\n` +
                         `Clique aqui para pagar: ${dados.link_pagamento}`;

        await sendWhatsAppMessage(paciente.telefone, mensagem);
        
        console.log(`[Tarefa] Cobrança enviada com sucesso para ${paciente.nome}`);
        return { status: "enviada", tarefa_id };
    }

    // Se o tipo não for cobrança
    return reply.status(400).send({ error: 'Tipo de tarefa não suportado' });
});

// Adicione esta rota no seu arquivo index.ts
app.get('/testar-feedback', async (request, reply) => {
    try {
        console.log("🛠️ Iniciando disparo manual de feedback...");
        
        // Aqui você chama a mesma lógica que está no seu worker
        const consultas = await prisma.appointment.findMany({
            where: { status: 'CONCLUIDO', linkSent: false },
            include: { patient: true }
        });

        console.log(`🔍 Encontradas: ${consultas.length} consultas pendentes.`);

        for (const appt of consultas) {
            // Lógica de envio (a mesma que você usa no worker)
            await axios.post(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.INSTANCE_NAME}`, {
                number: appt.patient.phone,
                text: `Olá ${appt.patient.name}, como foi sua experiência? Avalie aqui: [LINK]`
            }, { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } });

            await prisma.appointment.update({
                where: { id: appt.id },
                data: { linkSent: true }
            });
        }

        return reply.send({ message: "Processo concluído com sucesso", total: consultas.length });
    } catch (error) {
        console.error("❌ Erro no teste manual:", error);
        return reply.status(500).send({ error: "Falha no disparo" });
    }
});


const PORT = 8010; 

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
    console.log(`\n🚀 Bot iniciado e escutando na porta: ${PORT}`);
}).catch((err) => {
    console.error("Erro ao iniciar:", err);
    process.exit(1);
});