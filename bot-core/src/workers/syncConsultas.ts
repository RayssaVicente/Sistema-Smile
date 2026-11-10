import { prisma } from '../lib/prisma.js';
import { scrapeSite } from '../lib/scraper.js'; 

export async function syncConsultasComBanco() {
    console.log("Iniciando sincronização com EasyDental...");
    const consultas = await scrapeSite();

    for (const consulta of consultas) {
        // 1. Busca ou cria o paciente
        let patient = await prisma.patient.findFirst({
            where: { phone: consulta.telefone }
        });

        if (!patient) {
            patient = await prisma.patient.create({
                data: {
                    name: consulta.nome,
                    phone: consulta.telefone,
                    status: 'CONCLUDED' // Já cadastrado via sistema
                }
            });
        } else {
            // Atualiza o nome se necessário
            await prisma.patient.update({
                where: { id: patient.id },
                data: { name: consulta.nome }
            });
        }

        // 2. Verifica se já existe consulta registrada para hoje
        const hoje = new Date();
        const dataInicio = new Date(hoje.setHours(0, 0, 0, 0));
        const dataFim = new Date(hoje.setHours(23, 59, 59, 999));

        const existeConsulta = await prisma.appointment.findFirst({
            where: {
                patientId: patient.id,
                date: { gte: dataInicio, lte: dataFim }
            }
        });

        if (!existeConsulta) {
            // Cria a consulta respeitando os campos exatos do seu schema.prisma
            await prisma.appointment.create({
                data: {
                    patientId: patient.id,
                    date: new Date(), // Ajuste caso venha o horário real do scraper
                    procedure: "Consulta EasyDental", // Mapeado para o campo procedure do schema
                    status: 'confirmed',             // Mapeado para os valores aceitos
                    linkSent: false
                }
            });
            console.log(`✅ Consulta sincronizada para: ${consulta.nome}`);
        }
    }
    console.log("Sincronização com EasyDental concluída com sucesso.");
}