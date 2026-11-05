import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { MaquinaAlerta } from '../src/alerta.js';
import { construirApp } from '../src/app.js';
import { LogNotificador } from '../src/notificadores/index.js';
import { Processador } from '../src/processador.js';
import { criarLogMemoria } from './apoio/log-memoria.js';
import { payload } from './apoio/payloads.js';
import { RelogioFalso } from './apoio/relogio-falso.js';
import { RepositorioMemoria } from './apoio/repositorio-memoria.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function montar({ mqtt = false, repositorio = new RepositorioMemoria() } = {}) {
  const { log, comAcao } = criarLogMemoria();
  app = await construirApp({ repositorio, mqttConectado: () => mqtt, log });
  return { app, repositorio, comAcao };
}

/** Mesmos dados do teste da versão Python: leituras a cada 10 s, um vazamento na cozinha. */
async function comDados() {
  const repositorio = new RepositorioMemoria();
  const relogio = new RelogioFalso();
  const { log } = criarLogMemoria();
  const processador = new Processador({ repositorio, maquina: new MaquinaAlerta(300), notificador: new LogNotificador(log), log, relogio: relogio.relogio });
  const publicar = async (comodo: string, segundos: number, ...args: Parameters<typeof payload>) => {
    relogio.avancar(segundos);
    await processador.processarMensagem(`casa/${comodo}/gas`, payload(...args));
  };
  await publicar('cozinha', 0, 'NORMAL', 200, 'esp32-cozinha', { ts: '2026-09-13T14:00:00Z' });
  await publicar('cozinha', 10, 'VAZAMENTO', 800, 'esp32-cozinha');
  await publicar('sala', 10, 'NORMAL', 150, 'esp32-sala');
  await publicar('cozinha', 10, 'NORMAL', 210, 'esp32-cozinha');
  await processador.encerrar(); // espera as notificações
  return (await montar({ repositorio })).app;
}

describe('GET /health', () => {
  it('503 quando o MQTT está desconectado', async () => {
    const { app } = await montar({ mqtt: false });
    const r = await app.inject('/health');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ api: 'ok', banco: 'ok', mqtt: 'desconectado' });
  });

  it('200 quando o banco e o MQTT estão ok', async () => {
    const { app } = await montar({ mqtt: true });
    const r = await app.inject('/health');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ api: 'ok', banco: 'ok', mqtt: 'conectado' });
  });

  it('503 quando o banco está fora', async () => {
    const repositorio = new RepositorioMemoria();
    repositorio.disponivel = false;
    const { app } = await montar({ mqtt: true, repositorio });
    const r = await app.inject('/health');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ api: 'ok', banco: 'erro', mqtt: 'conectado' });
  });
});

describe('GET /leituras', () => {
  it('mais recentes primeiro, com os mesmos campos da versão Python', async () => {
    const app = await comDados();
    const r = await app.inject('/leituras');
    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(corpo.map((l: { leitura: number }) => l.leitura)).toEqual([210, 150, 800, 200]);
    expect(Object.keys(corpo[0])).toEqual(['id', 'dispositivo', 'comodo', 'leitura', 'status', 'ts_dispositivo', 'recebido_em']);
    expect(corpo[0]).toMatchObject({ dispositivo: 'esp32-cozinha', comodo: 'cozinha', status: 'NORMAL', ts_dispositivo: null, recebido_em: '2026-09-13T14:00:30.000Z' });
    expect(corpo.at(-1).ts_dispositivo).toBe('2026-09-13T14:00:00.000Z');
  });

  it('filtra por dispositivo, janela de tempo (inclusiva) e limite', async () => {
    const app = await comDados();
    const leituras = async (query: Record<string, string>) =>
      (await app.inject({ url: '/leituras', query })).json().map((l: { leitura: number }) => l.leitura);
    expect(await leituras({ dispositivo: 'esp32-sala' })).toEqual([150]);
    expect(await leituras({ limite: '2' })).toEqual([210, 150]);
    expect(await leituras({ inicio: '2026-09-13T14:00:05Z', fim: '2026-09-13T14:00:25Z' })).toEqual([150, 800]);
    expect(await leituras({ inicio: '2026-09-13T14:00:10Z', fim: '2026-09-13T14:00:20Z' })).toEqual([150, 800]);
    expect(await leituras({ inicio: '2026-09-13T14:00:15' })).toEqual([210, 150]); // sem fuso = UTC
    expect(await leituras({ fim: '2026-09-13T11:00:05-03:00' })).toEqual([200]);
    expect(await leituras({ dispositivo: '' })).toHaveLength(4);
  });

  it.each([
    [{ limite: '0' }, ['query', 'limite']],
    [{ limite: '1001' }, ['query', 'limite']],
    [{ limite: 'abc' }, ['query', 'limite']],
    [{ limite: '10.5' }, ['query', 'limite']],
    [{ inicio: 'ontem' }, ['query', 'inicio']],
    [{ fim: '2026-09-13T25:00:00Z' }, ['query', 'fim']],
  ])('422 para parâmetro inválido: %j', async (query, loc) => {
    const { app } = await montar();
    const r = await app.inject({ url: '/leituras', query });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toEqual([expect.objectContaining({ loc, msg: expect.any(String) })]);
  });

  it('422 quando inicio > fim (igual pode)', async () => {
    const { app } = await montar();
    const r = await app.inject({ url: '/leituras', query: { inicio: '2026-09-14', fim: '2026-09-13' } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ detail: 'inicio deve ser anterior a fim' });
    const igual = await app.inject({ url: '/leituras', query: { inicio: '2026-09-13', fim: '2026-09-13T00:00:00Z' } });
    expect(igual.statusCode).toBe(200);
  });

  it('500 sem detalhes internos quando o banco falha na consulta', async () => {
    const repositorio = new RepositorioMemoria();
    repositorio.listarLeituras = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
    };
    const { app, comAcao } = await montar({ repositorio });
    const r = await app.inject('/leituras');
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ detail: 'Erro interno' });
    expect(comAcao('erro_http')).toMatchObject([{ nivel: 'ERROR', erro: 'Error: connect ECONNREFUSED 10.0.0.5:5432' }]);
  });
});

