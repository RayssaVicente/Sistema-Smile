// bot-core/src/lib/whatsapp.ts
import axios from 'axios';


const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8081';
const API_KEY = process.env.EVOLUTION_API_KEY || 'mCurtlQa9HRTL8jjzyQOo5NzwXBAnnkE';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'clinica-smile-teste';

export const sendWhatsAppMessage = async (number: string, text: string) => {
  try {
    const url = `${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`;
    const payload = {
      number: number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`,
      text: text,
    };

    const response = await axios.post(url, payload, {
      headers: {
        apikey: API_KEY,
        'Content-Type': 'application/json',
      },
    });

    console.log(`[WhatsApp] Mensagem enviada para ${number}`);
    return response.data;
  } catch (error: any) {
    console.error(`[WhatsApp] Erro ao enviar mensagem: ${error.response?.status || error.message}`);
    throw error;
  }
};


