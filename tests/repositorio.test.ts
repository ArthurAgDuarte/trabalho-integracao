/**
 * Contrato do Repositorio: os mesmos testes rodam contra a implementação em memória (sempre) e
 * contra o Postgres (só com TEST_DATABASE_URL). Assim o repositório em memória dos outros testes
 * não pode divergir do SQL de verdade.
 *
 *   TEST_DATABASE_URL=postgresql://gas:senha@localhost:5432/gas_teste npm test
 *
 * ATENÇÃO: as tabelas do banco de TEST_DATABASE_URL são apagadas. Use um banco descartável.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Pool } from 'pg';

import { criarPool, criarTabelas, RepositorioPostgres } from '../src/db/postgres.js';
import type { NovaLeitura, NovoEvento, Repositorio } from '../src/db/repositorio.js';
import { criarLogMemoria } from './apoio/log-memoria.js';
import { em } from './apoio/relogio-falso.js';
import { RepositorioMemoria } from './apoio/repositorio-memoria.js';

const URL_TESTE = process.env.TEST_DATABASE_URL;

function leitura(segundos: number, dispositivo = 'esp32-cozinha', extra: Partial<NovaLeitura> = {}): NovaLeitura {
  return {
    dispositivo,
    comodo: 'cozinha',
    leitura: 200 + segundos,
    status: 'NORMAL',
    ts_dispositivo: null,
    recebido_em: em(segundos),
    ...extra,
  };
}

function evento(segundos: number, dispositivo = 'esp32-cozinha', tipo: NovoEvento['tipo'] = 'INICIO_VAZAMENTO'): NovoEvento {
  return { dispositivo, comodo: 'cozinha', tipo, leitura: 800, criado_em: em(segundos) };
}

function contrato(nome: string, criar: () => Promise<Repositorio>): void {
  describe(`Repositorio (${nome})`, () => {
    let repo: Repositorio;

    beforeEach(async () => {
      repo = await criar();
    });

    it('grava a leitura sem evento e devolve todas as colunas', async () => {
      expect(await repo.gravarLeitura(leitura(0, 'esp32-cozinha', { ts_dispositivo: em(-5) }), null)).toEqual({ eventoId: null });
      const [gravada] = await repo.listarLeituras({ limite: 10 });
      expect(gravada).toEqual({
        id: expect.any(Number),
        dispositivo: 'esp32-cozinha',
        comodo: 'cozinha',
        leitura: 200,
        status: 'NORMAL',
        ts_dispositivo: em(-5),
        recebido_em: em(0),
      });
    });

    it('grava a leitura com o evento, que começa com notificado=false', async () => {
      const { eventoId } = await repo.gravarLeitura(leitura(0, 'esp32-cozinha', { status: 'VAZAMENTO' }), evento(0));
      expect(eventoId).toEqual(expect.any(Number));
      expect(await repo.listarEventos({ limite: 10 })).toEqual([
        {
          id: eventoId,
          dispositivo: 'esp32-cozinha',
          comodo: 'cozinha',
          tipo: 'INICIO_VAZAMENTO',
          leitura: 800,
          criado_em: em(0),
          notificado: false,
          erro_notificacao: null,
        },
      ]);
    });

    it('leitura e evento são gravados juntos ou nenhum dos dois', async () => {
      await expect(repo.gravarLeitura(leitura(0), { ...evento(0), tipo: 'INVALIDO' as NovoEvento['tipo'] })).rejects.toThrow();
      await expect(repo.gravarLeitura(leitura(0, 'esp32-cozinha', { leitura: 5000 }), null)).rejects.toThrow();
      expect(await repo.listarLeituras({ limite: 10 })).toEqual([]);
      expect(await repo.listarEventos({ limite: 10 })).toEqual([]);
    });

    it('registra o resultado da notificação', async () => {
      const { eventoId: ok } = await repo.gravarLeitura(leitura(0), evento(0));
      const { eventoId: falhou } = await repo.gravarLeitura(leitura(1), evento(1, 'esp32-cozinha', 'NORMALIZADO'));
      await repo.registrarNotificacao(ok!, null);
      await repo.registrarNotificacao(falhou!, 'Error: Telegram fora do ar');
      const eventos = await repo.listarEventos({ limite: 10 });
      expect(eventos.map((e) => [e.id, e.notificado, e.erro_notificacao])).toEqual([
        [falhou, false, 'Error: Telegram fora do ar'],
        [ok, true, null],
      ]);
    });

    it('lista leituras: mais recentes primeiro, com filtros inclusivos e limite', async () => {
      await repo.gravarLeitura(leitura(0, 'esp32-cozinha'), null);
      await repo.gravarLeitura(leitura(10, 'esp32-sala'), null);
      await repo.gravarLeitura(leitura(20, 'esp32-cozinha'), null);
      await repo.gravarLeitura(leitura(20, 'esp32-cozinha', { leitura: 999 }), null); // mesmo horário: o id maior vem antes
      const valores = async (filtro: Parameters<Repositorio['listarLeituras']>[0]) =>
        (await repo.listarLeituras(filtro)).map((l) => l.leitura);

      expect(await valores({ limite: 100 })).toEqual([999, 220, 210, 200]);
      expect(await valores({ dispositivo: 'esp32-sala', limite: 100 })).toEqual([210]);
      expect(await valores({ inicio: em(10), fim: em(20), limite: 100 })).toEqual([999, 220, 210]);
      expect(await valores({ inicio: em(11), limite: 100 })).toEqual([999, 220]);
      expect(await valores({ fim: em(9), limite: 100 })).toEqual([200]);
      expect(await valores({ dispositivo: '', limite: 2 })).toEqual([999, 220]);
    });

    it('última leitura de cada dispositivo, ordenado por dispositivo', async () => {
      await repo.gravarLeitura(leitura(0, 'esp32-sala'), null);
      await repo.gravarLeitura(leitura(5, 'esp32-cozinha'), null);
      await repo.gravarLeitura(leitura(10, 'esp32-sala', { status: 'VAZAMENTO' }), null);
      await repo.gravarLeitura(leitura(15, 'area-servico'), null);
      expect((await repo.ultimasLeituras()).map((l) => [l.dispositivo, l.leitura, l.status])).toEqual([
        ['area-servico', 215, 'NORMAL'],
        ['esp32-cozinha', 205, 'NORMAL'],
        ['esp32-sala', 210, 'VAZAMENTO'],
      ]);
    });

    it('lista eventos: mais recentes primeiro, com filtro e limite', async () => {
      await repo.gravarLeitura(leitura(0), evento(0, 'esp32-cozinha', 'INICIO_VAZAMENTO'));
      await repo.gravarLeitura(leitura(1), evento(1, 'esp32-sala', 'INICIO_VAZAMENTO'));
      await repo.gravarLeitura(leitura(2), evento(2, 'esp32-cozinha', 'NORMALIZADO'));
      const tipos = async (filtro: Parameters<Repositorio['listarEventos']>[0]) =>
        (await repo.listarEventos(filtro)).map((e) => `${e.dispositivo}:${e.tipo}`);

      expect(await tipos({ limite: 100 })).toEqual(['esp32-cozinha:NORMALIZADO', 'esp32-sala:INICIO_VAZAMENTO', 'esp32-cozinha:INICIO_VAZAMENTO']);
      expect(await tipos({ dispositivo: 'esp32-cozinha', limite: 1 })).toEqual(['esp32-cozinha:NORMALIZADO']);
      expect(await tipos({ dispositivo: 'nao-existe', limite: 100 })).toEqual([]);
    });

    it('último evento de cada dispositivo (para restaurar a máquina de alerta)', async () => {
      await repo.gravarLeitura(leitura(0), evento(0, 'esp32-cozinha', 'INICIO_VAZAMENTO'));
      await repo.gravarLeitura(leitura(300), evento(300, 'esp32-cozinha', 'LEMBRETE'));
      await repo.gravarLeitura(leitura(5), evento(5, 'esp32-sala', 'INICIO_VAZAMENTO'));
      await repo.gravarLeitura(leitura(9), evento(9, 'esp32-sala', 'NORMALIZADO'));
      expect(await repo.ultimosEventos()).toEqual([
        { dispositivo: 'esp32-cozinha', tipo: 'LEMBRETE', criado_em: em(300) },
        { dispositivo: 'esp32-sala', tipo: 'NORMALIZADO', criado_em: em(9) },
      ]);
    });

    it('informa que o banco responde', async () => {
      expect(await repo.bancoOk()).toBe(true);
    });
  });
}

contrato('memória', async () => new RepositorioMemoria());

describe.skipIf(URL_TESTE === undefined)('com Postgres (TEST_DATABASE_URL)', () => {
  let pool: Pool | undefined;

  afterAll(async () => {
    await pool?.end();
  });

  contrato('Postgres', async () => {
    pool ??= criarPool(URL_TESTE!, criarLogMemoria().log);
    await pool.query('DROP TABLE IF EXISTS eventos_alerta, leituras');
    await criarTabelas(pool);
    return new RepositorioPostgres(pool);
  });
});
