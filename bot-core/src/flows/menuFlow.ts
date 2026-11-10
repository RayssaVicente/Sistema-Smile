import type { FastifyReply } from 'fastify';

// Dicionário de procedimentos
export const PROCEDURES: Record<string, string> = {
    '1': 'Clínica Geral',
    '2': 'Implantes',
    '3': 'Limpeza',
    '4': 'Clareamento',
    '5': 'Emergência Dental',
    '6': 'Dentes Sisos',
    '7': 'Harmonização Facial',
    '8': 'Outros Tratamentos'
};

// Textos dos Menus
export function getMainMenuText(name: string): string {
    return `Olá, *${name}*! Seja bem-vindo(a) à nossa Central de Atendimento. 🦷\n\n` +
         `Por favor, digite apenas o *número* da opção desejada:\n\n` +
         `1️⃣ - Marcar Consulta\n` +
         `2️⃣ - Remarcar Consulta\n` +
         `3️⃣ - Dúvidas após Atendimento e Cirurgias\n`;
}

export function getVideoMenuText(): string {
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
         `🚨 *URGÊNCIA:* Se você passou por uma cirurgia recente e está tendo uma emergência grave, digite *10* para falar com a **Valdirene**.\n\n` +
         `↩️ Digite *Voltar* para o menu principal.`;
}

// Lógica principal do Menu
export async function handleMainMenuFlow(
    safePatientStatus: string,
    selectedOption: string,
    safePatientName: string,
    cleanNumber: string,
    patient: any,
    prisma: any,
    reply: FastifyReply,
    sendWhatsAppMessage: Function,
    isBusinessHours: Function
) {
    if (safePatientStatus !== "MAIN_MENU") return false;

    // BLOCO DE AGENDAMENTO (Opção 1)
    if (selectedOption === '1') {
        if (isBusinessHours()) {
            await prisma.patient.update({
                where: { id: patient.id },
                data: { status: "SUBMENU_PROCEDURES" }
            });
            const subMenuText = `Perfeito! Selecione o procedimento desejado para a sua consulta:\n\n` +
                                `1️⃣ - Clínica Geral\n2️⃣ - Implantes\n3️⃣ - Limpeza\n` +
                                `4️⃣ - Clareamento\n5️⃣ - Emergência Dental\n6️⃣ - Dentes Sisos\n` +
                                `7️⃣ - Harmonização Facial\n8️⃣ - Outros Tratamentos\n\n` +
                                `↩️ Digite *Voltar* para retornar ao menu anterior.`;
            await sendWhatsAppMessage(cleanNumber, subMenuText);
        } else {
            await sendWhatsAppMessage(cleanNumber, "Olá! Recebemos sua solicitação de agendamento. Estamos fora do nosso horário comercial (08:00 às 18:00). A Valdirene entrará em contato com você logo pela manhã para confirmar!");
            await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', `📅 *NOVO PEDIDO (FORA DE HORÁRIO)*: Paciente ${safePatientName} (${cleanNumber}) deseja agendar.`);
        }
        return reply.send({ status: 'SUCCESS' });
    } 

    // BLOCO DE REMARCAÇÃO (Opção 2)
    else if (selectedOption === '2') {
        const changeSummary = `🔄 *SOLICITAÇÃO DE REMARCAÇÃO*\n\nO paciente *${safePatientName}* (${cleanNumber}) solicitou uma alteração de horário.`;
            
        if (isBusinessHours()) {
            await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', changeSummary);
            await sendWhatsAppMessage(cleanNumber, `Entendido, *${safePatientName}*! Encaminhei os seus dados para a nossa recepção agora mesmo. Em instantes um de nossos atendentes entrará em contato.`);
        } else {
            await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', `⚠️ *REMARCAÇÃO (FORA DE HORÁRIO)*: ${changeSummary}`);
            await sendWhatsAppMessage(cleanNumber, `Recebemos seu pedido de remarcação. Como estamos fora do horário comercial, a Valdirene entrará em contato amanhã cedo para ajustar seu horário.`);
        }
        return reply.send({ status: 'SUCCESS' });
    } 

    // BLOCO DE VÍDEOS / DÚVIDAS (Opção 3)
    else if (selectedOption === '3') {
        await prisma.patient.update({
            where: { id: patient.id },
            data: { status: "SUBMENU_VIDEOS" }
        });
        await sendWhatsAppMessage(cleanNumber, getVideoMenuText());
        return reply.send({ status: 'SUCCESS' });
    } 

    // TRATAMENTO DE ERRO (Opção inválida no menu principal)
    await sendWhatsAppMessage(cleanNumber, `Opção inválida. Por favor, escolha um número de 1 a 3:\n\n` + getMainMenuText(safePatientName));
    return reply.send({ status: 'SUCCESS' });
}


