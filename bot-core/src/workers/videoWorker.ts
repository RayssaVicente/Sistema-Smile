import { Worker } from 'bullmq';
import { connection } from '../lib/redis.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export const videoWorker = new Worker('VideoDelivery', async (job) => {
  const { patientId, videoUrl, message } = job.data;
  const cleanNumber = patientId.split('@')[0].replace(/\D/g, '');

  console.log(`🚀 Processando envio para: ${cleanNumber}`);
  console.log(`🔗 Link do vídeo: ${videoUrl}`);

  try {
    const config = {
      headers: { 'apikey': process.env.EVOLUTION_API_KEY }
    };

    // 1. Enviar Texto
    await axios.post(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.INSTANCE_NAME}`, {
      number: cleanNumber,
      text: message
    }, config);

    // 2. Enviar Vídeo (Padrão URL externa)
    await axios.post(`${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.INSTANCE_NAME}`, {
      number: cleanNumber,
      mediatype: "video",
      media: videoUrl, 
      caption: "Vídeo de orientações 🦷",
      fileName: "orientacao.mp4"
    }, config);

    console.log(`✅ Tudo enviado para ${cleanNumber}`);
  } catch (error: any) {
    console.error(`❌ Erro no Worker:`, JSON.stringify(error.response?.data || error.message, null, 2));
  }
}, { connection });