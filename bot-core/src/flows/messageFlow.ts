import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';

// Inicializa o SDK do Gemini
const ai = new GoogleGenAI();

// 1. Função auxiliar para converter o áudio recebido (.opus) para .mp3
const convertAudio = (inputPath: string, outputPath: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('libmp3lame')
            .toFormat('mp3')
            .on('error', (err) => reject(err))
            .on('end', () => resolve())
            .save(outputPath);
    });
};

// 2. Função para transcrever áudio usando o Gemini (Substitui o Groq)
export async function transcribeAudio(base64Audio: string): Promise<string> {
    const timestamp = Date.now();
    const tempFile = path.join(process.cwd(), `temp_${timestamp}.opus`);
    const convertedFile = path.join(process.cwd(), `ready_${timestamp}.mp3`);
    
    try {
        const audioBuffer = Buffer.from(base64Audio.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(tempFile, audioBuffer);
        
        await convertAudio(tempFile, convertedFile);
        
        if (!fs.existsSync(convertedFile)) throw new Error("Arquivo convertido não encontrado");

        const audioBytes = fs.readFileSync(convertedFile);

        console.log("🎙️ Enviando áudio para transcrição via Gemini...");

        const response = await ai.models.generateContent({
            model: 'gemini-flash-lite-latest',
            contents: [
                {
                    inlineData: {
                        mimeType: 'audio/mp3',
                        data: audioBytes.toString('base64')
                    }
                },
                {
                    text: "Por favor, transcreva este áudio de forma fiel e exata, retornando apenas o texto correspondente ao que foi dito, sem comentários adicionais."
                }
            ]
        });

        return response.text ? response.text.trim() : '';
    } catch (error: any) {
        console.error("❌ Erro na Transcrição de Áudio com Gemini:", error.message || error);
        return '';
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        if (fs.existsSync(convertedFile)) fs.unlinkSync(convertedFile);
    }
}

export async function sendWhatsAppMedia(phone: string, mediaUrl: string, caption = "") {
    try {
        console.log("Enviando mídia:", { phone, mediaUrl });
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
                headers: { apikey: process.env.EVOLUTION_API_KEY || "" }
            }
        );
        console.log("Sucesso:", response.data);
    } catch (error: any) {
        console.error("Erro completo:", JSON.stringify(error.response?.data, null, 2));
    }
}

export async function sendWhatsAppMessage(phone: string, text: string) {
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

export async function getAudioBase64(messageId: string, retries = 3): Promise<string> {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.post(
                `${process.env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${process.env.INSTANCE_NAME}`,
                { message: { key: { id: messageId } } },
                { headers: { apikey: process.env.EVOLUTION_API_KEY || '' } }
            );
            
            if (response.data?.base64) return response.data.base64;
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error(`Tentativa ${i + 1} falhou ao buscar áudio.`);
        }
    }
    return '';
}

// 3. Função principal encapsulada que processa o fluxo e pode ser chamada/exportada para o index.ts
export async function handleMessageFlow({
    incomingText,
    audioMessageId,
    safePatientName,
    cleanNumber,
    isBusinessHours,
    reply
}: {
    incomingText?: string;
    audioMessageId?: string;
    safePatientName: string;
    cleanNumber: string;
    isBusinessHours: () => boolean;
    reply: any;
}) {
    let messageText = incomingText;

    // Se a mensagem for áudio e não houver texto direto, transcreve com o Gemini
    if (!messageText && audioMessageId) {
        const base64Audio = await getAudioBase64(audioMessageId);
        if (base64Audio) {
            messageText = await transcribeAudio(base64Audio);
        }
    }

    if (!messageText || messageText.trim() === "") {
        console.log("⚠️ Mensagem sem texto ou falha na transcrição.");
        return reply.send({ status: 'EMPTY' });
    }

    // --- FLUXO DE TRIAGEM COM O GEMINI ---
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-flash-lite-latest',
            contents: messageText,
            config: {
                systemInstruction: "Analise se a mensagem do paciente é uma emergência odontológica grave (ex: hemorragias, dificuldade respiratória, reações alérgicas severas, febre muito alta). Retorne APENAS a palavra 'SIM' ou 'NAO'.",
            }
        });

        const triagemResultado = response.text ? response.text.trim().toUpperCase() : '';

        if (triagemResultado === "SIM") {
            const mensagemAtendente = `🚨 *URGÊNCIA DETECTADA (IA)*\n\n` +
                                      `Paciente: *${safePatientName}* (${cleanNumber})\n` +
                                      `Relato: "${messageText}"\n\n` +
                                      `*[Clique aqui para avaliar e atender](https://wa.me/${cleanNumber})*`;

            if (isBusinessHours()) {
                await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', mensagemAtendente);
                await sendWhatsAppMessage(cleanNumber, "Recebi sua mensagem. Nossa equipe de recepção foi notificada sobre sua urgência e entrará em contato em instantes para sua triagem.");
            } else {
                await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', `⚠️ *ALERTA FORA DE HORÁRIO*\n${mensagemAtendente}`);
                await sendWhatsAppMessage(cleanNumber, "Recebi seu relato de urgência. Como estamos fora do horário comercial, caso seja uma emergência grave (hemorragia, dificuldade para respirar), dirija-se ao pronto-socorro mais próximo. Nossa equipe verificará sua mensagem assim que iniciarmos o expediente.");
            }
            
            return reply.send({ status: 'SUCCESS' });
        }
    } catch (error) {
        console.error("Erro na triagem com IA, seguindo fluxo normal:", error);
    }
}