export async function handleVideoSubmenusFlow(
    safePatientStatus: string,
    selectedOption: string,
    cleanNumber: string,
    safePatientName: string,
    patient: any,
    prisma: any,
    reply: FastifyReply,
    sendWhatsAppMessage: Function,
    sendWhatsAppMedia: Function
) {
    if (safePatientStatus !== "SUBMENU_VIDEOS") return false;

    const op = selectedOption;

    if (op === '1') {
        await sendWhatsAppMessage(cleanNumber, "Aguarde um instante, estou preparando o vídeo sobre Aparelho Ortodôntico...");
        await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1uP4xdyWDLBYHAD6Bk3ymBYC9uZN8K1mL", "🦷 *O que fazer antes dos aparelhos*");
        return reply.send({ status: 'SUCCESS' });
    } 
    else if (op === '2') {
        await prisma.patient.update({
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
        await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1cSxza_HRp_E4sewF5xTtt14GwwE-TIOo", "Você sabia bruxismo");
        return reply.send({ status: 'SUCCESS' });
    } 
    else if (op === '4') {
        await sendWhatsAppMessage(cleanNumber, "Preparando explicações de Canal...");
        await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1trGWhNZColC6T1-FnNRrVjrBv7z2l_Zp", "Prevenção ondotologica contra canal e cáries ");
        return reply.send({ status: 'SUCCESS' });
    }
    else if (op === '5') {
        await sendWhatsAppMessage(cleanNumber, "Localizando arquivo de ausência estrutural dentária...");
        await sendWhatsAppMedia(cleanNumber, "https://docs.google.com/uc?export=download&id=1jmsyFLQg-iLYx-qNONf530JiiDDNCKcS", "Consequência perda dos dentes");
        return reply.send({ status: 'SUCCESS' });
    }
    else if (op === '6') {
        await prisma.patient.update({
            where: { id: patient.id },
            data: { status: "SUBMENU_IMPLANTES" }
        });
        const implantesMenuText = `*Galeria de Vídeos: Implantes Dentários* \n\n` +
                                  `Digite o código correspondente ao vídeo que deseja assistir:\n\n` +
                                  ` *i1* - "Implante mau feito"\n *i2* - "Implante falsificado"\n` +
                                  ` *i3* - "Implante Durabilidade"\n *i4* - "Antes e Depois dos nosso implantes"\n` +
                                  `↩️ Digite *Voltar* para retornar ao menu de vídeos.`;
        await sendWhatsAppMessage(cleanNumber, implantesMenuText);
        return reply.send({ status: 'SUCCESS' });
    } 
    else if (op === '7') {
        await prisma.patient.update({
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
        await prisma.patient.update({
            where: { id: patient.id },
            data: { status: "SUBMENU_PAPADA&BICHECTOMIA" }
        });
        const papadaBichectomiaMenuText = `*Galeria de Vídeos: Papada e Bichectomia* \n\n` +
                                          `Digite o código correspondente ao vídeo que deseja assistir:\n\n` +
                                          ` *P1* - "Saiba tudo sobre Papada e bichectomia"\n *P2* - "Emagrecimento facial"\n` +
                                          ` *P3* - "Quem tem papada pequena pode fazer o procedimento?"\n ` + 
                                          `*P4* - "Uma das maiores duvidas sobre bichectomia"\n` +
                                          `↩️ Digite *Voltar* para retornar ao menu de vídeos.`;
        await sendWhatsAppMessage(cleanNumber, papadaBichectomiaMenuText);
        return reply.send({ status: 'SUCCESS' });
    } 
    else if (op === '10') {
        await sendWhatsAppMessage(process.env.SECRETARY_NUMBER || '', `⚠️ O paciente ${safePatientName} (${cleanNumber}) solicitou ajuda de emergência no menu de vídeos.`);
        await sendWhatsAppMessage(cleanNumber, "Nossa equipe foi notificada sobre sua necessidade de ajuda. Em instantes um atendente entrará em contato.");
        return reply.send({ status: 'SUCCESS' });
    }
    else {
        await sendWhatsAppMessage(cleanNumber, "Opção inválida. Digite um número de 1 a 10 ou *Voltar*.");
        return reply.send({ status: 'SUCCESS' });
    }
}


export async function handleCategoryVideoCodeFlow(
    safePatientStatus: string,
    lowerInput: string,
    cleanNumber: string,
    patient: any,
    reply: FastifyReply,
    processarVideoDoBanco: Function
) {
    const validStatuses = ["SUBMENU_ESTETICA", "SUBMENU_IMPLANTES", "SUBMENU_GENGIVAS", "SUBMENU_PAPADA&BICHECTOMIA"];
    
    if (validStatuses.includes(safePatientStatus)) {
        await processarVideoDoBanco(safePatientStatus, lowerInput, cleanNumber, patient.id, "SUBMENU_VIDEOS");
        return reply.send({ status: 'SUCCESS' });
    }

    return false;
}