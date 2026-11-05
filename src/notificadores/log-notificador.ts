import type { Logger } from '../log.js';
import { formatarMensagem, type EventoNotificacao, type Notificador } from './notificador.js';

/** Notificador padrão (NOTIFICADOR=log): apenas registra a mensagem no log. */
export class LogNotificador implements Notificador {
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log.child({ logger: 'notificador' });
  }

  async notificar(evento: EventoNotificacao): Promise<void> {
    this.#log.info(
      { acao: 'notificacao_log', dispositivo: evento.dispositivo, tipo: evento.tipo, evento_id: evento.id },
      formatarMensagem(evento),
    );
  }
}
