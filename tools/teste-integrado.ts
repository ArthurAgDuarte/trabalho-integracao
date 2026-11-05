/**
 * Teste integrado: sobe o docker compose, espera a API ficar saudável, roda o simulador em modo
 * sequencia com um dispositivo de nome único e confere na API que as leituras e os eventos
 * INICIO_VAZAMENTO e NORMALIZADO foram gravados. Sai com código 0 (passou) ou 1 (falhou).
 *
 *   npm run teste:integrado
 *   npm run teste:integrado -- --sem-compose      (usa API e broker que já estão rodando)
 *
 * Opções: --api <url> (padrão http://localhost:8000), --quantidade <n> (padrão 3),
 * --tempo-limite <s> (espera do /health, padrão 180) e, repassadas ao simulador,
 * --host, --porta, --usuario e --senha (padrão: do .env).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { mensagemErro } from '../src/log.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Roda um comando mostrando a saída dele. Resolve com o código de saída. */
function rodar(comando: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const processo = spawn(comando, args, { cwd: RAIZ, stdio: 'inherit' });
    processo.on('error', reject);
    processo.on('close', (codigo) => resolve(codigo ?? 1));
  });
}

async function obterJson(url: string): Promise<{ status: number; corpo: unknown }> {
  const resposta = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { status: resposta.status, corpo: await resposta.json().catch(() => null) };
}

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: {
      'sem-compose': { type: 'boolean', default: false },
      api: { type: 'string', default: 'http://localhost:8000' },
      quantidade: { type: 'string', default: '3' },
      'tempo-limite': { type: 'string', default: '180' },
      host: { type: 'string' },
      porta: { type: 'string' },
      usuario: { type: 'string' },
      senha: { type: 'string' },
    },
  });
  const api = v.api.replace(/\/$/, '');
  const quantidade = Number(v.quantidade);
  const tempoLimiteMs = Number(v['tempo-limite']) * 1000;
  const falhas: string[] = [];
  const confere = (ok: boolean, descricao: string): void => {
    console.log(`${ok ? '  OK   ' : '  FALHA'} ${descricao}`);
    if (!ok) falhas.push(descricao);
  };

  // 1) Ambiente
  if (!v['sem-compose']) {
    console.log('\n[1/4] docker compose up -d --build');
    try {
      const codigo = await rodar('docker', ['compose', 'up', '-d', '--build']);
      if (codigo !== 0) {
        console.error(`ERRO: docker compose terminou com código ${codigo}.`);
        return 1;
      }
    } catch (erro) {
      console.error(`ERRO: não foi possível executar o docker (${mensagemErro(erro)}). Instale o Docker ou use --sem-compose.`);
      return 1;
    }
  } else {
    console.log('\n[1/4] --sem-compose: usando o ambiente que já está rodando');
  }

  // 2) Saúde
  console.log(`\n[2/4] esperando ${api}/health responder 200 (até ${tempoLimiteMs / 1000} s)`);
  const limite = Date.now() + tempoLimiteMs;
  let ultimo = 'sem resposta';
  for (;;) {
    try {
      const { status, corpo } = await obterJson(`${api}/health`);
      ultimo = `HTTP ${status} ${JSON.stringify(corpo)}`;
      if (status === 200) break;
    } catch (erro) {
      ultimo = mensagemErro(erro);
    }
    if (Date.now() > limite) {
      console.error(`ERRO: a API não ficou saudável a tempo. Última resposta: ${ultimo}`);
      if (!v['sem-compose']) console.error('Veja os logs com: docker compose logs api mosquitto postgres');
      return 1;
    }
    await esperar(2_000);
  }
  console.log(`  ${ultimo}`);

  // 3) Simulador
  const dispositivo = `teste-integrado-${Date.now()}`;
  console.log(`\n[3/4] simulador: sequencia com ${quantidade} mensagens por etapa, dispositivo ${dispositivo}`);
  const repassadas = (['host', 'porta', 'usuario', 'senha'] as const).flatMap((nome) => (v[nome] === undefined ? [] : [`--${nome}`, v[nome]]));
  const codigoSimulador = await rodar(process.execPath, [
    '--import',
    'tsx',
    path.join('tools', 'simulador.ts'),
    'sequencia',
    '--dispositivo',
    dispositivo,
    '--comodo',
    'teste',
    '--quantidade',
    String(quantidade),
    '--intervalo',
    '0.2',
    ...repassadas,
  ]);
  if (codigoSimulador !== 0) {
    console.error(`ERRO: o simulador terminou com código ${codigoSimulador}.`);
    return 1;
  }

  // 4) Conferência pela API
  console.log('\n[4/4] conferindo pela API');
  const esperadas = quantidade * 3;
  let leituras: Array<{ status: string }> = [];
  for (let tentativa = 0; tentativa < 30; tentativa++) {
    leituras = (await obterJson(`${api}/leituras?dispositivo=${dispositivo}&limite=1000`)).corpo as typeof leituras;
    if (leituras.length >= esperadas) break;
    await esperar(1_000);
  }
  confere(leituras.length === esperadas, `${leituras.length} de ${esperadas} leituras gravadas`);
  const vazamentos = leituras.filter((l) => l.status === 'VAZAMENTO').length;
  confere(vazamentos === quantidade, `${vazamentos} de ${quantidade} leituras com status VAZAMENTO`);

  const eventos = (await obterJson(`${api}/eventos?dispositivo=${dispositivo}`)).corpo as Array<{
    tipo: string;
    notificado: boolean;
    erro_notificacao: string | null;
  }>;
  const tipos = eventos.map((e) => e.tipo).reverse(); // a API devolve os mais recentes primeiro
  confere(JSON.stringify(tipos) === JSON.stringify(['INICIO_VAZAMENTO', 'NORMALIZADO']), `eventos gravados: ${tipos.join(', ') || 'nenhum'}`);
  for (const evento of eventos) {
    const resultado = evento.notificado ? 'notificado' : `não notificado (${evento.erro_notificacao ?? 'pendente'})`;
    console.log(`         ${evento.tipo}: ${resultado}`);
  }

  console.log(falhas.length === 0 ? '\nTESTE INTEGRADO PASSOU' : `\nTESTE INTEGRADO FALHOU (${falhas.length})`);
  return falhas.length === 0 ? 0 : 1;
}

process.exitCode = await main().catch((erro: unknown) => {
  console.error(`ERRO: ${mensagemErro(erro)}`);
  return 1;
});
