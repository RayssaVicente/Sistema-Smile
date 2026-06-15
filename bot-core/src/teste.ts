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
import { SYSTEM_PROMPT } from './lib/prompt.js';
import { getChatHistory, saveChatMessage } from './lib/memory.js';
import { scheduleAppointmentReminders } from './queues/reminderQueue.js';

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

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

const PROCEDURES: Record<string, string> = {
  '1': 'Clínica Geral',
  '2': 'Implantes',
  '3': 'Limpeza',
  '4': 'Clareamento',
  '5': 'Emergência Dental',
  '6': 'Dentes Sisos',
  '7': 'Harmonização Facial',
  '8': 'Outros Tratamentos'
};

/* =========================================================
   FUNÇÕES AUXILIARES E ENVIO DE MENSAGENS
========================================================= */

async function sendWhatsAppMessage(phone: string, text: string) {
  try {
    console.log(`[WhatsApp] Tentando enviar mensagem para ${phone}...`);
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.INSTANCE_NAME}`,
      { number: phone, text },
      { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } }
    );
  } catch (error: any) {
    console.error(`❌ Erro ao enviar mensagem:`, error.response?.data || error.message);
  }
}

async function sendWhatsAppMedia(phone: string, mediaUrl: string, caption: string = "") {
  try {
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.INSTANCE_NAME}`,
      {
        number: phone,
        mediatype: "video",
        fileName: "Video-Orientacao.mp4",
        media: mediaUrl,
        caption: caption
      },
      { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } }
    );
  } catch (error: any) {
    console.error(`❌ Erro ao enviar mídia:`, error.response?.data || error.message);
  }
}

const convertAudio = (inputPath: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath).audioCodec('libmp3lame').toFormat('mp3')
      .on('error', (err) => reject(err)).on('end', () => resolve()).save(outputPath);
  });
};

async function getAudioBase64(messageId: string) {
  try {
    const response = await axios.post(
      `${process.env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${process.env.INSTANCE_NAME}`,
      { message: { key: { id: messageId } } },
      { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } }
    );
    return response.data?.base64 || '';
  } catch (error) { return ''; }
}

async function transcribeAudio(base64Audio: string) {
  const timestamp = Date.now();
  const tempFile = path.join(process.cwd(), `temp_${timestamp}.opus`);
  const convertedFile = path.join(process.cwd(), `ready_${timestamp}.mp3`);
  try {
    const audioBuffer = Buffer.from(base64Audio.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
    fs.writeFileSync(tempFile, audioBuffer);
    await convertAudio(tempFile, convertedFile);
    const form = new FormData();
    form.append('file', fs.createReadStream(convertedFile), { filename: 'audio.mp3', contentType: 'audio/mp3' });
    form.append('model', 'whisper-large-v3');
    const transcription = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
    });
    return transcription.data.text || '';
  } catch (error) { return ''; }
  finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    if (fs.existsSync(convertedFile)) fs.unlinkSync(convertedFile);
  }
}

function getMainMenuText(name: string): string {
  return `Olá, *${name}*! Seja bem-vindo(a) à nossa Central de Atendimento. 🦷\n\n` +
         `Por favor, digite apenas o *número* da opção desejada:\n\n` +
         `1️⃣ - Marcar Consulta\n` +
         `2️⃣ - Remarcar Consulta\n` +
         `3️⃣ - Dúvidas após Atendimento e Cirurgias\n` +
         `4️⃣ - Outros Assuntos`;
}

function getVideoMenuText(): string {
  return `🩺 *Central de Cuidados e Pós-Atendimento* 🎬\n\n` +
         `Selecione o assunto ou o procedimento que você realizou para ver os vídeos com as orientações do doutor:\n\n` +
         `1️⃣ - Aparelho Ortodôntico\n` +
         `2️⃣ - Botox e Preenchimento\n` +
         `3️⃣ - Bruxismo\n` +
         `4️⃣ - Canal, Cáries e Restaurações (Resina)\n` +
         `5️⃣ - Consequência da Perda dos Dentes\n` +
         `6️⃣ - Tratamentos de Gengiva e Enxertos\n` +
         `7️⃣ - Implantes Dentários\n` +
         `8️⃣ - Lentes de Contacto Dentárias\n` +
         `9️⃣ - Bichectomia e Lipo de Papada\n` +
         `🔟 - Prevenção Odontológica Geral\n\n` +
         `🚨 *URGÊNCIA:* Se você passou por uma cirurgia recente e está tendo uma emergência grave, digite *11* para falar com a **Valdirtene**.\n\n` +
         `↩️ Digite *Voltar* para o menu principal.`;
}

