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



async function sendWhatsAppMedia(
  phone: string,
  mediaUrl: string,
  caption = ""
) {
  try {
    console.log("Enviando mídia:");
    console.log("Número:", phone);
    console.log("URL:", mediaUrl);

    const response = await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.INSTANCE_NAME}`,
      {
        number: phone,
        mediatype: "video",
        fileName: "video.mp4",
        media: mediaUrl,
        caption
      },
      {
        headers: {
          apikey: process.env.EVOLUTION_API_KEY || ""
        }
      }
    );

    console.log("Sucesso:", response.data);
  } catch (error: any) {
    console.error(
      "Erro completo:",
      JSON.stringify(error.response?.data, null, 2)
    );
  }
}

const convertAudio = (inputPath: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath).audioCodec('libmp3lame').toFormat('mp3')
      .on('error', (err) => reject(err)).on('end', () => resolve()).save(outputPath);
  });
};

async function getAudioBase64(messageId: string, retries = 3): Promise<string> {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.post(
                `${process.env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${process.env.INSTANCE_NAME}`,
                { message: { key: { id: messageId } } },
                { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } }
            );
            
            if (response.data?.base64) return response.data.base64;
            
            // Espera um pouco antes da próxima tentativa
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error(`Tentativa ${i + 1} falhou ao buscar áudio.`);
        }
    }
    return '';
}

async function transcribeAudio(base64Audio: string) {
    const timestamp = Date.now();
    const tempFile = path.join(process.cwd(), `temp_${timestamp}.opus`);
    const convertedFile = path.join(process.cwd(), `ready_${timestamp}.mp3`);
    
    try {
        const audioBuffer = Buffer.from(base64Audio.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(tempFile, audioBuffer);
        
        // Garante a conversão
        await convertAudio(tempFile, convertedFile);
        
        // Verificação de segurança
        if (!fs.existsSync(convertedFile)) throw new Error("Arquivo convertido não encontrado");

        const form = new FormData();
        form.append('file', fs.createReadStream(convertedFile));
        form.append('model', 'whisper-large-v3');
        
        const transcription = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
        });
        
        return transcription.data.text || '';
    } catch (error: any) {
        console.error("❌ Erro na Transcrição Groq:", error.response?.data || error.message);
        return '';
    }
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
         `3️⃣ - Dúvidas após Atendimento e Cirurgias\n` 
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

 const processedMessages = new Set<string>();

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
    
    try {
       

    // 1. Tentar capturar texto ou áudio
    let messageText = data.message?.conversation || data.message?.extendedTextMessage?.text || '';

    // 2. Se for áudio, tente transcrever com RETENTATIVA
    if (data.message?.audioMessage || data.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage) {
        console.log("🎤 Áudio detectado, processando...");
        const audioBase64 = await getAudioBase64(messageId); 
        if (audioBase64) {
            messageText = await transcribeAudio(audioBase64);
            console.log("📝 Texto transcrito:", messageText);
        }
    }

    // 3. Se ainda não houver texto, não bloqueie, apenas ignore para evitar erro
    if (!messageText || messageText.trim() === "") {
        console.log("ℹ️ Mensagem sem texto ou falha na transcrição.");
        return reply.send({ status: 'EMPTY' });
    }

        
        
        // Onde você define a seleção:
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
                status: "AWAITING_NAME" // O usuário deve cair aqui ao chegar pela 1ª vez
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
                data: { status: "MAIN_MENU" }
            });
            await sendWhatsAppMessage(cleanNumber, getMainMenuText(safePatientName));
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 0: Captura do Nome
        // PASSO 0: Captura do Nome
        if (safePatientStatus === "AWAITING_NAME") {
            const saudações = ["oi", "olá", "bom dia", "boa tarde", "boa noite"];
            
            // Verifica se o que ele digitou é APENAS uma saudação
            if (saudações.includes(lowerInput)) {
                await sendWhatsAppMessage(cleanNumber, "Olá! Seja muito bem-vindo(a) à Smille Odontologia e Harmonização Facial. 🦷 Para iniciarmos o seu atendimento, por favor, digite o seu *nome completo*:**:");
                return reply.send({ status: 'SUCCESS' });
            }

            // Se não é saudação, assumimos que é o nome.
            // Usamos a IA para limpar o nome
            const nameParserCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: 'system',
                        content: `Você é um extrator de nomes. Extraia apenas o nome próprio do usuário. Retorne apenas o nome limpo.`
                    },
                    { role: 'user', content: trimmedInput }
                ],
                model: 'llama-3.3-70b-versatile'
            });

            const extractedName = nameParserCompletion.choices[0]?.message?.content?.trim() || trimmedInput;
            
            // Atualiza o paciente e MUDA O STATUS para MAIN_MENU
            patient = await prisma.patient.update({
                where: { id: patient.id },
                data: { name: extractedName, status: "MAIN_MENU" }
            });

            // Envia o menu principal após salvar o nome
            await sendWhatsAppMessage(cleanNumber, getMainMenuText(extractedName));
            return reply.send({ status: 'SUCCESS' });
        }

        // PASSO 1: Menu Principal de 4 Opções
        if (safePatientStatus === "MAIN_MENU") {
            if (selectedOption === '1') {
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
            else if (selectedOption === '2') {
                const changeSummary = `🔄 *SOLICITAÇÃO DE REMARCAÇÃO*\n\nO paciente *${safePatientName}* (${cleanNumber}) solicitou uma alteração de horário e aguarda retorno humano na recepção.`;
                await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', changeSummary);

                await sendWhatsAppMessage(cleanNumber, `Entendido, *${safePatientName}*! Encaminhei os seus dados para a nossa recepção agora mesmo. Em instantes um de nossos atendentes entrará em contato para ajustar o seu horário.`);
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (selectedOption === '3') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_VIDEOS" }
                });
                await sendWhatsAppMessage(cleanNumber, getVideoMenuText());
                return reply.send({ status: 'SUCCESS' });
            } 
            

            await sendWhatsAppMessage(cleanNumber, `Opção inválida. Por favor, escolha um número de 1 a 4:\n\n` + getMainMenuText(safePatientName));
            return reply.send({ status: 'SUCCESS' });
        }

        

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

            // --- CÁLCULO DINÂMICO PARA O EXEMPLO ---
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
            // ----------------------------------------

            await sendWhatsAppMessage(cleanNumber, mensagem);
            return reply.send({ status: 'SUCCESS' });
        }

        

        // PASSO 2.5: SUBMENU DE VÍDEOS GERAIS
        if (safePatientStatus === "SUBMENU_VIDEOS") {
            const op = selectedOption;

            if (op === '1') {
                await sendWhatsAppMessage(cleanNumber, "Aguarde um instante, estou preparando o vídeo sobre Aparelho Ortodôntico...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1uP4xdyWDLBYHAD6Bk3ymBYC9uZN8K1mL", "🦷 *O que fazer antes dos aparelhos*");
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (op === '2') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_ESTETICA" }
                });
                const esteticaMenuText = `*Galeria de Vídeos: Botox e Preenchimento* \n\n` +
                                         `Digite o código correspondente ao vídeo que deseja assistir:\n\n` +
                                         ` *b1* - Botox que deu errado\n *b2* - Botox marca ruins\n` +
                                         ` *b3* - Botox e Preenchimento\n *b4* - Botox e Preenchimento 02\n` +
                                         ` *p1* - Preenchedores\n *p2* - Preenchimento\n\n` +
                                         `↩️ Digite *Voltar* para retornar ao menu de vídeos.`;
                await sendWhatsAppMessage(cleanNumber, esteticaMenuText);
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (op === '3') {
                await sendWhatsAppMessage(cleanNumber, "Carregando orientações sobre Bruxismo...");
    
                // 2. Envie a mídia
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1cSxza_HRp_E4sewF5xTtt14GwwE-TIOo", "Você sabia bruxismo");
                
                // 3. RETORNE IMEDIATAMENTE (Isso impede que o código continue lendo o que vem abaixo)
                return reply.send({ status: 'SUCCESS' });
            } 
            else if (op === '4') {
                await sendWhatsAppMessage(
                    cleanNumber,
                    "Preparando explicações de Canal..."
                );

                await sendWhatsAppMedia(
                    cleanNumber,
                    "https://docs.google.com/uc?export=download&id=1trGWhNZColC6T1-FnNRrVjrBv7z2l_Zp",
                    "Prevenção ondotologica contra canal e cáries "
                );

                return reply.send({ status: 'SUCCESS' });
            }
            else if (op === '5') {
                await sendWhatsAppMessage(cleanNumber, "Localizando arquivo de ausência estrutural dentária...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1jmsyFLQg-iLYx-qNONf530JiiDDNCKcS", "Consequência perda dos dentes");
                return reply.send({ status: 'SUCCESS' });
            }
            else if (op === '6') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_IMPLANTES" }
                });
                const implantesMenuText = `*Galeria de Vídeos: Implantes Dentários* \n\n` +
                                         `Digite o código correspondente ao vídeo que deseja assistir:\n\n` +
                                         ` *i1* - "Implante mau feito"\n *i2* - "Implante falsificado"\n` +
                                         ` *i3* - "Implante Durabilidade"\n *i4* - "Antes e  Depois dos nosso implantes"\n` +
                                         `↩️ Digite *Voltar* para retornar ao menu de vídeos.`;
                await sendWhatsAppMessage(cleanNumber, implantesMenuText);
                return reply.send({ status: 'SUCCESS' });
            } 
           else if (op === '7') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_GENGIVAS" }
                });
                const gengivasMenuText = `*Galeria de Vídeos: Cuidados Gengivais* \n\n` +
                                         `Digite o código correspondente ao vídeo que deseja assistir:\n\n` +
                                         ` *g1* - "Você sabe o que é Periodontite?"\n *g2* - "Cuidados com as gengivas"\n` +
                                         ` *g3* - "Em que casos deve ser feito encherto gengival?"\n ` +
                                         `↩️ Digite *Voltar* para retornar ao menu de vídeos.`;
                await sendWhatsAppMessage(cleanNumber, gengivasMenuText);
                return reply.send({ status: 'SUCCESS' });
            } 
            
            else if (op === '8') {
                await sendWhatsAppMessage(cleanNumber, "Carregando portfólio de Estética e Lentes de Contato...");
                await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1d2mQW34yrWb7cyVa11CuKOVV-fN1RHjK", "Lentes de contato");
                return reply.send({ status: 'SUCCESS' });
            } 
           else if (op === '9') {
                patient = await prisma.patient.update({
                    where: { id: patient.id },
                    data: { status: "SUBMENU_PAPADA&BICHECTOMIA" }
                });
                const papadaBichectomiaMenuText = `*Galeria de Vídeos: Papada e Bichectomia* \n\n` +
                                                  `Digite o código correspondente ao vídeo que deseja assistir:\n\n` +
                                                  ` *P1* - "Saiba tudo sobre Papada e bichectomia"\n *P2* - "Emagrecimento facial"\n` +
                                                  ` *P3* - "Quem tem papada pequena pode fazer o procedimento?"\n ` + `*P4* - "Uma das maiores duvidas sobre bichectomia"\n` +
                                                  `↩️ Digite *Voltar* para retornar ao menu de vídeos.`;
                await sendWhatsAppMessage(cleanNumber, papadaBichectomiaMenuText);
                return reply.send({ status: 'SUCCESS' });
            } 
            
            else if (op === '10') {
                await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', `EMERGÊNCIA: O paciente ${cleanNumber} pediu ajuda.`);
                await sendWhatsAppMessage(cleanNumber, "Para emergências, contate a Valdirtene: (83) 99999-9999.");
                return reply.send({ status: 'SUCCESS' });
            }
            else {
                await sendWhatsAppMessage(cleanNumber, "Opção inválida. Digite um número de 1 a 10 ou *Voltar*.");
                return reply.send({ status: 'SUCCESS' });
            }
        }



        // Defina a estrutura dos dados do vídeo
        interface VideoData {
            url: string;
            cap: string;
        }

        // Defina o tipo VideoMap que você está usando
        type VideoMap = {
            [key: string]: VideoData;
        };

        async function processarVideo(
            videoMap: VideoMap, 
            choice: string, 
            phone: string, 
            patientId: string, 
            menuAnterior: string
        ): Promise<void> {
            const videoChoice = choice.toLowerCase();

            if (videoMap[videoChoice]) {
                const vid = videoMap[videoChoice];
                await sendWhatsAppMedia(phone, vid.url, vid.cap);
            } 
            else if (videoChoice === 'voltar') {
                await prisma.patient.update({ where: { id: patientId }, data: { status: menuAnterior } });
                // Certifique-se de que getVideoMenuText() retorne string
                await sendWhatsAppMessage(phone, getVideoMenuText());
            } 
            else {
                await sendWhatsAppMessage(phone, "Opção inválida. Digite um código válido ou *Voltar*.");
            }
        }

       if (safePatientStatus === "SUBMENU_ESTETICA") {
        const videoMap: VideoMap = {
            'b1': { url: "https://docs.google.com/uc?export=download&id=1IbNWBYRjNb7B6s1dsc_qTKJbJS9wB8g9", cap: "b1 - Botox que deu errado" },
            'b2': { url: "https://docs.google.com/uc?export=download&id=1CZMStI1ELNGAtswEEk8YM-MAYK7ESFy2", cap: "b2 - Botox marca ruim" },
            'b3': { url: "https://docs.google.com/uc?export=download&id=1jRUYuxb946ntW8grsgzypu9iPYRxXugH", cap: "b3 - Botox e Preenchimento" },
            'b4': { url: "https://docs.google.com/uc?export=download&id=1cWkMy87z09-rQe_3tosTdaaBmCoc3jbX", cap: "b4 - Botox e Preenchimento 02" },
            'p1': { url: "https://docs.google.com/uc?export=download&id=1TzSFM_BZpSSI7anVU7SW5KsyAo387cWe", cap: "p1 - Preenchedores" },
            'p2': { url: "https://docs.google.com/uc?export=download&id=1gbxizvEybRZRJspfuJU_Nv2aV59nJ576", cap: "p2 - Preenchimento" },


        };
        await processarVideo(videoMap, lowerInput, cleanNumber, patient.id, "SUBMENU_VIDEOS");
        return reply.send({ status: 'SUCCESS' });
    } 
    else if (safePatientStatus === "SUBMENU_IMPLANTES") {
        const videoMap: VideoMap = {
            'i1': { url: "https://docs.google.com/uc?export=download&id=1Y7UkiSXHe72yGoGdjtoX40DaEdFaMqFb", cap: "Implante mau feito" },
            'i2': { url: "https://docs.google.com/uc?export=download&id=1W4GWfrGC_LeMe-2cdOdxe_pRvIQNKsiG", cap: "Implante falsificado" },
            'i3': { url: "https://docs.google.com/uc?export=download&id=19k7a1eKCn5SxF02XGJkcd_L0kGzlWdpc", cap: "Implantes durabilidade" },
            'i4': { url: "https://docs.google.com/uc?export=download&id=13PN6OspjcL2mBtp2kSEFsn4Qld2snv0w", cap: "Antes e Depois implantes" }
        };
        await processarVideo(videoMap, lowerInput, cleanNumber, patient.id, "SUBMENU_VIDEOS");
        return reply.send({ status: 'SUCCESS' });
    }
    else if (safePatientStatus === "SUBMENU_GENGIVAS") {
        const videoMap: VideoMap = {
            'g1': { url: "https://docs.google.com/uc?export=download&id=1elJsDtQluCplekr6qK_JojASMoaGdMdc", cap: "Você sabe o que é Periodontite?" },
            'g2': { url: "https://docs.google.com/uc?export=download&id=1Se5nH1LqilgzuDItZs5ew-gtyCVW2ZIu", cap: "Cuidados para evitar gengival" },
            'g3': { url: "https://docs.google.com/uc?export=download&id=1xvz4cOb0SwVK3gLNVxNFFAE0bb5VwYXN", cap: "Em que casos deve ser feito encherto gengival?" },
           
        };
        await processarVideo(videoMap, lowerInput, cleanNumber, patient.id, "SUBMENU_VIDEOS");
        return reply.send({ status: 'SUCCESS' });
    }

     else if (safePatientStatus === "SUBMENU_PAPADA&BICHECTOMIA") {
        const videoMap: VideoMap = {
            'p1': { url: "https://docs.google.com/uc?export=download&id=1t4f8gLkDo4wvf7Rx41yghe8Navp8VlLT", cap: "Saiba tudo sobre Papada e bichectomia" },
            'p2': { url: "https://docs.google.com/uc?export=download&id=1-OgTbyud_KJXWOA1nWnrrqkJQzkxTUvn", cap: "Emagrecimento facial" },
            'p3': { url: "https://docs.google.com/uc?export=download&id=1ITjYIDqlIg9azHT1O4o1hmgCv1WVbxMP", cap: "Quem tem papada pequena pode fazer o procedimento?" },
            'p4': { url: "https://docs.google.com/uc?export=download&id=1HFKCcX-T0o-UfCDTlS_ZzywbxddZfVLB", cap: "Uma das maiores duvidas sobre bichectomia" },
           
        };
        await processarVideo(videoMap, lowerInput, cleanNumber, patient.id, "SUBMENU_VIDEOS");
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

          // Onde você envia a mensagem de confirmação de pré-agendamento:
        await sendWhatsAppMessage(cleanNumber, 
            `Recebi sua sugestão de horário para *${chosenProcedure}*: ${formattedDate} às ${formattedTime}.\n\n` +
            `Nossa equipe da recepção irá verificar a disponibilidade na agenda e confirmará com você em breve. Caso precise alterar, é só chamar!`
        );
            const summary = `🦷 *NOVO PRÉ-AGENDAMENTO* \n\n*Paciente:* ${safePatientName}\n*Procedimento:* ${chosenProcedure}\n*Data/Hora:* ${formattedDate} às ${formattedTime}`;
            await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', summary);
            return reply.send({ status: 'SUCCESS' });
        }

        /* ---------------------------------------------------------
            FLUXO IA LIVRE (OPÇÃO 4 - COM GANCHO DE AGENDAMENTO)
        --------------------------------------------------------- */
        // await prisma.message.create({
        //     data: { role: 'user', content: messageText, patientId: patient.id }
        // });

        // const history = await getChatHistory(remoteJid);

        // const cleanerPrompt = `${SYSTEM_PROMPT}\n\n` +
        //     `CONTEXTO OBRIGATÓRIO DO USUÁRIO ATUAL:\n` +
        //     `- Você está conversando ativamente com o paciente: **${safePatientName}**.\n` +
        //     `- Ele já forneceu o nome. Nunca pergunte o nome dele novamente.\n\n` +
        //     `REGRA DE FLUXO COMERCIAL CRÍTICA (CONFORME SOLICITAÇÃO DO CLIENTE):\n` +
        //     `- Responda à pergunta do paciente de maneira prestativa, curta e acolhedora.\n` +
        //     `- Ao terminar sua explicação, faça obrigatoriamente um gancho comercial ativo convidando-o a agendar uma consulta  para             avaliar     o caso de perto. Diga claramente que ele pode digitar a palavra **"Voltar"** para abrir o menu e escolher a         Opção 1 (Marcar Consulta).\n` +
        //     `- Proibido citar valores, preços de consultas ou taxas.`;

        // const completion = await groq.chat.completions.create({
        //     messages: [{ role: 'system', content: cleanerPrompt }, ...history, { role: 'user', content: messageText }],
        //     model: 'llama-3.3-70b-versatile'
        // });

        // const responseText = completion.choices[0]?.message?.content || '';

        // await prisma.message.create({
        //     data: { role: 'assistant', content: responseText, patientId: patient.id }
        // });

        // await saveChatMessage(remoteJid, 'user', messageText);
        // await saveChatMessage(remoteJid, 'assistant', responseText);

        // await sendWhatsAppMessage(cleanNumber, responseText);
        // return reply.send({ status: 'SUCCESS' });

    } catch (err: any) {
        console.error('❌ [Erro Crítico no Webhook]:', err.message);
        return reply.status(500).send({ status: 'ERROR', error: err.message });
    }
});

const PORT = Number(process.env.PORT) || 3001;
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
    console.log(`\n🤖 Igor V5.2 Online | Menu de Vídeos e Estética Corrigidos | Porta ${PORT}`);
});