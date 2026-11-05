import type { Logger } from '../log.js';
import { LogNotificador } from './log-notificador.js';
import type { Notificador } from './notificador.js';
import { TelegramNotificador, type OpcoesTelegram } from './telegram-notificador.js';

export { LogNotificador } from './log-notificador.js';
export { formatarMensagem, type EventoNotificacao, type Notificador } from './notificador.js';
export { NaoImplementadoError, TelegramNotificador, type OpcoesTelegram } from './telegram-notificador.js';

/** Escolhe a implementação pela variável NOTIFICADOR (log | telegram). */
export function criarNotificador(nome: string, log: Logger, opcoesTelegram: OpcoesTelegram = {}): Notificador {
  if (nome === 'log') return new LogNotificador(log);
  if (nome === 'telegram') return new TelegramNotificador(opcoesTelegram);
  throw new Error(`NOTIFICADOR desconhecido: "${nome}" (use "log" ou "telegram")`);
}
