import type { FastifyInstance } from 'fastify';

import { TIPOS_EVENTO } from './alerta.js';
import type { Repositorio } from './db/repositorio.js';
import { interpretarDataIso, STATUS } from './schemas.js';

export interface DependenciasRotas {
  repositorio: Repositorio;
  /** Estado da conexão com o broker (o /health responde 503 se false). */
  mqttConectado: () => boolean;
}

// ---------------------------------------------------------------------------
// Schemas (validação da query, serialização da resposta e documentação em /docs)
// ---------------------------------------------------------------------------

const esquemaSaude = {
  type: 'object',
  required: ['api', 'banco', 'mqtt'],
  properties: {
    api: { type: 'string', enum: ['ok'] },
    banco: { type: 'string', enum: ['ok', 'erro'] },
    mqtt: { type: 'string', enum: ['conectado', 'desconectado'] },
  },
} as const;

const esquemaLeitura = {
  type: 'object',
  required: ['id', 'dispositivo', 'comodo', 'leitura', 'status', 'ts_dispositivo', 'recebido_em'],
  properties: {
    id: { type: 'integer' },
    dispositivo: { type: 'string' },
    comodo: { type: 'string', description: 'Vem do tópico casa/<comodo>/gas' },
    leitura: { type: 'integer', minimum: 0, maximum: 4095 },
    status: { type: 'string', enum: [...STATUS] },
    ts_dispositivo: { type: ['string', 'null'], format: 'date-time', description: 'Campo ts enviado pelo ESP32 (UTC), se houver' },
    recebido_em: { type: 'string', format: 'date-time', description: 'Horário do servidor (UTC)' },
  },
} as const;

const esquemaEvento = {
  type: 'object',
  required: ['id', 'dispositivo', 'comodo', 'tipo', 'leitura', 'criado_em', 'notificado', 'erro_notificacao'],
  properties: {
    id: { type: 'integer' },
    dispositivo: { type: 'string' },
    comodo: { type: 'string' },
    tipo: { type: 'string', enum: [...TIPOS_EVENTO] },
    leitura: { type: 'integer' },
    criado_em: { type: 'string', format: 'date-time' },
    notificado: { type: 'boolean', description: 'true se o notificador confirmou o envio' },
    erro_notificacao: { type: ['string', 'null'], description: 'Motivo da falha no envio, se houver' },
  },
} as const;

const esquemaErro = {
  type: 'object',
  description: 'Mesmo formato do FastAPI: detail é um texto ou a lista de problemas por parâmetro',
  properties: { detail: {} },
} as const;

const limite = {
  type: 'integer',
  minimum: 1,
  maximum: 1000,
  default: 100,
  description: 'Máximo de registros retornados (1 a 1000)',
} as const;

interface QueryLeituras {
  dispositivo?: string;
  inicio?: string;
  fim?: string;
  limite: number;
}

interface QueryEventos {
  dispositivo?: string;
  limite: number;
}

// ---------------------------------------------------------------------------

export function registrarRotas(app: FastifyInstance, { repositorio, mqttConectado }: DependenciasRotas): void {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Status da API, do banco e da conexão MQTT',
        description: 'HTTP 200 se tudo estiver ok; 503 se o banco ou o MQTT estiverem fora.',
        tags: ['saúde'],
        response: { 200: esquemaSaude, 503: esquemaSaude },
      },
    },
    async (_requisicao, resposta) => {
      const banco = (await repositorio.bancoOk()) ? 'ok' : 'erro';
      const mqtt = mqttConectado() ? 'conectado' : 'desconectado';
      const saudavel = banco === 'ok' && mqtt === 'conectado';
      return resposta.code(saudavel ? 200 : 503).send({ api: 'ok', banco, mqtt });
    },
  );

  app.get<{ Querystring: QueryLeituras }>(
    '/leituras',
    {
      schema: {
        summary: 'Histórico de leituras (mais recentes primeiro)',
        tags: ['leituras'],
        querystring: {
          type: 'object',
          properties: {
            dispositivo: { type: 'string', description: 'Só as leituras deste dispositivo' },
            inicio: { type: 'string', description: 'recebido_em >= inicio (ISO 8601; sem fuso = UTC)', examples: ['2026-09-13T00:00:00Z'] },
            fim: { type: 'string', description: 'recebido_em <= fim (ISO 8601; sem fuso = UTC)', examples: ['2026-09-13T23:59:59Z'] },
            limite,
          },
        },
        response: { 200: { type: 'array', items: esquemaLeitura }, 422: esquemaErro },
      },
    },
    async (requisicao, resposta) => {
      const { dispositivo, limite: maximo } = requisicao.query;
      const problemas = [];
      const datas: Partial<Record<'inicio' | 'fim', Date>> = {};
      for (const campo of ['inicio', 'fim'] as const) {
        const texto = requisicao.query[campo];
        if (texto === undefined) continue;
        const data = interpretarDataIso(texto);
        if (data === null) {
          problemas.push({ loc: ['query', campo], msg: 'deve ser uma data ISO 8601 (ex.: 2026-09-13T14:00:00Z)', type: 'datetime' });
        } else {
          datas[campo] = data;
        }
      }
      if (problemas.length > 0) return resposta.code(422).send({ detail: problemas });
      if (datas.inicio && datas.fim && datas.inicio > datas.fim) {
        return resposta.code(422).send({ detail: 'inicio deve ser anterior a fim' });
      }
      return repositorio.listarLeituras({ dispositivo, inicio: datas.inicio, fim: datas.fim, limite: maximo });
    },
  );

  app.get(
    '/leituras/ultimas',
    {
      schema: {
        summary: 'Última leitura de cada dispositivo',
        description: 'A situação atual da casa: uma linha por dispositivo, ordenada por dispositivo.',
        tags: ['leituras'],
        response: { 200: { type: 'array', items: esquemaLeitura } },
      },
    },
    async () => repositorio.ultimasLeituras(),
  );

  app.get<{ Querystring: QueryEventos }>(
    '/eventos',
    {
      schema: {
        summary: 'Eventos de alerta (mais recentes primeiro)',
        description: 'INICIO_VAZAMENTO, LEMBRETE e NORMALIZADO, com o resultado do envio da notificação.',
        tags: ['eventos'],
        querystring: {
          type: 'object',
          properties: {
            dispositivo: { type: 'string', description: 'Só os eventos deste dispositivo' },
            limite,
          },
        },
        response: { 200: { type: 'array', items: esquemaEvento }, 422: esquemaErro },
      },
    },
    async (requisicao) => repositorio.listarEventos({ dispositivo: requisicao.query.dispositivo, limite: requisicao.query.limite }),
  );
}
