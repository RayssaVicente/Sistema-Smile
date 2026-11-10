'use client';

import React, { useState, useEffect } from 'react';
import { Settings, Calendar, MessageSquare, Star, CreditCard, CheckCircle, Search, Save, Send, RefreshCw } from 'lucide-react';

const API_URL = 'http://localhost:8010'; // Altere para a URL do seu backend Fastify
const SHARED_TOKEN = 'minha_senha_super_secreta_123'; // Mesmo token do .env

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState('config');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });

  // Estados dos Dados (Incluindo o botNumber, assistantNumber e evaluationLink)
  const [config, setConfig] = useState({ botNumber: '', assistantNumber: '', evaluationLink: '' });
  const [agendamentos, setAgendamentos] = useState<any[]>([]);
  const [avaliacoes, setAvaliacoes] = useState<any[]>([]);
  
  // Estados de Histórico
  const [searchPhone, setSearchPhone] = useState('');
  const [historicoChat, setHistoricoChat] = useState('');

  // Estados de Cobrança
  const [cobranca, setCobranca] = useState({
    nome: '', telefone: '', descricao: '', valor: '', vencimento: '', link_pagamento: ''
  });

  const headers = {
    'Authorization': `Bearer ${SHARED_TOKEN}`,
    'Content-Type': 'application/json'
  };

  const showNotification = (text: string, type: 'success' | 'error') => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: '', type: '' }), 4000);
  };

  // Carregar dados iniciais da aba ativa
  useEffect(() => {
    if (activeTab === 'config') loadConfig();
    if (activeTab === 'agendamentos') loadAgendamentos();
    if (activeTab === 'avaliacoes') loadAvaliacoes();
  }, [activeTab]);

  const loadConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/admin/config`, { headers });
      const data = await res.json();
      setConfig({ 
        botNumber: data.botNumber || '', 
        assistantNumber: data.assistantNumber || '', 
        evaluationLink: data.evaluationLink || '' 
      });
    } catch (e) { showNotification('Erro ao carregar configurações', 'error'); }
  };

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/admin/config`, {
        method: 'POST', headers, body: JSON.stringify(config)
      });
      if (res.ok) {
        showNotification('Configurações salvas com sucesso!', 'success');
      } else {
        showNotification('Erro ao salvar configurações', 'error');
      }
    } catch (e) { showNotification('Erro ao salvar', 'error'); }
  };

  const loadAgendamentos = async () => {
    try {
      const res = await fetch(`${API_URL}/admin/agendamentos`, { headers });
      const data = await res.json();
      setAgendamentos(data);
    } catch (e) { showNotification('Erro ao carregar agendamentos', 'error'); }
  };

  const finalizarAtendimento = async (telefone: string) => {
  if (!confirm(`Deseja finalizar o atendimento e enviar o link de avaliação para ${telefone}?`)) return;
  try {
    const res = await fetch(`${API_URL}/admin/finalizar`, {
      method: 'POST', 
      headers, 
      body: JSON.stringify({ telefone })
    });
    const data = await res.json();
    if (res.ok) {
      showNotification(data.message, 'success');
      loadAgendamentos();
    } else {
      showNotification(data.error || 'Erro ao finalizar', 'error');
    }
  } catch (e) { 
    showNotification('Erro na requisição', 'error'); 
  }
};

  const loadAvaliacoes = async () => {
    try {
      const res = await fetch(`${API_URL}/admin/avaliacoes`, { headers });
      const data = await res.json();
      setAvaliacoes(data);
    } catch (e) { showNotification('Erro ao carregar avaliações', 'error'); }
  };

  const fetchHistorico = async () => {
    if (!searchPhone) return;
    try {
      const res = await fetch(`${API_URL}/admin/historico/${searchPhone}`, { headers });
      const data = await res.json();
      
      const listaMensagens = Array.isArray(data) ? data : (data.messages || data.historico || []);
      
      if (listaMensagens.length === 0) {
        setHistoricoChat('Nenhuma mensagem encontrada.');
        return;
      }

      const formatado = listaMensagens.map((msg: any) => {
        const autor = msg.role === 'user' ? '👤 Paciente' : '🤖 Bot';
        const dataMsg = msg.createdAt ? new Date(msg.createdAt).toLocaleString('pt-BR') : '';
        return `[${dataMsg}] ${autor}: ${msg.content}`;
      }).join('\n\n');

      setHistoricoChat(formatado);
    } catch (e) { 
      showNotification('Erro ao buscar histórico', 'error'); 
    }
  };

  const enviarCobranca = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/admin/cobranca`, {
        method: 'POST', headers, body: JSON.stringify(cobranca)
      });
      if (res.ok) {
        showNotification('Cobrança disparada com sucesso via WhatsApp!', 'success');
        setCobranca({ nome: '', telefone: '', descricao: '', valor: '', vencimento: '', link_pagamento: '' });
      }
    } catch (e) { showNotification('Erro ao enviar cobrança', 'error'); }
  };

  return (
    <div className="flex h-screen bg-slate-900 text-slate-100 font-sans">
      {/* Sidebar de Navegação */}
      <aside className="w-64 bg-slate-800 border-r border-slate-700 p-6 flex flex-col justify-between">
        <div>
          <h1 className="text-xl font-bold text-cyan-400 mb-8 flex items-center gap-2">
            🦷 Clínica Smile <span className="text-xs bg-cyan-900 text-cyan-200 px-2 py-0.5 rounded">Admin</span>
          </h1>
          <nav className="space-y-2">
            {[
              { id: 'config', label: 'Configurações', icon: Settings },
              { id: 'agendamentos', label: 'Agendamentos', icon: Calendar },
              { id: 'historico', label: 'Histórico Chat', icon: MessageSquare },
              { id: 'avaliacoes', label: 'Avaliações', icon: Star },
              { id: 'cobrancas', label: 'Central de Cobranças', icon: CreditCard },
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  <Icon size={18} /> {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="text-xs text-slate-500 text-center">Bot WhatsApp v2.5</div>
      </aside>

      {/* Conteúdo Principal */}
      <main className="flex-1 overflow-y-auto p-8">
        {message.text && (
          <div className={`mb-6 p-4 rounded-lg text-sm font-medium ${message.type === 'success' ? 'bg-emerald-800 text-emerald-100' : 'bg-rose-800 text-rose-100'}`}>
            {message.text}
          </div>
        )}

        {/* ABA 1: CONFIGURAÇÕES */}
        {activeTab === 'config' && (
          <div className="max-w-xl bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><Settings size={20}/> Configurações do Bot</h2>
            <form onSubmit={saveConfig} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Número do Bot (WhatsApp)</label>
                <input 
                  type="text" 
                  value={config.botNumber} 
                  onChange={(e) => setConfig({ ...config, botNumber: e.target.value })} 
                  placeholder="Ex: 5583999999999"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Número da Assistente / Atendente (WhatsApp)</label>
                <input 
                  type="text" 
                  value={config.assistantNumber} 
                  onChange={(e) => setConfig({ ...config, assistantNumber: e.target.value })} 
                  placeholder="Ex: 5583986975836"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Link de Avaliação do Google</label>
                <input 
                  type="text" 
                  value={config.evaluationLink} 
                  onChange={(e) => setConfig({ ...config, evaluationLink: e.target.value })} 
                  placeholder="https://g.page/r/..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <button type="submit" className="bg-cyan-600 hover:bg-cyan-500 text-white font-medium px-5 py-2.5 rounded-lg flex items-center gap-2 transition-colors text-sm">
                <Save size={16} /> Salvar Alterações
              </button>
            </form>
          </div>
        )}

        {/* ABA 2: AGENDAMENTOS */}
        {activeTab === 'agendamentos' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-semibold flex items-center gap-2"><Calendar size={20}/> Lista de Agendamentos</h2>
              <button onClick={loadAgendamentos} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg border border-slate-700 flex items-center gap-2 text-sm">
                <RefreshCw size={16}/> Atualizar
              </button>
            </div>
            <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-lg">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-700/50 text-slate-400 text-xs uppercase tracking-wider">
                    <th className="p-4">Paciente</th>
                    <th className="p-4">Telefone</th>
                    <th className="p-4">Procedimento</th>
                    <th className="p-4">Data/Hora</th>
                    <th className="p-4">Status</th>
                    <th className="p-4 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700 text-sm">
                  {agendamentos.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-700/30">
                      <td className="p-4 font-medium">{item.patient?.name || 'N/A'}</td>
                      <td className="p-4 text-slate-400">{item.patient?.phone}</td>
                      <td className="p-4">{item.treatment || item.procedure}</td>
                      <td className="p-4">{new Date(item.date).toLocaleString('pt-BR')}</td>
                      <td className="p-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${item.status === 'CONCLUIDO' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-amber-900/50 text-amber-400'}`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        {item.status !== 'CONCLUIDO' && (
                          <button
                            onClick={() => finalizarAtendimento(item.patient?.phone || item.telefone)}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 ml-auto"
                          >
                            <CheckCircle size={14} /> Finalizar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ABA 3: HISTÓRICO DE CONVERSAS */}
        {activeTab === 'historico' && (
          <div className="max-w-3xl bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><MessageSquare size={20}/> Histórico de Conversa com Cliente</h2>
            <div className="flex gap-3 mb-6">
              <input
                type="text"
                value={searchPhone}
                onChange={(e) => setSearchPhone(e.target.value)}
                placeholder="Digite o número (Ex: 5583999999999)"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 focus:outline-none focus:border-cyan-500 text-sm"
              />
              <button onClick={fetchHistorico} className="bg-cyan-600 hover:bg-cyan-500 text-white px-5 py-3 rounded-lg font-medium flex items-center gap-2 text-sm">
                <Search size={16} /> Buscar
              </button>
            </div>
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 h-96 overflow-y-auto whitespace-pre-wrap text-sm font-mono text-slate-300">
              {historicoChat || 'Busque por um número para ver o histórico de mensagens.'}
            </div>
          </div>
        )}

        {/* ABA 4: AVALIAÇÕES */}
        {activeTab === 'avaliacoes' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-semibold flex items-center gap-2"><Star size={20}/> Consultas Concluídas / Feedbacks</h2>
              <button onClick={loadAvaliacoes} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg border border-slate-700 flex items-center gap-2 text-sm">
                <RefreshCw size={16}/> Atualizar
              </button>
            </div>
            <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-lg">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-700/50 text-slate-400 text-xs uppercase tracking-wider">
                    <th className="p-4">Paciente</th>
                    <th className="p-4">Telefone</th>
                    <th className="p-4">Procedimento Realizado</th>
                    <th className="p-4">Data</th>
                    <th className="p-4">Link Google Enviado?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700 text-sm">
                  {avaliacoes.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-700/30">
                      <td className="p-4 font-medium">{item.patient?.name}</td>
                      <td className="p-4 text-slate-400">{item.patient?.phone}</td>
                      <td className="p-4">{item.treatment || item.procedure}</td>
                      <td className="p-4">{new Date(item.date).toLocaleDateString('pt-BR')}</td>
                      <td className="p-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${item.linkSent ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-700 text-slate-300'}`}>
                          {item.linkSent ? 'Sim' : 'Não'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ABA 5: CENTRAL DE COBRANÇAS */}
        {activeTab === 'cobrancas' && (
          <div className="max-w-xl bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><CreditCard size={20}/> Disparar Cobrança Manual (/bot/tarefa)</h2>
            <form onSubmit={enviarCobranca} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Nome do Paciente</label>
                <input
                  type="text"
                  value={cobranca.nome}
                  onChange={(e) => setCobranca({ ...cobranca, nome: e.target.value })}
                  placeholder="Ex: Maria Silva"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Telefone (WhatsApp)</label>
                <input
                  type="text"
                  value={cobranca.telefone}
                  onChange={(e) => setCobranca({ ...cobranca, telefone: e.target.value })}
                  placeholder="Ex: 5583999999999"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Descrição do Serviço / Cobrança</label>
                <input
                  type="text"
                  value={cobranca.descricao}
                  onChange={(e) => setCobranca({ ...cobranca, descricao: e.target.value })}
                  placeholder="Ex: Manutenção Aparelho Ortodôntico"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">Valor (R$)</label>
                  <input
                    type="text"
                    value={cobranca.valor}
                    onChange={(e) => setCobranca({ ...cobranca, valor: e.target.value })}
                    placeholder="150,00"
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">Vencimento</label>
                  <input
                    type="text"
                    value={cobranca.vencimento}
                    onChange={(e) => setCobranca({ ...cobranca, vencimento: e.target.value })}
                    placeholder="10/10/2026"
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Link de Pagamento</label>
                <input
                  type="url"
                  value={cobranca.link_pagamento}
                  onChange={(e) => setCobranca({ ...cobranca, link_pagamento: e.target.value })}
                  placeholder="https://pay.exemplo.com/..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>
              <button type="submit" className="bg-cyan-600 hover:bg-cyan-500 text-white font-medium px-5 py-2.5 rounded-lg flex items-center gap-2 transition-colors text-sm">
                <Send size={16} /> Enviar Cobrança via WhatsApp
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}