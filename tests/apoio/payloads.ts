/** Payload válido do contrato, como o ESP32 publicaria. */
export function payload(
  status: 'NORMAL' | 'VAZAMENTO' = 'NORMAL',
  leitura = 200,
  dispositivo = 'esp32-cozinha',
  extra: Record<string, unknown> = {},
): Buffer {
  return Buffer.from(JSON.stringify({ dispositivo, leitura, status, ...extra }));
}
