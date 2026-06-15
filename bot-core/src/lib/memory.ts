import { connection } from './redis.js';

export async function getChatHistory(remoteJid: string) {
  const history = await connection.lrange(`chat:${remoteJid}`, 0, 10);
  return history.reverse().map(msg => JSON.parse(msg));
}

export async function saveChatMessage(remoteJid: string, role: 'user' | 'assistant', content: string) {
  const message = JSON.stringify({ role, content });
  await connection.lpush(`chat:${remoteJid}`, message);
  await connection.ltrim(`chat:${remoteJid}`, 0, 10); // Mantém as últimas 10
  await connection.expire(`chat:${remoteJid}`, 3600); // Expira em 1 hora
}