describe('GET /leituras/ultimas', () => {
  it('última leitura de cada dispositivo, ordenada por dispositivo', async () => {
    const app = await comDados();
    const r = (await app.inject('/leituras/ultimas')).json();
    expect(r.map((l: { dispositivo: string; leitura: number; status: string }) => [l.dispositivo, l.leitura, l.status])).toEqual([
      ['esp32-cozinha', 210, 'NORMAL'],
      ['esp32-sala', 150, 'NORMAL'],
    ]);
  });
});

describe('GET /eventos', () => {
  it('mais recentes primeiro, com os mesmos campos da versão Python, e filtro por dispositivo', async () => {
    const app = await comDados();
    const corpo = (await app.inject('/eventos')).json();
    expect(corpo.map((e: { tipo: string; leitura: number; notificado: boolean }) => [e.tipo, e.leitura, e.notificado])).toEqual([
      ['NORMALIZADO', 210, true],
      ['INICIO_VAZAMENTO', 800, true],
    ]);
    expect(Object.keys(corpo[0])).toEqual(['id', 'dispositivo', 'comodo', 'tipo', 'leitura', 'criado_em', 'notificado', 'erro_notificacao']);
    expect(corpo[0]).toMatchObject({ criado_em: '2026-09-13T14:00:30.000Z', erro_notificacao: null });
    expect((await app.inject({ url: '/eventos', query: { dispositivo: 'esp32-sala' } })).json()).toEqual([]);
    expect((await app.inject({ url: '/eventos', query: { limite: '1' } })).json()).toHaveLength(1);
    expect((await app.inject({ url: '/eventos', query: { limite: '0' } })).statusCode).toBe(422);
  });
});

describe('documentação', () => {
  it('GET /docs abre o Swagger UI, com os arquivos estáticos', async () => {
    const { app } = await montar();
    const pagina = await app.inject('/docs');
    expect(pagina.statusCode).toBe(200);
    expect(pagina.headers['content-type']).toContain('text/html');
    const css = await app.inject('/docs/static/swagger-ui.css');
    expect(css.statusCode).toBe(200);
  });

  it('o OpenAPI documenta os 4 endpoints', async () => {
    const { app } = await montar();
    const spec = (await app.inject('/docs/json')).json();
    expect(Object.keys(spec.paths).sort()).toEqual(['/eventos', '/health', '/leituras', '/leituras/ultimas']);
    expect(spec.paths['/leituras'].get.parameters.map((p: { name: string }) => p.name).sort()).toEqual(['dispositivo', 'fim', 'inicio', 'limite']);
  });

  it('rota inexistente: 404 no formato da versão Python', async () => {
    const { app } = await montar();
    const r = await app.inject('/nao-existe');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ detail: 'Not Found' });
  });
});
