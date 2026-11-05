import { describe, expect, it } from 'vitest';

import { MaquinaAlerta, type TipoEvento } from '../src/alerta.js';
import { em } from './apoio/relogio-falso.js';

const COOLDOWN = 300;

describe('MaquinaAlerta', () => {
  it('dispositivo desconhecido começa NORMAL: leituras normais não geram evento', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    expect(m.processar('d1', 'NORMAL', em(0))).toBeNull();
    expect(m.processar('d1', 'NORMAL', em(10))).toBeNull();
  });

  it('primeira leitura já em VAZAMENTO é INICIO_VAZAMENTO', () => {
    expect(new MaquinaAlerta(COOLDOWN).processar('d1', 'VAZAMENTO', em(0))).toBe('INICIO_VAZAMENTO');
  });

  it('NORMAL -> VAZAMENTO é INICIO_VAZAMENTO', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    m.processar('d1', 'NORMAL', em(0));
    expect(m.processar('d1', 'VAZAMENTO', em(5))).toBe('INICIO_VAZAMENTO');
  });

  it('sem lembrete em nenhum segundo de 1 a 299, e lembrete exatamente aos 300', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    expect(m.processar('d1', 'VAZAMENTO', em(0))).toBe('INICIO_VAZAMENTO');
    for (let s = 1; s < COOLDOWN; s++) {
      expect(m.processar('d1', 'VAZAMENTO', em(s)), `lembrete antecipado em t=${s}s`).toBeNull();
    }
    expect(m.processar('d1', 'VAZAMENTO', em(COOLDOWN))).toBe('LEMBRETE');
  });

  it('o cooldown conta a partir do último lembrete', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    m.processar('d1', 'VAZAMENTO', em(0));
    expect(m.processar('d1', 'VAZAMENTO', em(310))).toBe('LEMBRETE');
    expect(m.processar('d1', 'VAZAMENTO', em(600))).toBeNull(); // 290 s depois do lembrete
    expect(m.processar('d1', 'VAZAMENTO', em(610))).toBe('LEMBRETE');
  });

  it('depois de um longo período sem leituras sai um único lembrete, não um por período perdido', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    m.processar('d1', 'VAZAMENTO', em(0));
    expect(m.processar('d1', 'VAZAMENTO', em(3600))).toBe('LEMBRETE');
    expect(m.processar('d1', 'VAZAMENTO', em(3601))).toBeNull();
  });

  it('VAZAMENTO -> NORMAL é NORMALIZADO (uma vez só)', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    m.processar('d1', 'VAZAMENTO', em(0));
    expect(m.processar('d1', 'NORMAL', em(30))).toBe('NORMALIZADO');
    expect(m.processar('d1', 'NORMAL', em(31))).toBeNull();
  });

  it('novo vazamento depois de normalizar é um novo INICIO_VAZAMENTO', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    m.processar('d1', 'VAZAMENTO', em(0));
    m.processar('d1', 'NORMAL', em(10));
    expect(m.processar('d1', 'VAZAMENTO', em(20))).toBe('INICIO_VAZAMENTO');
  });

  it('dispositivos são independentes', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    expect(m.processar('cozinha', 'VAZAMENTO', em(0))).toBe('INICIO_VAZAMENTO');
    expect(m.processar('sala', 'NORMAL', em(1))).toBeNull();
    expect(m.processar('sala', 'VAZAMENTO', em(2))).toBe('INICIO_VAZAMENTO');
    expect(m.processar('cozinha', 'NORMAL', em(3))).toBe('NORMALIZADO');
    expect(m.estado('sala')?.status).toBe('VAZAMENTO');
    expect(m.processar('sala', 'VAZAMENTO', em(4))).toBeNull(); // o cooldown da sala é só dela
  });

  it('uma sequência completa', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    const sequencia: Array<[number, 'NORMAL' | 'VAZAMENTO', TipoEvento | null]> = [
      [0, 'NORMAL', null],
      [10, 'VAZAMENTO', 'INICIO_VAZAMENTO'],
      [70, 'VAZAMENTO', null],
      [310, 'VAZAMENTO', 'LEMBRETE'],
      [400, 'VAZAMENTO', null],
      [610, 'VAZAMENTO', 'LEMBRETE'],
      [620, 'NORMAL', 'NORMALIZADO'],
      [700, 'NORMAL', null],
      [710, 'VAZAMENTO', 'INICIO_VAZAMENTO'],
    ];
    expect(sequencia.map(([s, status]) => m.processar('d1', status, em(s)))).toEqual(sequencia.map(([, , esperado]) => esperado));
  });

  it('definirEstado desfaz a transição (ex.: quando a gravação falha)', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    const anterior = m.estado('d1');
    expect(m.processar('d1', 'VAZAMENTO', em(0))).toBe('INICIO_VAZAMENTO');
    m.definirEstado('d1', anterior);
    expect(m.estado('d1')).toBeUndefined();
    expect(m.processar('d1', 'VAZAMENTO', em(1))).toBe('INICIO_VAZAMENTO');

    const antesDoLembrete = m.estado('d1');
    expect(m.processar('d1', 'VAZAMENTO', em(301))).toBe('LEMBRETE');
    m.definirEstado('d1', antesDoLembrete);
    expect(m.processar('d1', 'VAZAMENTO', em(302))).toBe('LEMBRETE');
  });

  it('restaurar um vazamento em andamento não repete o INICIO e mantém o cooldown', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    m.restaurar('d1', 'LEMBRETE', em(0));
    expect(m.processar('d1', 'VAZAMENTO', em(100))).toBeNull();
    expect(m.processar('d1', 'VAZAMENTO', em(300))).toBe('LEMBRETE');

    m.restaurar('d2', 'INICIO_VAZAMENTO', em(0));
    expect(m.processar('d2', 'VAZAMENTO', em(299))).toBeNull();
    expect(m.processar('d2', 'NORMAL', em(320))).toBe('NORMALIZADO');
  });

  it('restaurar NORMALIZADO deixa o dispositivo NORMAL', () => {
    const m = new MaquinaAlerta(COOLDOWN);
    m.restaurar('d1', 'NORMALIZADO', em(0));
    expect(m.estado('d1')).toEqual({ status: 'NORMAL', ultimaNotificacao: null });
    expect(m.processar('d1', 'VAZAMENTO', em(1))).toBe('INICIO_VAZAMENTO');
  });

  it('cooldown 0: todo VAZAMENTO depois do início vira lembrete', () => {
    const m = new MaquinaAlerta(0);
    expect(m.processar('d1', 'VAZAMENTO', em(0))).toBe('INICIO_VAZAMENTO');
    expect(m.processar('d1', 'VAZAMENTO', em(0))).toBe('LEMBRETE');
  });
});