/* =========================================================
   WEBHOOK PRINCIPAL
========================================================= */
app.post('/webhook/whatsapp', async (request, reply) => {
    console.log("[Webhook] Nova requisição recebida.");
    
    const payload = request.body as any;
    const data = payload?.data;

    if (!data?.key || data.key.fromMe || !data.key.remoteJid) {
        return reply.send({ status: 'IGNORED' });
    }

    const remoteJid: string = data.key.remoteJid;
    const cleanNumber = remoteJid.split('@')[0].replace(/\D/g, '');
    
    try {
        let messageText = data.message?.conversation || data.message?.extendedTextMessage?.text || '';

        if (data.message?.audioMessage) {
            const audioBase64 = await getAudioBase64(data.key.id);
            if (audioBase64) messageText = await transcribeAudio(audioBase64);
        }

        if (!messageText) return reply.send({ status: 'EMPTY' });
        
        const trimmedInput = messageText.trim();
        const lowerInput = trimmedInput.toLowerCase();

        const existingPatient = await prisma.patient.findUnique({ where: { phone: cleanNumber } });
        
        let patient = await prisma.patient.upsert({
            where: { phone: cleanNumber },
            update: {}, 
            create: { phone: cleanNumber, name: "Novo Paciente", status: "MAIN_MENU" }
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
                data: { status: "MAIN_MENU" }
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

            const nameParserCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: 'system',
                        content: `Você é um extrator de nomes próprios. Extraia APENAS o nome completo digitado pelo usuário, limpando frases como "Meu nome é", "Nome:" ou erros de digitação como "Meu ome é". Formate com iniciais maiúsculas. Retorne somente o nome limpo.`
                    },
                    { role: 'user', content: trimmedInput }
                ],
                model: 'llama-3.3-70b-versatile'
            });

            const extractedName = nameParserCompletion.choices[0]?.message?.content?.trim() || trimmedInput;
            
            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { name: extractedName, status: "MAIN_MENU" }
            });

            await sendWhatsAppMessage(cleanNumber, getMainMenuText(extractedName));
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 1: Menu Principal de 4 Opções
        if (safePatientStatus === "MAIN_MENU") {
            if (trimmedInput === '1') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_PROCEDURES" }
                });
                const subMenuText = `Perfeito! Selecione o procedimento desejado para a sua consulta:\n\n` +
                                    `1️⃣ - Clínica Geral\n` +
                                    `2️⃣ - Implantes\n` +
                                    `3️⃣ - Limpeza\n` +
                                    `4️⃣ - Clareamento\n` +
                                    `5️⃣ - Emergência Dental\n` +
                                    `6️⃣ - Dentes Sisos\n` +
                                    `7️⃣ - Harmonização Facial\n` +
                                    `8️⃣ - Outros Tratamentos\n\n` +
                                    `↩️ Digite *Voltar* para retornar ao menu anterior.`;
                await sendWhatsAppMessage(cleanNumber, subMenuText);
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (trimmedInput === '2') {
                const changeSummary = `🔄 *SOLICITAÇÃO DE REMARCAÇÃO*\n\nO paciente *${safePatientName}* (${cleanNumber}) solicitou uma alteração de horário e aguarda retorno humano na recepção.`;
                await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', changeSummary);

                await sendWhatsAppMessage(cleanNumber, `Entendido, *${safePatientName}*! Encaminhei os seus dados para a nossa recepção agora mesmo. Em instantes um de nossos atendentes entrará em contato para ajustar o seu horário.`);
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (trimmedInput === '3') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_VIDEOS" }
                });
                await sendWhatsAppMessage(cleanNumber, getVideoMenuText());
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (trimmedInput === '4') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "CONCLUDED" }
                });
                await sendWhatsAppMessage(cleanNumber, `Compreendido! Pode digitar sua dúvida ou falar sobre o assunto desejado que meu assistente de IA irá te responder agora mesmo:`);
                return reply.send({ status: 'SUCCESS' });
            }

            await sendWhatsAppMessage(cleanNumber, `Opção inválida. Por favor, escolha um número de 1 a 4:\n\n` + getMainMenuText(safePatientName));
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 2: Validação do Submenu Expandido de Procedimentos (1 a 8)
        if (safePatientStatus === "SUBMENU_PROCEDURES") {
            const selected = trimmedInput;
            if (!PROCEDURES[selected]) {
                await sendWhatsAppMessage(cleanNumber, "Por favor, escolha uma opção válida. Digite um número de *1 a 8* correspondente ao procedimento ou *Voltar* para o menu:");
                return reply.send({ status: 'SUCCESS' });
            }

            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { status: "AWAITING_DATE", tempProcedure: PROCEDURES[selected] }
            });

            await sendWhatsAppMessage(cleanNumber, `Ótima escolha! Agora, digite a *data e o horário* que deseja realizar o seu atendimento para *${PROCEDURES[selected]}*.\n\nExemplo: *Amanhã às 14:00* ou *Dia 30/05 às 10:30*.`);
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 2.5: SUBMENU DE VÍDEOS GERAIS
        if (safePatientStatus === "SUBMENU_VIDEOS") {
            const op = trimmedInput;

            if (op === '1') {
                await sendWhatsAppMessage(cleanNumber, "Aguarde um instante, estou preparando o vídeo sobre Aparelho Ortodôntico...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1uP4xdyWDLBYHAD6Bk3ymBYC9uZN8K1mL", "🦷 *O que fazer antes dos aparelhos*");
            } 
            else if (op === '2') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_ESTETICA" }
                });

                const esteticaMenuText = `*Galeria de Vídeos: Botox e Preenchimento* \n\n` +
                                         `Digite o código correspondente ao vídeo que deseja assistir:\n\n` +
                                         ` *b1* - Botox que deu errado\n` +
                                         ` *b2* - Botox marca ruins\n` +
                                         ` *b3* - Botox e Preenchimento\n` +
                                         ` *b4* - Botox e Preenchimento 02\n` +
                                         ` *p1* - Preenchedores\n` +
                                         ` *p2* - Preenchimento\n\n` +
                                         `↩️ Digite *Voltar* para retornar ao menu de vídeos.`;

                await sendWhatsAppMessage(cleanNumber, esteticaMenuText);
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (op === '3') {
                await sendWhatsAppMessage(cleanNumber, "Carregando orientações sobre Bruxismo...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1URZUUv_kB5yunzx715QW_hx-nVkB0fFy", " *00 - Você sabia bruxismo*");
            } 
            else if (op === '4') {
                await sendWhatsAppMessage(cleanNumber, "Preparando explicações de Canal, Cáries e Restaurações...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=SEU_ID_DO_DRIVE_AQUI", " *1 - Canal e Pino*");
            } 
            else if (op === '5') {
                await sendWhatsAppMessage(cleanNumber, " Localizando arquivo de ausência estrutural dentária...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=SEU_ID_DO_DRIVE_AQUI", " *Consequência perda dos dentes*");
            } 
            else if (op === '6') {
                await sendWhatsAppMessage(cleanNumber, "Carregando os informativos sobre Cuidados Gengivais e Enxertos...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=SEU_ID_DO_DRIVE_AQUI", " *2 - Enxerto gengival*");
            } 
            else if (op === '7') {
                await sendWhatsAppMessage(cleanNumber, "Preparando materiais explicativos de Implantes...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=SEU_ID_DO_DRIVE_AQUI", " *01 - Implantes mal feito*");
            } 
            else if (op === '8') {
                await sendWhatsAppMessage(cleanNumber, " Carregando portfólio de Estética e Lentes de Contato...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=SEU_ID_DO_DRIVE_AQUI", " *2 - Lentes de contato*");
            } 
            else if (op === '9') {
                await sendWhatsAppMessage(cleanNumber, " Buscando as mídias de Bichectomia e Redução de Papada...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=SEU_ID_DO_DRIVE_AQUI", " *001 - Bichectomia*");
            } 
            else if (op === '10') {
                await sendWhatsAppMessage(cleanNumber, " Carregando dicas de Prevenção Odontológica...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=SEU_ID_DO_DRIVE_AQUI", " *Prevenção odontológica*");
            } 
            else if (op === '11') {
                const alertSecretary = ` *EMERGÊNCIA CIRÚRGICA CRÍTICA*\n\nO paciente *${safePatientName}* (${cleanNumber}) selecionou a opção de emergência grave pós-cirúrgica no menu.`;
                await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', alertSecretary);
                await sendWhatsAppMessage(cleanNumber, ` *ATENDIMENTO DE URGÊNCIA*\n\nPara casos de intercorrências graves, dores agudas ou emergências cirúrgicas maiores, entre em contato imediatamente com a **Valdirtene** pelo telefone/WhatsApp: **(83) 99999-9999**.`);
                return reply.send({ status: 'SUCCESS' });
            } 
            else {
                await sendWhatsAppMessage(cleanNumber, `Opção inválida. Por favor, selecione um número de 1 a 11 ou digite *Voltar* para o menu principal.`);
                return reply.send({ status: 'SUCCESS' });
            }

            await sendWhatsAppMessage(cleanNumber, "💡 Digite *Voltar* a qualquer momento para ver o menu de vídeos de orientações.");
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO INTERNO: TRATAMENTO DE ESCOLHA INDIVIDUAL DA ESTÉTICA (CORRIGIDO)
        if (safePatientStatus === "SUBMENU_ESTETICA") {
            const videoChoice = lowerInput;

            if (videoChoice === 'b1') {
                await sendWhatsAppMessage(cleanNumber, "Carregando vídeo b1...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1IbNWBYRjNb7B6s1dsc_qTKJbJS9wB8g9", " *b1 - Botox que deu errado*");
                return reply.send({ status: 'SUCCESS' }); // Adicionado
            } 
            else if (videoChoice === 'b2') {
                await sendWhatsAppMessage(cleanNumber, "Carregando vídeo b2...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1CZMStI1ELNGAtswEEk8YM-MAYK7ESFy2", " *b2 - Botox marca ruim*");
                return reply.send({ status: 'SUCCESS' }); // Adicionado
            } 
            else if (videoChoice === 'b3') {
                await sendWhatsAppMessage(cleanNumber, "Carregando vídeo b3...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1jRUYuxb946ntW8grsgzypu9iPYRxXugH", " *b3 - Botox e Preenchimento*");
                return reply.send({ status: 'SUCCESS' }); // Adicionado
            } 
            else if (videoChoice === 'b4') {
                await sendWhatsAppMessage(cleanNumber, "Carregando vídeo b4...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1cWkMy87z09-rQe_3tosTdaaBmCoc3jbX", " *b4 - Botox e Preenchimento 02*");
                return reply.send({ status: 'SUCCESS' }); // Adicionado
            } 
            else if (videoChoice === 'p1') {
                await sendWhatsAppMessage(cleanNumber, "Carregando vídeo p1...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1TzSFM_BZpSSI7anVU7SW5KsyAo387cWe", "p1 - Preenchedores");
                return reply.send({ status: 'SUCCESS' }); // Adicionado
            }
            else if (videoChoice === 'p2') {
                await sendWhatsAppMessage(cleanNumber, "Carregando vídeo p2...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1gbxizvEybRZRJspfuJU_Nv2aV59nJ576", " *p2 - Preenchimento*");
                return reply.send({ status: 'SUCCESS' }); // Adicionado
            } 
            else if (videoChoice === 'voltar') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_VIDEOS" }
                });
                await sendWhatsAppMessage(cleanNumber, getVideoMenuText());
                return reply.send({ status: 'SUCCESS' });
            }
            else {
                await sendWhatsAppMessage(cleanNumber, "Opção inválida. Digite um código válido da lista (ex: *b1*, *b2*) ou digite *Voltar* para retornar.");
                return reply.send({ status: 'SUCCESS' });
            }
            
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 3: Captura Inteligente e Agendamento da Data
        if (safePatientStatus === "AWAITING_DATE") {
            const agoraLocal = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

            const dateParserCompletion = await groq.chat.completions.create({
                messages: [
                    { 
                        role: 'system', 
                        content: `Você é um normalizador de datas. Ano 2026. Hora atual no Brasil: ${agoraLocal}. Retorne APENAS a representation ISO 8601 com fuso horário do Brasil (-03:00). Exemplo: "2026-05-30T14:00:00-03:00". Se não entender retorne "ERROR".` 
                    },
                    { role: 'user', content: trimmedInput }
                ],
                model: 'llama-3.3-70b-versatile'
            });

            const parsedResult = dateParserCompletion.choices[0]?.message?.content?.trim() || 'ERROR';

            if (parsedResult.includes("ERROR")) {
                await sendWhatsAppMessage(cleanNumber, "Não consegui compreender o dia ou horário. Digite de forma clara, por favor. Exemplo: *30/05 às 15:00*.");
                return reply.send({ status: 'SUCCESS' });
            }

            const targetDate = new Date(parsedResult);
            const chosenProcedure = patient.tempProcedure || "Consulta Geral";

            await prisma.appointment.create({
                data: { patientId: patient.id, date: targetDate, status: "pending", procedure: chosenProcedure }
            });

            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { status: "MAIN_MENU" }
            });

            const formattedDate = targetDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            const formattedTime = targetDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
            
            await scheduleAppointmentReminders(safePatientName, cleanNumber, targetDate, formattedTime);

            await sendWhatsAppMessage(cleanNumber, `Confirmado, *${safePatientName}*! Seu pré-agendamento para *${chosenProcedure}* foi realizado para o dia ${formattedDate} às ${formattedTime}.\n\nPara voltar ao menu principal, digite *Menu*.`);

            const summary = `🦷 *NOVO PRÉ-AGENDAMENTO* \n\n*Paciente:* ${safePatientName}\n*Procedimento:* ${chosenProcedure}\n*Data/Hora:* ${formattedDate} às ${formattedTime}`;
            await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', summary);
            return reply.send({ status: 'SUCCESS' });
        }

        /* ---------------------------------------------------------
            FLUXO IA LIVRE (OPÇÃO 4 - COM GANCHO DE AGENDAMENTO)
        --------------------------------------------------------- */
        await prisma.message.create({
            data: { role: 'user', content: messageText, patientId: patient.id }
        });

        const history = await getChatHistory(remoteJid);

        const cleanerPrompt = `${SYSTEM_PROMPT}\n\n` +
            `CONTEXTO OBRIGATÓRIO DO USUÁRIO ATUAL:\n` +
            `- Você está conversando ativamente com o paciente: **${safePatientName}**.\n` +
            `- Ele já forneceu o nome. Nunca pergunte o nome dele novamente.\n\n` +
            `REGRA DE FLUXO COMERCIAL CRÍTICA (CONFORME SOLICITAÇÃO DO CLIENTE):\n` +
            `- Responda à pergunta do paciente de maneira prestativa, curta e acolhedora.\n` +
            `- Ao terminar sua explicação, faça obrigatoriamente um gancho comercial ativo convidando-o a agendar uma consulta para avaliar o caso de perto. Diga claramente que ele pode digitar a palavra **"Voltar"** para abrir o menu e escolher a Opção 1 (Marcar Consulta).\n` +
            `- Proibido citar valores, preços de consultas ou taxas.`;

        const completion = await groq.chat.completions.create({
            messages: [{ role: 'system', content: cleanerPrompt }, ...history, { role: 'user', content: messageText }],
            model: 'llama-3.3-70b-versatile'
        });

        const responseText = completion.choices[0]?.message?.content || '';

        await prisma.message.create({
            data: { role: 'assistant', content: responseText, patientId: patient.id }
        });

        await saveChatMessage(remoteJid, 'user', messageText);
        await saveChatMessage(remoteJid, 'assistant', responseText);

        await sendWhatsAppMessage(cleanNumber, responseText);
        return reply.send({ status: 'SUCCESS' });

    } catch (err: any) {
        console.error('❌ [Erro Crítico no Webhook]:', err.message);
        return reply.status(500).send({ status: 'ERROR', error: err.message });
    }
});

const PORT = Number(process.env.PORT) || 3001;
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
    console.log(`\n🤖 Igor V5.2 Online | Menu de Vídeos e Estética Corrigidos | Porta ${PORT}`);
});