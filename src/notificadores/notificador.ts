import type { TipoEvento } from '../alerta.js';

/** Dados do evento entregues ao notificador: um objeto simples, sem nada do banco. */
export interface EventoNotificacao {
  readonly id: number;
  readonly dispositivo: string;
  readonly comodo: string;
  readonly tipo: TipoEvento;
  readonly leitura: number;
  readonly criadoEm: Date;
}

export interface Notificador {
  /**
   * Envia a notificação. Em caso de falha, a promise deve REJEITAR (não retorne false nem engula o
   * erro): o processador grava o erro em eventos_alerta.erro_notificacao, e a leitura continua
   * gravada normalmente.
   */
  notificar(evento: EventoNotificacao): Promise<void>;
}

const TITULOS: Record<TipoEvento, (comodo: string) => string> = {
  INICIO_VAZAMENTO: (comodo) => `🚨 VAZAMENTO DE GÁS detectado em ${comodo}!`,
  LEMBRETE: (comodo) => `⚠️ O vazamento de gás em ${comodo} continua.`,
  NORMALIZADO: (comodo) => `✅ Nível de gás normalizado em ${comodo}.`,
};

/**
 * Texto da notificação, igual ao da versão Python:
 *
 *   🚨 VAZAMENTO DE GÁS detectado em cozinha!
 *   Dispositivo: esp32-cozinha
 *   Leitura: 742
 *   Horário: 13/09/2026 14:22:07 UTC
 */
export function formatarMensagem(evento: EventoNotificacao): string {
  return [
    TITULOS[evento.tipo](evento.comodo),
    `Dispositivo: ${evento.dispositivo}`,
    `Leitura: ${evento.leitura}`,
    `Horário: ${formatarHorario(evento.criadoEm)}`,
  ].join('\n');
}

function formatarHorario(data: Date): string {
  const dois = (n: number): string => String(n).padStart(2, '0');
  const dia = `${dois(data.getUTCDate())}/${dois(data.getUTCMonth() + 1)}/${data.getUTCFullYear()}`;
  const hora = `${dois(data.getUTCHours())}:${dois(data.getUTCMinutes())}:${dois(data.getUTCSeconds())}`;
  return `${dia} ${hora} UTC`;
}
