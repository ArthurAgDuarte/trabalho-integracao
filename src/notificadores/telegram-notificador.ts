import { formatarMensagem, type EventoNotificacao, type Notificador } from './notificador.js';

export interface OpcoesTelegram {
  /** Padrão: TELEGRAM_BOT_TOKEN do ambiente. */
  token?: string | undefined;
  /** Padrão: TELEGRAM_CHAT_ID do ambiente. */
  chatId?: string | undefined;
  timeoutMs?: number;
}

/** Lançado pelo stub enquanto o envio não for implementado. */
export class NaoImplementadoError extends Error {
  override name = 'NaoImplementadoError';
}

/**
 * Envia o alerta para um chat do Telegram. Ativado com NOTIFICADOR=telegram.
 *
 * STUB: o envio ainda não foi implementado (ver o TODO em notificar).
 */
export class TelegramNotificador implements Notificador {
  readonly chatId: string;
  readonly timeoutMs: number;
  // Privado de verdade (#): o token não aparece se alguém logar ou inspecionar o objeto.
  readonly #token: string;

  constructor(opcoes: OpcoesTelegram = {}) {
    this.#token = opcoes.token ?? process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.chatId = opcoes.chatId ?? process.env.TELEGRAM_CHAT_ID ?? '';
    this.timeoutMs = opcoes.timeoutMs ?? 10_000;
    // Falha no startup, e não na primeira notificação.
    if (this.#token.trim() === '' || this.chatId.trim() === '') {
      throw new Error('NOTIFICADOR=telegram exige TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
    }
  }

  async notificar(evento: EventoNotificacao): Promise<void> {
    const texto = formatarMensagem(evento);

    // TODO(colega das notificações): implementar o envio e remover o throw no fim do método.
    // Sugestão com o fetch nativo do Node (não precisa instalar nada):
    //
    //   let resposta: Response;
    //   try {
    //     resposta = await fetch(`https://api.telegram.org/bot${this.#token}/sendMessage`, {
    //       method: 'POST',
    //       headers: { 'content-type': 'application/json' },
    //       body: JSON.stringify({ chat_id: this.chatId, text: texto }),
    //       // Obrigatório: sem timeout, uma rede travada segura a fila de notificações.
    //       signal: AbortSignal.timeout(this.timeoutMs), // = AbortSignal.timeout(10000) com o padrão de 10 s
    //     });
    //   } catch (erro) {
    //     // NÃO repasse a mensagem nem a causa do erro original: elas podem conter a URL, e a URL
    //     // contém o TOKEN. O texto do erro vai para o log e para eventos_alerta.erro_notificacao.
    //     throw new Error(`Falha ao enviar ao Telegram: ${(erro as Error).name}`);
    //   }
    //   const corpo = (await resposta.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    //   if (!resposta.ok || corpo.ok !== true) {
    //     throw new Error(`Telegram recusou (HTTP ${resposta.status}): ${corpo.description ?? 'sem descrição'}`);
    //   }
    //   return;
    //
    // Regras do contrato: em caso de falha, lance (a promise rejeita); não retorne false e não capture
    // o erro só para logar: o processador já faz isso e grava o erro no banco. Retentativa e cooldown
    // também não são responsabilidade do notificador.
    throw new NaoImplementadoError(`TelegramNotificador ainda não implementado (mensagem: ${JSON.stringify(texto)})`);
  }
}
