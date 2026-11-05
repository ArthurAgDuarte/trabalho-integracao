import type { TipoEvento } from '../alerta.js';
import type { Status } from '../schemas.js';

/** Linha de `leituras`. Os nomes dos campos são os das colunas e os da resposta da API. */
export interface Leitura {
  id: number;
  dispositivo: string;
  comodo: string;
  leitura: number;
  status: Status;
  ts_dispositivo: Date | null;
  recebido_em: Date;
}

/** Linha de `eventos_alerta`. */
export interface EventoAlerta {
  id: number;
  dispositivo: string;
  comodo: string;
  tipo: TipoEvento;
  leitura: number;
  criado_em: Date;
  notificado: boolean;
  erro_notificacao: string | null;
}

export type NovaLeitura = Omit<Leitura, 'id'>;
export type NovoEvento = Pick<EventoAlerta, 'dispositivo' | 'comodo' | 'tipo' | 'leitura' | 'criado_em'>;
export type UltimoEvento = Pick<EventoAlerta, 'dispositivo' | 'tipo' | 'criado_em'>;

export interface FiltroLeituras {
  dispositivo?: string | undefined;
  /** recebido_em >= inicio */
  inicio?: Date | undefined;
  /** recebido_em <= fim */
  fim?: Date | undefined;
  limite: number;
}

export interface FiltroEventos {
  dispositivo?: string | undefined;
  limite: number;
}

/**
 * Acesso ao banco. A API usa a implementação Postgres (db/postgres.ts); os testes usam uma em
 * memória (tests/apoio/repositorio-memoria.ts), então nenhum teste unitário precisa de banco.
 */
export interface Repositorio {
  /** Grava a leitura e, se houver, o evento (notificado=false) numa única transação. */
  gravarLeitura(leitura: NovaLeitura, evento: NovoEvento | null): Promise<{ eventoId: number | null }>;
  /** Resultado do envio: erro null = notificado. */
  registrarNotificacao(eventoId: number, erro: string | null): Promise<void>;
  /** Último evento de cada dispositivo (para reconstruir a máquina de alerta no startup). */
  ultimosEventos(): Promise<UltimoEvento[]>;
  /** Mais recentes primeiro. */
  listarLeituras(filtro: FiltroLeituras): Promise<Leitura[]>;
  /** Última leitura de cada dispositivo, ordenado por dispositivo. */
  ultimasLeituras(): Promise<Leitura[]>;
  /** Mais recentes primeiro. */
  listarEventos(filtro: FiltroEventos): Promise<EventoAlerta[]>;
  /** true se o banco respondeu. */
  bancoOk(): Promise<boolean>;
}
