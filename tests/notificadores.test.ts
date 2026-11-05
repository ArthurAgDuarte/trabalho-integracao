import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  criarNotificador,
  formatarMensagem,
  LogNotificador,
  NaoImplementadoError,
  TelegramNotificador,
  type EventoNotificacao,
} from '../src/notificadores/index.js';
import { criarLogMemoria } from './apoio/log-memoria.js';

const EVENTO: EventoNotificacao = {
  id: 7,
  dispositivo: 'esp32-cozinha',
  comodo: 'cozinha',
  tipo: 'INICIO_VAZAMENTO',
  leitura: 742,
  criadoEm: new Date('2026-09-13T14:22:07.900Z'),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('formatarMensagem', () => {
  it.each([
    ['INICIO_VAZAMENTO', '🚨 VAZAMENTO DE GÁS detectado em cozinha!'],
    ['LEMBRETE', '⚠️ O vazamento de gás em cozinha continua.'],
    ['NORMALIZADO', '✅ Nível de gás normalizado em cozinha.'],
  ] as const)('%s', (tipo, titulo) => {
    expect(formatarMensagem({ ...EVENTO, tipo })).toBe(
      `${titulo}\nDispositivo: esp32-cozinha\nLeitura: 742\nHorário: 13/09/2026 14:22:07 UTC`,
    );
  });
});

describe('LogNotificador', () => {
  it('só registra a mensagem no log', async () => {
    const { log, comAcao } = criarLogMemoria();
    await new LogNotificador(log).notificar(EVENTO);
    expect(comAcao('notificacao_log')).toMatchObject([
      { nivel: 'INFO', logger: 'notificador', dispositivo: 'esp32-cozinha', tipo: 'INICIO_VAZAMENTO', evento_id: 7, msg: formatarMensagem(EVENTO) },
    ]);
  });
});

describe('TelegramNotificador (stub)', () => {
  it('falha na criação (startup) se faltar o token ou o chat_id', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_CHAT_ID', '');
    expect(() => new TelegramNotificador()).toThrow('TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
    expect(() => new TelegramNotificador({ token: '123:abc' })).toThrow();
    expect(() => new TelegramNotificador({ chatId: '42' })).toThrow();
    expect(() => new TelegramNotificador({ token: '   ', chatId: '42' })).toThrow();
  });

  it('lê TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID do ambiente', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:abc');
    vi.stubEnv('TELEGRAM_CHAT_ID', '42');
    expect(new TelegramNotificador().chatId).toBe('42');
  });

  it('o token não aparece se o objeto for logado ou inspecionado', () => {
    const notificador = new TelegramNotificador({ token: '123:token-secreto', chatId: '42' });
    expect(JSON.stringify(notificador)).not.toContain('token-secreto');
    expect(inspect(notificador, { showHidden: true })).not.toContain('token-secreto');
  });

  it('notificar rejeita com "não implementado", sem o token na mensagem', async () => {
    const notificador = new TelegramNotificador({ token: '123:token-secreto', chatId: '42' });
    const erro = await notificador.notificar(EVENTO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(NaoImplementadoError);
    expect((erro as Error).message).toContain('não implementado');
    expect((erro as Error).message).not.toContain('token-secreto');
  });
});

describe('criarNotificador', () => {
  it('escolhe a implementação pelo NOTIFICADOR', () => {
    const { log } = criarLogMemoria();
    expect(criarNotificador('log', log)).toBeInstanceOf(LogNotificador);
    expect(criarNotificador('telegram', log, { token: '123:abc', chatId: '42' })).toBeInstanceOf(TelegramNotificador);
  });

  it('telegram sem token é erro de configuração', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    expect(() => criarNotificador('telegram', criarLogMemoria().log, { chatId: '42' })).toThrow();
  });

  it('valor desconhecido é erro de configuração', () => {
    expect(() => criarNotificador('email', criarLogMemoria().log)).toThrow('NOTIFICADOR desconhecido: "email"');
  });
});
