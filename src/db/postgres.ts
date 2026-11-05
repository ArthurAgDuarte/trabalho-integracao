import { setTimeout as esperar } from 'node:timers/promises';

import { Pool } from 'pg';

import { descreverErro, type Logger } from '../log.js';
import type {
  EventoAlerta,
  FiltroEventos,
  FiltroLeituras,
  Leitura,
  NovaLeitura,
  NovoEvento,
  Repositorio,
  UltimoEvento,
} from './repositorio.js';

/**
 * O mesmo schema que o SQLAlchemy da versão Python cria (inclusive os nomes de índices e
 * constraints), para as duas versões usarem o mesmo banco.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS leituras (
  id SERIAL PRIMARY KEY,
  dispositivo VARCHAR(64) NOT NULL,
  comodo VARCHAR(64) NOT NULL,
  leitura INTEGER NOT NULL,
  status VARCHAR(10) NOT NULL,
  ts_dispositivo TIMESTAMPTZ NULL,
  recebido_em TIMESTAMPTZ NOT NULL,
  CONSTRAINT ck_leituras_leitura CHECK (leitura BETWEEN 0 AND 4095),
  CONSTRAINT ck_leituras_status CHECK (status IN ('NORMAL', 'VAZAMENTO'))
);
CREATE INDEX IF NOT EXISTS ix_leituras_dispositivo_recebido_em ON leituras (dispositivo, recebido_em);

CREATE TABLE IF NOT EXISTS eventos_alerta (
  id SERIAL PRIMARY KEY,
  dispositivo VARCHAR(64) NOT NULL,
  comodo VARCHAR(64) NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  leitura INTEGER NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL,
  notificado BOOLEAN NOT NULL DEFAULT FALSE,
  erro_notificacao TEXT NULL,
  CONSTRAINT ck_eventos_alerta_tipo CHECK (tipo IN ('INICIO_VAZAMENTO', 'LEMBRETE', 'NORMALIZADO'))
);
CREATE INDEX IF NOT EXISTS ix_eventos_alerta_dispositivo_criado_em ON eventos_alerta (dispositivo, criado_em);
`;

const COLUNAS_LEITURA = 'id, dispositivo, comodo, leitura, status, ts_dispositivo, recebido_em';
const COLUNAS_EVENTO = 'id, dispositivo, comodo, tipo, leitura, criado_em, notificado, erro_notificacao';

export function criarPool(url: string, log: Logger): Pool {
  const pool = new Pool({
    connectionString: url,
    max: 5,
    // Sem limites, um banco travado seguraria a fila do MQTT (cada mensagem espera a gravação).
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
  // Sem este handler, a queda de uma conexão ociosa (ex.: restart do Postgres) derruba o processo.
  const logDb = log.child({ logger: 'db' });
  pool.on('error', (erro) => {
    logDb.error({ acao: 'erro_gravacao', erro: descreverErro(erro) }, 'Conexão ociosa com o banco caiu');
  });
  return pool;
}

/** Espera o banco aceitar conexões (no Docker, o postgres pode estar terminando de subir). */
export async function aguardarBanco(pool: Pool, log: Logger, tentativas = 15, intervaloMs = 2_000): Promise<void> {
  const logDb = log.child({ logger: 'db' });
  for (let tentativa = 1; ; tentativa++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (erro) {
      if (tentativa >= tentativas) throw erro;
      logDb.warn({ acao: 'banco_aguardando', erro: descreverErro(erro) }, `Banco indisponível (tentativa ${tentativa}/${tentativas})`);
      await esperar(intervaloMs);
    }
  }
}

export async function criarTabelas(pool: Pool): Promise<void> {
  await pool.query(DDL);
}

