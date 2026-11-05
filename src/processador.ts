import type { MaquinaAlerta } from './alerta.js';
import type { Repositorio } from './db/repositorio.js';
import { descreverErro, type Logger } from './log.js';
import type { EventoNotificacao, Notificador } from './notificadores/index.js';
import { extrairComodo, textoBruto, validarPayload } from './schemas.js';

export const TAMANHO_MAX_ERRO = 1000;
/** Rede de segurança: um notificador que nunca responde não pode travar a fila para sempre. */
export const TEMPO_MAX_NOTIFICACAO_MS = 30_000;

export type Relogio = () => Date;

export interface DependenciasProcessador {
  repositorio: Repositorio;
  maquina: MaquinaAlerta;
  notificador: Notificador;
  log: Logger;
  /** Horário do servidor (recebido_em). Os testes passam um relógio falso. */
  relogio?: Relogio;
  tempoMaxNotificacaoMs?: number;
}

/**
 * Fluxo de cada mensagem: extrai o cômodo -> valida -> calcula o alerta -> grava a leitura e o
 * evento (uma transação) -> põe a notificação na fila -> registra o resultado do envio.
 */
export class Processador {
  readonly #repositorio: Repositorio;
  readonly #maquina: MaquinaAlerta;
  readonly #notificador: Notificador;
  readonly #log: Logger;
  readonly #relogio: Relogio;
  readonly #tempoMaxNotificacaoMs: number;
  #mensagens: Promise<void> = Promise.resolve();
  #notificacoes: Promise<void> = Promise.resolve();

  constructor(deps: DependenciasProcessador) {
    this.#repositorio = deps.repositorio;
    this.#maquina = deps.maquina;
    this.#notificador = deps.notificador;
    this.#log = deps.log.child({ logger: 'processador' });
    this.#relogio = deps.relogio ?? (() => new Date());
    this.#tempoMaxNotificacaoMs = deps.tempoMaxNotificacaoMs ?? TEMPO_MAX_NOTIFICACAO_MS;
  }

  /**
   * Processa uma mensagem MQTT. Nunca rejeita: qualquer erro vira log. As mensagens são processadas
   * uma de cada vez, na ordem das chamadas, mesmo que quem chama não espere a anterior terminar.
   * A promise resolve quando a leitura foi gravada (ou descartada), sem esperar a notificação.
   */
  processarMensagem(topico: string, bruto: Uint8Array): Promise<void> {
    const vez = this.#mensagens
      .then(() => this.#processar(topico, bruto))
      .catch((erro: unknown) => {
        this.#log.error({ acao: 'erro_processamento', topico, erro: descreverErro(erro) }, 'Erro inesperado ao processar mensagem');
      });
    this.#mensagens = vez;
    return vez;
  }

  /** Espera as mensagens em andamento e esvazia a fila de notificações. */
  async encerrar(): Promise<void> {
    await this.#mensagens;
    let fila: Promise<void>;
    do {
      fila = this.#notificacoes;
      await fila;
    } while (fila !== this.#notificacoes); // entrou notificação nova enquanto esperava
  }

  async #processar(topico: string, bruto: Uint8Array): Promise<void> {
    const recebidoEm = this.#relogio();

    const comodo = extrairComodo(topico);
    if (comodo === null) {
      this.#log.warn({ acao: 'invalido', topico, bruto: textoBruto(bruto) }, 'Tópico fora do formato casa/<comodo>/gas');
      return;
    }

    const validacao = validarPayload(bruto);
    if (!validacao.ok) {
      this.#log.warn(
        { acao: 'invalido', topico, comodo, bruto: textoBruto(bruto), erro: validacao.erros },
        'Payload inválido descartado',
      );
      return;
    }

    const { dispositivo, leitura, status, ts } = validacao.payload;
    const contexto = { dispositivo, comodo, status, leitura };
    this.#log.info({ acao: 'recebido', ...contexto }, 'Leitura recebida');

    const estadoAnterior = this.#maquina.estado(dispositivo);
    const tipo = this.#maquina.processar(dispositivo, status, recebidoEm);

    let eventoId: number | null;
    try {
      ({ eventoId } = await this.#repositorio.gravarLeitura(
        { dispositivo, comodo, leitura, status, ts_dispositivo: ts, recebido_em: recebidoEm },
        tipo === null ? null : { dispositivo, comodo, tipo, leitura, criado_em: recebidoEm },
      ));
    } catch (erro) {
      // A leitura não foi gravada: desfaz a transição para o evento não se perder (a próxima
      // leitura gera o mesmo evento de novo).
      this.#maquina.definirEstado(dispositivo, estadoAnterior);
      this.#log.error({ acao: 'erro_gravacao', erro: descreverErro(erro), ...contexto }, 'Falha ao gravar leitura');
      return;
    }
    this.#log.info({ acao: 'gravado', ...contexto }, 'Leitura gravada');

    if (tipo === null || eventoId === null) return;
    const nivel = tipo === 'NORMALIZADO' ? 'info' : 'warn';
    this.#log[nivel]({ acao: 'alerta_disparado', tipo, evento_id: eventoId, ...contexto }, `Alerta disparado: ${tipo}`);
    this.#enfileirar({ id: eventoId, dispositivo, comodo, tipo, leitura, criadoEm: recebidoEm });
  }

  // Fila sequencial: uma notificação por vez, na ordem, sem segurar o recebimento de leituras.
  #enfileirar(evento: EventoNotificacao): void {
    this.#notificacoes = this.#notificacoes
      .then(() => this.#notificar(evento))
      .catch((erro: unknown) => {
        this.#log.error({ acao: 'erro_processamento', evento_id: evento.id, erro: descreverErro(erro) }, 'Erro inesperado na fila de notificações');
      });
  }

  async #notificar(evento: EventoNotificacao): Promise<void> {
    const contexto = { dispositivo: evento.dispositivo, tipo: evento.tipo, evento_id: evento.id };
    let erro: string | null = null;
    try {
      await comPrazo(this.#notificador.notificar(evento), this.#tempoMaxNotificacaoMs);
      this.#log.info({ acao: 'notificacao_enviada', ...contexto }, 'Notificação enviada');
    } catch (falha) {
      erro = descreverErro(falha).slice(0, TAMANHO_MAX_ERRO);
      this.#log.error({ acao: 'notificacao_falhou', erro, ...contexto }, 'Falha ao notificar');
    }

    try {
      await this.#repositorio.registrarNotificacao(evento.id, erro);
    } catch (falha) {
      this.#log.error(
        { acao: 'erro_gravacao', evento_id: evento.id, erro: descreverErro(falha) },
        'Falha ao registrar o resultado da notificação',
      );
    }
  }
}

/** Carrega o último evento de cada dispositivo na máquina de alerta (startup). */
export async function restaurarEstados(repositorio: Repositorio, maquina: MaquinaAlerta): Promise<number> {
  const eventos = await repositorio.ultimosEventos();
  for (const evento of eventos) maquina.restaurar(evento.dispositivo, evento.tipo, evento.criado_em);
  return eventos.length;
}

async function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(() => {
      const erro = new Error(`o notificador não respondeu em ${ms / 1000} s`);
      erro.name = 'TimeoutError';
      rejeitar(erro);
    }, ms);
  });
  try {
    return await Promise.race([promessa, prazo]);
  } finally {
    clearTimeout(temporizador);
  }
}
