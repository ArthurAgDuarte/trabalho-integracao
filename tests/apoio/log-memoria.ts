import { criarLogger, type Logger } from '../../src/log.js';

export interface LinhaLog {
  nivel: string;
  ts: string;
  msg: string;
  acao?: string;
  [campo: string]: unknown;
}

/** Logger igual ao da API, mas que guarda as linhas (já interpretadas) em vez de escrever no stdout. */
export function criarLogMemoria(): { log: Logger; linhas: LinhaLog[]; comAcao: (acao: string) => LinhaLog[] } {
  const linhas: LinhaLog[] = [];
  const log = criarLogger('DEBUG', {
    write(linha: string) {
      linhas.push(JSON.parse(linha) as LinhaLog);
    },
  });
  return { log, linhas, comAcao: (acao) => linhas.filter((linha) => linha.acao === acao) };
}
