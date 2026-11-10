// src/workers/scraperWorker.ts
import { scrapeSite } from "../lib/scraper.js";
import { prisma } from '../lib/prisma.js';

export async function rodarAtualizacao() {
  try {
    const dadoExtraido = await scrapeSite();

    const registro = await prisma.informacao.findFirst();

    if (registro) {
      await prisma.informacao.update({
        where: { id: registro.id },
        data: { valor: dadoExtraido }
      });
    } else {
      await prisma.informacao.create({
        data: { valor: dadoExtraido }
      });
    }
    console.log('Dados atualizados com sucesso!');
  } catch (error) {
    console.error('Erro ao atualizar dados:', error);
  }
}