export class RepositorioPostgres implements Repositorio {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async gravarLeitura(leitura: NovaLeitura, evento: NovoEvento | null): Promise<{ eventoId: number | null }> {
    const cliente = await this.#pool.connect();
    let conexaoQuebrada: Error | undefined;
    try {
      await cliente.query('BEGIN');
      await cliente.query(
        `INSERT INTO leituras (dispositivo, comodo, leitura, status, ts_dispositivo, recebido_em)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [leitura.dispositivo, leitura.comodo, leitura.leitura, leitura.status, leitura.ts_dispositivo, leitura.recebido_em],
      );
      let eventoId: number | null = null;
      if (evento !== null) {
        // notificado vai explícito: na tabela criada pela versão Python, a coluna não tem DEFAULT.
        const { rows } = await cliente.query<{ id: number }>(
          `INSERT INTO eventos_alerta (dispositivo, comodo, tipo, leitura, criado_em, notificado)
           VALUES ($1, $2, $3, $4, $5, FALSE)
           RETURNING id`,
          [evento.dispositivo, evento.comodo, evento.tipo, evento.leitura, evento.criado_em],
        );
        eventoId = rows[0]?.id ?? null;
      }
      await cliente.query('COMMIT');
      return { eventoId };
    } catch (erro) {
      // Se nem o ROLLBACK funciona, a conexão está quebrada: é descartada em vez de voltar ao pool.
      await cliente.query('ROLLBACK').catch((falha: unknown) => {
        conexaoQuebrada = falha instanceof Error ? falha : new Error(String(falha));
      });
      throw erro;
    } finally {
      cliente.release(conexaoQuebrada);
    }
  }

  async registrarNotificacao(eventoId: number, erro: string | null): Promise<void> {
    await this.#pool.query('UPDATE eventos_alerta SET notificado = $2, erro_notificacao = $3 WHERE id = $1', [
      eventoId,
      erro === null,
      erro,
    ]);
  }

  async ultimosEventos(): Promise<UltimoEvento[]> {
    const { rows } = await this.#pool.query<UltimoEvento>(
      'SELECT DISTINCT ON (dispositivo) dispositivo, tipo, criado_em FROM eventos_alerta ORDER BY dispositivo, id DESC',
    );
    return rows;
  }

  async listarLeituras(filtro: FiltroLeituras): Promise<Leitura[]> {
    const condicoes: string[] = [];
    const valores: unknown[] = [];
    const parametro = (valor: unknown): string => `$${valores.push(valor)}`;
    if (filtro.dispositivo) condicoes.push(`dispositivo = ${parametro(filtro.dispositivo)}`);
    if (filtro.inicio) condicoes.push(`recebido_em >= ${parametro(filtro.inicio)}`);
    if (filtro.fim) condicoes.push(`recebido_em <= ${parametro(filtro.fim)}`);
    const onde = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';
    const { rows } = await this.#pool.query<Leitura>(
      `SELECT ${COLUNAS_LEITURA} FROM leituras ${onde}
       ORDER BY recebido_em DESC, id DESC
       LIMIT ${parametro(filtro.limite)}`,
      valores,
    );
    return rows;
  }

  async ultimasLeituras(): Promise<Leitura[]> {
    const { rows } = await this.#pool.query<Leitura>(
      `SELECT DISTINCT ON (dispositivo) ${COLUNAS_LEITURA} FROM leituras
       ORDER BY dispositivo, recebido_em DESC, id DESC`,
    );
    return rows;
  }

  async listarEventos(filtro: FiltroEventos): Promise<EventoAlerta[]> {
    const valores: unknown[] = [];
    const onde = filtro.dispositivo ? `WHERE dispositivo = $${valores.push(filtro.dispositivo)}` : '';
    const { rows } = await this.#pool.query<EventoAlerta>(
      `SELECT ${COLUNAS_EVENTO} FROM eventos_alerta ${onde}
       ORDER BY criado_em DESC, id DESC
       LIMIT $${valores.push(filtro.limite)}`,
      valores,
    );
    return rows;
  }

  async bancoOk(): Promise<boolean> {
    try {
      await this.#pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
