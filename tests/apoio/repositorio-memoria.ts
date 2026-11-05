import { TIPOS_EVENTO } from '../../src/alerta.js';
import type {
  EventoAlerta,
  FiltroEventos,
  FiltroLeituras,
  Leitura,
  NovaLeitura,
  NovoEvento,
  Repositorio,
  UltimoEvento,
} from '../../src/db/repositorio.js';
import { STATUS } from '../../src/schemas.js';

/**
 * Repositório em memória com a mesma semântica do Postgres: as mesmas ordenações, os mesmos CHECKs
 * e gravação tudo-ou-nada da leitura com o evento. A suíte de contrato (repositorio.test.ts) roda
 * contra as duas implementações para garantir isso.
 */
export class RepositorioMemoria implements Repositorio {
  readonly leituras: Leitura[] = [];
  readonly eventos: EventoAlerta[] = [];
  /** true: toda gravação falha, sem gravar nada (simula o banco fora do ar). */
  falharGravacoes = false;
  /** false: bancoOk() responde false. */
  disponivel = true;
  #proximaLeitura = 1;
  #proximoEvento = 1;

  async gravarLeitura(leitura: NovaLeitura, evento: NovoEvento | null): Promise<{ eventoId: number | null }> {
    if (this.falharGravacoes) throw new Error('banco fora do ar (simulado)');
    // Valida tudo antes de gravar qualquer coisa, como a transação do Postgres.
    if (!Number.isInteger(leitura.leitura) || leitura.leitura < 0 || leitura.leitura > 4095) {
      throw new Error('violates check constraint "ck_leituras_leitura"');
    }
    if (!STATUS.includes(leitura.status)) throw new Error('violates check constraint "ck_leituras_status"');
    if (evento !== null && !TIPOS_EVENTO.includes(evento.tipo)) {
      throw new Error('violates check constraint "ck_eventos_alerta_tipo"');
    }

    this.leituras.push({ id: this.#proximaLeitura++, ...leitura });
    if (evento === null) return { eventoId: null };
    const id = this.#proximoEvento++;
    this.eventos.push({ id, ...evento, notificado: false, erro_notificacao: null });
    return { eventoId: id };
  }

  async registrarNotificacao(eventoId: number, erro: string | null): Promise<void> {
    if (this.falharGravacoes) throw new Error('banco fora do ar (simulado)');
    const evento = this.eventos.find((e) => e.id === eventoId);
    if (evento !== undefined) {
      evento.notificado = erro === null;
      evento.erro_notificacao = erro;
    }
  }

  async ultimosEventos(): Promise<UltimoEvento[]> {
    const ultimos = new Map<string, EventoAlerta>();
    for (const evento of [...this.eventos].sort((a, b) => a.id - b.id)) ultimos.set(evento.dispositivo, evento);
    return [...ultimos.values()]
      .sort((a, b) => comparar(a.dispositivo, b.dispositivo))
      .map(({ dispositivo, tipo, criado_em }) => ({ dispositivo, tipo, criado_em }));
  }

  async listarLeituras(filtro: FiltroLeituras): Promise<Leitura[]> {
    return this.leituras
      .filter(
        (l) =>
          (!filtro.dispositivo || l.dispositivo === filtro.dispositivo) &&
          (!filtro.inicio || l.recebido_em >= filtro.inicio) &&
          (!filtro.fim || l.recebido_em <= filtro.fim),
      )
      .sort(maisRecentePrimeiro((l) => l.recebido_em))
      .slice(0, filtro.limite)
      .map((l) => ({ ...l }));
  }

  async ultimasLeituras(): Promise<Leitura[]> {
    const ultimas = new Map<string, Leitura>();
    for (const leitura of [...this.leituras].sort(maisRecentePrimeiro((l) => l.recebido_em))) {
      if (!ultimas.has(leitura.dispositivo)) ultimas.set(leitura.dispositivo, leitura);
    }
    return [...ultimas.values()].sort((a, b) => comparar(a.dispositivo, b.dispositivo)).map((l) => ({ ...l }));
  }

  async listarEventos(filtro: FiltroEventos): Promise<EventoAlerta[]> {
    return this.eventos
      .filter((e) => !filtro.dispositivo || e.dispositivo === filtro.dispositivo)
      .sort(maisRecentePrimeiro((e) => e.criado_em))
      .slice(0, filtro.limite)
      .map((e) => ({ ...e }));
  }

  async bancoOk(): Promise<boolean> {
    return this.disponivel;
  }
}

/** ORDER BY <data> DESC, id DESC */
function maisRecentePrimeiro<T extends { id: number }>(data: (item: T) => Date) {
  return (a: T, b: T): number => data(b).getTime() - data(a).getTime() || b.id - a.id;
}

function comparar(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
