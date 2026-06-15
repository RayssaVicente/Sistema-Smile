
import { FastifyInstance } from 'fastify';

export async function cobrancaRoutes(app: FastifyInstance) {
    app.post('/bot/tarefa', async (request, reply) => {
        const { tipo, paciente, dados } = request.body as any;

        if (tipo !== 'cobranca') {
            return reply.status(400).send({ error: 'Tipo não suportado' });
        }

        // Aqui você coloca a lógica de disparar a mensagem de cobrança
        // Exemplo: await sendWhatsAppMessage(paciente.telefone, `Olá ${paciente.nome}, sua fatura de R$${dados.valor}...`);

        return reply.send({ status: 'aceita', fila_posicao: 1 });
    });
}