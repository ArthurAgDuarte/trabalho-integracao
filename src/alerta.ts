/**
 * Máquina de estados do alerta (anti-spam). Pura: sem MQTT, sem banco e sem relógio próprio
 * (o horário `agora` é sempre passado por quem chama, para os testes simularem o tempo).
 *
 * Regras, por dispositivo:
 * - NORMAL -> VAZAMENTO: INICIO_VAZAMENTO
 * - VAZAMENTO contínuo: LEMBRETE só quando já passou o cooldown desde a última notificação
 *   (início ou lembrete); depois de muito tempo sem leituras sai um único lembrete
 * - VAZAMENTO -> NORMAL: NORMALIZADO
 * Dispositivo nunca visto começa como NORMAL.
 */
import type { Status } from './schemas.js';

export const TIPOS_EVENTO = ['INICIO_VAZAMENTO', 'LEMBRETE', 'NORMALIZADO'] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

export interface EstadoDispositivo {
  readonly status: Status;
  /** Horário da última notificação (início ou lembrete); null quando NORMAL. */
  readonly ultimaNotificacao: Date | null;
}

export class MaquinaAlerta {
  readonly #cooldownMs: number;
  readonly #estados = new Map<string, EstadoDispositivo>();

  constructor(cooldownSegundos: number) {
    this.#cooldownMs = cooldownSegundos * 1000;
  }

  /** Atualiza o estado do dispositivo e diz qual evento disparar (ou null). */
  processar(dispositivo: string, status: Status, agora: Date): TipoEvento | null {
    const anterior = this.#estados.get(dispositivo);

    if (status === 'VAZAMENTO') {
      if (anterior?.status !== 'VAZAMENTO') {
        this.#estados.set(dispositivo, { status: 'VAZAMENTO', ultimaNotificacao: agora });
        return 'INICIO_VAZAMENTO';
      }
      const ultima = anterior.ultimaNotificacao;
      if (ultima === null || agora.getTime() - ultima.getTime() >= this.#cooldownMs) {
        this.#estados.set(dispositivo, { status: 'VAZAMENTO', ultimaNotificacao: agora });
        return 'LEMBRETE';
      }
      return null;
    }

    this.#estados.set(dispositivo, { status: 'NORMAL', ultimaNotificacao: null });
    return anterior?.status === 'VAZAMENTO' ? 'NORMALIZADO' : null;
  }

  estado(dispositivo: string): EstadoDispositivo | undefined {
    return this.#estados.get(dispositivo);
  }

  /** Volta a um estado salvo com estado(), ex.: para desfazer a transição se a gravação falhar. */
  definirEstado(dispositivo: string, estado: EstadoDispositivo | undefined): void {
    if (estado === undefined) this.#estados.delete(dispositivo);
    else this.#estados.set(dispositivo, estado);
  }

  /**
   * Reconstrói o estado a partir do último evento gravado (no startup). Sem isso, reiniciar a API
   * no meio de um vazamento dispararia um INICIO_VAZAMENTO duplicado e zeraria o cooldown.
   */
  restaurar(dispositivo: string, ultimoTipo: TipoEvento, criadoEm: Date): void {
    this.#estados.set(
      dispositivo,
      ultimoTipo === 'NORMALIZADO' ? { status: 'NORMAL', ultimaNotificacao: null } : { status: 'VAZAMENTO', ultimaNotificacao: criadoEm },
    );
  }
}
