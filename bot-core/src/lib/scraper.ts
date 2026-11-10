import { chromium } from 'playwright';

export interface ConsultaScraping {
    horario: string;
    nome: string;
    telefone: string;
}

export async function scrapeSite(): Promise<ConsultaScraping[]> {
  const browser = await chromium.launch({ headless: false }); 
  const page = await browser.newPage();
  
  let resultados: ConsultaScraping[] = []; 
  
  try {
    console.log('Navegando...');
    await page.goto('https://app.easydentalcloud.com.br/', { waitUntil: 'networkidle' });
    
    // Login
    await page.fill('input[name="tx_login"]', 'bankpaiva@gmail.com');
    await page.fill('input[name="tx_senha"]', '152126Bot');
    await page.click('text=Efetuar login no EasyDental');
    await page.waitForLoadState('networkidle');

    // Clicar no botão da agenda
    console.log('Clicando no botão da agenda...');
    const botaoAgenda = page.locator('#btnAgenda-btnIconEl');
    await botaoAgenda.waitFor({ state: 'visible' });
    await botaoAgenda.click();

    // Tempo de espera para o sistema desenhar os blocos na tela
    console.log('Aguardando carregamento da agenda...');
    await page.waitForTimeout(3000); 
    await page.waitForSelector('.ext-evt-block.evt-FF00FF', { timeout: 15000 }); 

    console.log('Coletando eventos rosas...');

    const locators = page.locator('.ext-evt-block.evt-FF00FF .ext-evt-bd');
    const todosElementos = await locators.all();

    console.log(`Elementos encontrados no DOM: ${todosElementos.length}`);

    // Processando e preenchendo o array estruturado
    for (const el of todosElementos) {
        const texto = await el.textContent();
        if (texto) {
            const textoLimpo = texto.trim();
            const partes = textoLimpo.split('|');
            
            if (partes.length >= 2) {
                const primeiraParte = partes[0]!.trim(); 
                const telefoneBruto = partes[1]!.trim();   

                const matchHorario = primeiraParte.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
                
                if (matchHorario) {
                    const horario = matchHorario[1]!; 
                    const nome = matchHorario[2]!;    
                    
                    const telefone = telefoneBruto.replace(/\D/g, '');

                    resultados.push({
                        horario,
                        nome,
                        telefone: `55${telefone}`
                    });
                }
            }
        }
    }
    
  } catch (error) {
    console.error('Erro durante a execução:', error);
    await page.screenshot({ path: 'erro.png' });
  } finally {
    await browser.close();
  }

  return resultados;
}