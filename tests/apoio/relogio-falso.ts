export const INICIO = new Date('2026-09-13T14:00:00Z');

/** Relógio controlado pelo teste: avancar(segundos) simula a passagem do tempo, sem esperar. */
export class RelogioFalso {
  agora: Date;

  constructor(inicio: Date = INICIO) {
    this.agora = new Date(inicio);
  }

  readonly relogio = (): Date => this.agora;

  avancar(segundos: number): Date {
    this.agora = new Date(this.agora.getTime() + segundos * 1000);
    return this.agora;
  }
}

/** INICIO + segundos */
export function em(segundos: number): Date {
  return new Date(INICIO.getTime() + segundos * 1000);
}
